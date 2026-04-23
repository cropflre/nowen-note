/**
 * 附件管理路由（/api/attachments）
 * ---------------------------------------------------------------------------
 * 背景：
 *   历史上「粘贴/插入图片」走 Tiptap Image + base64 data URI，图片字节内联
 *   到 notes.content 里随笔记一起存。一张手机截图就能让单条 note.content
 *   膨胀到几 MB，GET /api/notes/:id 把整个 blob 当 TEXT 拖回前端，前端还得
 *   全量 rerender、生成 FTS、走乐观锁；规模一大体验就崩。
 *
 *   本路由把图片落盘，notes.content 里只保留 `/api/attachments/<id>` 的
 *   URL。attachments 表之前已经建好，只差路由。
 *
 * 模块导出：
 *   - attachmentsAuthRouter：挂在 /api/attachments，受 JWT 中间件保护。
 *     承接 POST（上传）/ DELETE。
 *   - handleDownloadAttachment：显式挂在 JWT 中间件**之前**的下载 handler。
 *     背景：<img src="/api/attachments/<id>"> 浏览器原生请求不会自动带
 *     Authorization header；若走 JWT 会 401。因此下载接口不依赖 JWT，而是
 *     根据 "附件挂载的 noteId" 判断：
 *       1) 个人空间的 note：仅 owner 可 read → 需要 X-User-Id（同源 cookie
 *          会话拿不到，所以下载接口也无法看到 userId）……为了让 <img> 能
 *          正常显示，我们接受"同源登录态 + 猜不到的 uuid"作为隐式授权：
 *          附件 id 是 uuid，除了读过 note.content 拿到 URL 的人之外没人能
 *          枚举。理论上安全（与 Gitea / GitLab 等把私有仓库附件按不可枚举
 *          id 发到任意登录用户的做法一致）。
 *       2) 如果当前笔记已设置分享链接，在分享页的 <img> 也能直接请求到。
 *     这是权衡后的妥协：
 *       - 若要严格按 read 权限卡附件，需要改造前端把图片下载全部走 fetch
 *         + Authorization + blob URL，代价是每切笔记都要重新拉二进制、
 *         不能用浏览器图片缓存；
 *       - 当前方案可以直接享受浏览器缓存（Cache-Control: immutable）。
 *     如果要升级安全性，未来改成 "签名 URL（含 exp + hmac）" 最平滑。
 *
 * 协作 / 分享边界：
 *   - 工作区笔记的附件访问默认也通过"id 不可枚举"保护；由于附件行里
 *     记录了 noteId + userId，后续需要审计哪位用户上传的附件也可追溯。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import { resolveNotePermission, hasPermission } from "../middleware/acl";

const ATTACHMENTS_DIR = path.join(
  process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"),
  "attachments",
);

/** 确保目录存在。上传 / 迁移脚本都复用它。 */
export function ensureAttachmentsDir(): string {
  if (!fs.existsSync(ATTACHMENTS_DIR)) {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }
  return ATTACHMENTS_DIR;
}

export function getAttachmentsDir(): string {
  return ATTACHMENTS_DIR;
}

// 允许的图片 MIME（与 Tiptap Image 默认支持对齐；svg 允许但要注意 XSS）
const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

export const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

// 单个附件最大 50MB。反向代理侧还会再设 body limit。
const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024;

/**
 * 不需要 JWT 的下载 handler。index.ts 直接把它挂在 JWT 中间件**之前**。
 *
 * 授权模型详见文件顶部注释：
 *   - 通过 id 不可枚举（uuid）保护；
 *   - 不调用 resolveNotePermission（因为拿不到 userId）；
 *   - 未来升级为签名 URL 时，在这里校验签名即可。
 */
export function handleDownloadAttachment(c: Context): Response {
  const id = c.req.param("id");
  const db = getDb();
  const row = db
    .prepare("SELECT id, mimeType, path FROM attachments WHERE id = ?")
    .get(id) as { id: string; mimeType: string; path: string } | undefined;
  if (!row) return c.json({ error: "附件不存在" }, 404);

  const absPath = path.join(ATTACHMENTS_DIR, row.path);
  if (!fs.existsSync(absPath)) {
    return c.json({ error: "附件文件丢失" }, 404);
  }

  const buffer = fs.readFileSync(absPath);
  return new Response(buffer, {
    headers: {
      "Content-Type": row.mimeType || "application/octet-stream",
      // uuid 文件名不可变，可以长缓存
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ============================================================================
// 下面的路由挂在 JWT 中间件之后（见 index.ts）：上传 / 删除
// ============================================================================
const app = new Hono();

/**
 * 上传附件。
 *
 * 请求：
 *   POST /api/attachments
 *   multipart/form-data：
 *     file:   File
 *     noteId: string  // 必传，用于 ACL 校验 + 外键
 *
 * 响应：
 *   { id, url, mimeType, size, filename }
 *   url = `/api/attachments/<id>`，前端直接写到 <img src>。
 *
 * 权限：需要对 noteId 所指笔记拥有 `write` 权限（上传即修改笔记内容）。
 */
app.post("/", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const db = getDb();

  let body: Record<string, any>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "invalid multipart body" }, 400);
  }

  const file = body.file;
  const noteId = typeof body.noteId === "string" ? body.noteId : "";

  if (!(file instanceof File)) {
    return c.json({ error: "file 字段缺失或非文件" }, 400);
  }
  if (!noteId) {
    return c.json({ error: "noteId 必传" }, 400);
  }

  // ACL：必须对目标笔记有 write 权限
  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "无权向该笔记上传附件", code: "FORBIDDEN" }, 403);
  }

  // 大小 / MIME 校验
  if (file.size > MAX_ATTACHMENT_SIZE) {
    return c.json(
      { error: `文件过大（最大 ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB）` },
      413,
    );
  }
  const mime = (file.type || "application/octet-stream").toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.has(mime)) {
    return c.json({ error: `不支持的 MIME 类型: ${mime}` }, 415);
  }

  // 落盘
  ensureAttachmentsDir();
  const id = uuid();
  const ext = MIME_TO_EXT[mime] || "bin";
  const savePath = path.join(ATTACHMENTS_DIR, `${id}.${ext}`);

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(savePath, buffer);
  } catch (err: any) {
    return c.json({ error: `写入文件失败: ${err?.message || err}` }, 500);
  }

  // 写 DB。attachments.path 存**文件名**（相对 ATTACHMENTS_DIR）而非绝对路径，
  // 换部署环境只需搬目录。
  try {
    db.prepare(
      `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, noteId, userId, file.name || `${id}.${ext}`, mime, file.size, `${id}.${ext}`);
  } catch (err: any) {
    // DB 写失败时把已落盘文件清掉，避免孤儿
    try { fs.unlinkSync(savePath); } catch { /* ignore */ }
    return c.json({ error: `写入数据库失败: ${err?.message || err}` }, 500);
  }

  return c.json(
    {
      id,
      url: `/api/attachments/${id}`,
      mimeType: mime,
      size: file.size,
      filename: file.name || `${id}.${ext}`,
    },
    201,
  );
});

/**
 * 删除附件。一般不直接由前端调用（清理靠笔记删除级联 + 定期扫描孤儿）。
 * 保留作为管理端点：笔记 owner 可以删自己的附件。
 */
app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const row = db
    .prepare("SELECT id, noteId, path FROM attachments WHERE id = ?")
    .get(id) as { id: string; noteId: string; path: string } | undefined;
  if (!row) return c.json({ error: "附件不存在" }, 404);

  const { permission } = resolveNotePermission(row.noteId, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "无权删除该附件", code: "FORBIDDEN" }, 403);
  }

  const absPath = path.join(ATTACHMENTS_DIR, row.path);
  try {
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
  } catch {
    /* 文件删不掉不阻塞，DB 记录仍然要清掉 */
  }
  db.prepare("DELETE FROM attachments WHERE id = ?").run(id);

  return c.json({ success: true });
});

// ============================================================================
// 通用工具：把 notes.content 里内联的 base64 图片抽出来落盘 + 写 attachments 行
// 供两处复用：
//   1) /api/export/import（Step 5：导入链路改造）—— 新建笔记同事务内调用
//   2) scripts/migrate-inline-images-to-attachments.ts（Step 6：一次性迁移）
// ============================================================================

// data URI 匹配：data:image/<sub>;base64,<payload>
// 宽容匹配 quote（单/双引号）与属性顺序。只抓 <img src="data:..."> 形式，
// 不去碰 CSS background-image 之类的偏门用法（Tiptap 正文里几乎不出现）。
//
// 为什么不用 DOM 解析：
//   - 后端没有浏览器 DOM，引入 jsdom 会拖包体；
//   - notes.content 99% 情况是序列化的 Tiptap JSON（JSON.stringify 后的字符串），
//     同一份字符串同时承载 HTML 形式和 JSON 形式里的 src 属性值；
//   - 用正则替换只操作 src 的值部分，对 JSON / HTML 都安全。
const INLINE_IMG_BASE64_RE = /(["'])data:(image\/[a-z0-9.+\-]+);base64,([A-Za-z0-9+/=]+)\1/gi;

export interface InlineImageExtractResult {
  /** 替换后的 content（data URI 已被换成 /api/attachments/<id>） */
  content: string;
  /** 本次创建的附件 id 列表；方便调用方记录 / 回滚 */
  attachmentIds: string[];
  /** 被替换掉的 data URI 数量（==attachmentIds.length；分开列出便于日志） */
  replacedCount: number;
}

/**
 * 扫描 content 字符串里的内联 data:image base64，把每一张图落盘 +
 * 写 attachments 行，并把 content 里的 data URI 替换为 `/api/attachments/<id>`。
 *
 * 调用方负责保证 noteId 在 notes 表中已存在（attachments 外键要求）。
 * 本函数**不**开事务；调用方在自己的事务里调用即可。
 *
 * 失败策略：单张图解码失败时**保留原 data URI**（不中断整批），并在返回结果里
 * 通过 replacedCount 反映真实写入数。
 */
export function extractInlineBase64Images(
  content: string,
  userId: string,
  noteId: string,
): InlineImageExtractResult {
  if (!content || typeof content !== "string") {
    return { content: content || "", attachmentIds: [], replacedCount: 0 };
  }
  // 快速预检：没有 "data:image" 字样直接返回，零分配。
  if (content.indexOf("data:image") < 0) {
    return { content, attachmentIds: [], replacedCount: 0 };
  }

  ensureAttachmentsDir();
  const db = getDb();
  const insertStmt = db.prepare(
    `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const attachmentIds: string[] = [];
  let replacedCount = 0;

  const newContent = content.replace(
    INLINE_IMG_BASE64_RE,
    (_match, quote: string, mime: string, base64: string) => {
      const mimeLower = mime.toLowerCase();
      if (!ALLOWED_IMAGE_MIMES.has(mimeLower)) {
        return _match; // 不支持的 MIME，保持原样
      }
      let buffer: Buffer;
      try {
        buffer = Buffer.from(base64, "base64");
      } catch {
        return _match;
      }
      if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_SIZE) {
        return _match;
      }

      const id = uuid();
      const ext = MIME_TO_EXT[mimeLower] || "bin";
      const filename = `${id}.${ext}`;
      const savePath = path.join(ATTACHMENTS_DIR, filename);

      try {
        fs.writeFileSync(savePath, buffer);
      } catch {
        return _match;
      }
      try {
        insertStmt.run(id, noteId, userId, filename, mimeLower, buffer.length, filename);
      } catch {
        // DB 写失败 → 清掉磁盘文件，保留原 data URI
        try { fs.unlinkSync(savePath); } catch { /* ignore */ }
        return _match;
      }

      attachmentIds.push(id);
      replacedCount++;
      // 用同款 quote 包住替换值，避免破坏外层 JSON / HTML 的引号平衡
      return `${quote}/api/attachments/${id}${quote}`;
    },
  );

  return { content: newContent, attachmentIds, replacedCount };
}

export default app;
