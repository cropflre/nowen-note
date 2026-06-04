/**
 * 附件管理路由（/api/attachments）
 * ---------------------------------------------------------------------------
 * 背景：
 *   历史上「粘贴/插入图片」走 Tiptap Image + base64 data URI，图片字节内联
 *   到 notes.content 里随笔记一起存。一张手机截图就能让单条 note.content
 *   膨胀到几 MB，GET /api/notes/:id 把整个 blob 当 TEXT 拖回前端，前端还得
 *   全量 rerender、生成 FTS、走乐观锁；规模一大体验就崩。
 *
 *   本路由把**任意类型**的附件落盘，notes.content 里只保留
 *   `/api/attachments/<id>` 的 URL：
 *     - 图片（image/*）仍然以 <img> 内联渲染；
 *     - 其它格式（pdf / docx / zip / 音视频 / 任意二进制）以附件链接形式
 *       插入编辑器，点击下载（后端带 Content-Disposition: attachment）。
 *   设计目标是「不限制格式」，因此只用一个很小的黑名单拒绝高危可执行类型，
 *   其它任意 MIME 一律放行。
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
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { resolveNotePermission, hasPermission } from "../middleware/acl";
import { enqueueAttachment } from "../services/embedding-worker";
import { verifySudoFromRequest } from "../lib/auth-security";
import { extractAttachmentIdsFromContent, syncReferences } from "../lib/attachmentRefs";
import {
  parseThumbnailWidth,
  getOrCreateThumbnailAsync,
  isThumbnailable,
  deleteThumbnailsFor,
} from "../services/thumbnails";

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

/**
 * 按 noteId 批量删除磁盘物理附件文件（不动 DB）。
 * ---------------------------------------------------------------------------
 * 背景：
 *   attachments 表虽然与 notes 外键 ON DELETE CASCADE，但 SQLite 只会删 **行**，
 *   磁盘上的 `data/attachments/<id>.<ext>` 不会被清理，长期使用会积累大量孤儿文件，
 *   导致清空回收站后"占用的存储不会变小"。
 *
 * 调用场景：
 *   - 永久删除笔记（DELETE /api/notes/:id）
 *   - 清空回收站（DELETE /api/notes/trash/empty）
 *
 * 时序：**必须在 DB 删除笔记之前调用**——删除后 attachments 行就 CASCADE 没了，
 *   就再也查不到 path。
 *
 * v1.1.7 引用计数兜底（修复 1.1.6 数据丢失事故）：
 *   hash 去重 / 迁移路径下，多条 attachments 行可能共享同一个磁盘 path。
 *   1.1.6 这里直接 unlink，会把"还活着的笔记"引用的物理文件也删掉，
 *   导致另一份笔记里的图片变 404。
 *   修复：unlink 前先看"是否还有不在本次删除范围内的 attachments 行也指向同一 path"。
 *   有就只让 DB CASCADE 处理行级删除，物理文件保留；
 *   没有任何活引用时才允许 unlink。
 *   与 `app.delete("/:id")` 单条删除 (line ~497) 的策略对齐。
 *
 * 返回：真正 unlink 成功的文件数（日志 / 审计用）。
 */
export function deleteAttachmentFilesByNoteIds(noteIds: string[]): number {
  if (!noteIds || noteIds.length === 0) return 0;
  const db = getDb();
  const placeholders = noteIds.map(() => "?").join(",");
  let rows: { id: string; path: string }[] = [];
  try {
    rows = db
      .prepare(`SELECT id, path FROM attachments WHERE noteId IN (${placeholders})`)
      .all(...noteIds) as { id: string; path: string }[];
  } catch {
    return 0;
  }
  if (rows.length === 0) return 0;

  // 引用计数：哪些 path 在"待死名单"以外还有活引用？这些 path 的物理文件不能删。
  const dyingIds = rows.map((r) => r.id).filter(Boolean);
  const dyingPaths = Array.from(new Set(rows.map((r) => r.path).filter(Boolean)));
  const livePaths = new Set<string>();
  if (dyingIds.length > 0 && dyingPaths.length > 0) {
    try {
      const idPh = dyingIds.map(() => "?").join(",");
      const pathPh = dyingPaths.map(() => "?").join(",");
      const liveRows = db
        .prepare(
          `SELECT DISTINCT path FROM attachments
           WHERE path IN (${pathPh}) AND id NOT IN (${idPh})`,
        )
        .all(...dyingPaths, ...dyingIds) as { path: string }[];
      for (const lr of liveRows) {
        if (lr?.path) livePaths.add(lr.path);
      }
    } catch {
      // 查询失败时保守处理：把所有 dying 的 path 都视作"还有活引用"，
      // 宁可暂时残留孤儿文件（可被定期 reclaim 清理），也不要错删。
      for (const p of dyingPaths) livePaths.add(p);
    }
  }

  let removed = 0;
  for (const r of rows) {
    if (!r?.path) continue;
    if (livePaths.has(r.path)) {
      // 还有其它笔记引用这个物理文件 → 只让 DB 行被 CASCADE 删，文件保留。
      // 但当前附件 id 对应的缩略图缓存已经不可再访问，可以安全清掉。
      if (r.id) deleteThumbnailsFor(ATTACHMENTS_DIR, r.id);
      continue;
    }
    const abs = path.join(ATTACHMENTS_DIR, r.path);
    try {
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        removed++;
      }
    } catch {
      /* 单个失败不阻塞批量 */
    }
    // v12：顺手清理对应的缩略图缓存（best-effort）。
    // 阶段 B 后 attachments.id 可能与 path basename 不同（多行共享同一物理文件），
    // 因此两个 key 都尝试清理：当前元数据 id + 物理文件 basename。
    if (r.id) deleteThumbnailsFor(ATTACHMENTS_DIR, r.id);
    const baseName = (r.path || "").replace(/\.[^.]+$/, "");
    if (baseName && baseName !== r.id) deleteThumbnailsFor(ATTACHMENTS_DIR, baseName);
  }
  return removed;
}

// 允许的图片 MIME（用于「是否作为 <img> 内联展示」的判定；非图片走附件链接）
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
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/aac": "aac",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mp4": "m4a",
};

// 判断附件是否属于「图片」——供 handleDownloadAttachment / 响应 category 字段共用。
function isImageMime(mime: string): boolean {
  return ALLOWED_IMAGE_MIMES.has((mime || "").toLowerCase());
}

/**
 * 黑名单：出于安全考虑拒绝上传的高危可执行文件类型。
 *
 * 背景：需求是「不限制格式」，因此不再维护白名单；但下列 MIME 一旦被浏览器
 * 识别为类型直接打开/执行仍然有风险。显式黑掉，其它任意类型放行。
 */
const BLOCKED_MIMES = new Set([
  "application/x-msdownload",        // .exe / .dll
  "application/x-ms-installer",      // .msi
  "application/x-ms-shortcut",       // .lnk
  "application/x-bat",               // .bat
  "application/x-sh",                // .sh
  "application/hta",                 // .hta
]);

// 从文件名兜底推断扩展名（file.name 为空或无点时用 MIME 映射，再兜底 "bin"）。
function pickExt(filename: string | undefined, mime: string): string {
  const name = filename || "";
  const idx = name.lastIndexOf(".");
  if (idx >= 0 && idx < name.length - 1) {
    const ext = name.slice(idx + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ext && ext.length <= 8) return ext;
  }
  return MIME_TO_EXT[mime.toLowerCase()] || "bin";
}

// 为响应头构造一个安全的 filename* 值（RFC 5987），避免中文/空格被截断或破坏。
function encodeContentDispositionFilename(name: string): string {
  const safe = (name || "attachment").replace(/[\r\n"]/g, "_");
  return `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * Buffer → 响应体兼容包装。
 *
 * 背景（TS 5.7+ + @types/node 22 的类型鸿沟）：
 *   - Node `Buffer` 的类型签名在 @types/node 22 / TS 5.7 之后变成
 *     `Buffer<ArrayBufferLike>`，underlying buffer 可能是 `SharedArrayBuffer`。
 *   - 而浏览器 `lib.dom.d.ts` 的 `BodyInit` / `BlobPart`、Hono 的 `Data`
 *     全都要求 `Uint8Array<ArrayBuffer>`（裸 `ArrayBuffer`，非 `Like`）。
 *   - 直接把 Buffer 喂给 `new Response()` / `new Blob([buf])` / `c.body(buf)`
 *     都会被 TS 拒绝（TS2345 / TS2322 / TS2769）。
 *
 * 解法：
 *   通过 `new Uint8Array(buf)` 拷贝构造一个**确定 underlying ArrayBuffer**
 *   的视图。这是真拷贝（O(n)），但响应路径每个请求只走一次，相比磁盘 I/O
 *   或 sharp 解码可以忽略；换来的是类型层面 100% 干净、运行期完全正确。
 *
 *   想零拷贝也可以用 `as unknown as Uint8Array<ArrayBuffer>` 强转，但显式
 *   类型断言会绕过 TS 的有效检查；这里选择"显式拷贝 + 真实类型"。
 */
function toResponseBody(buf: Buffer): Uint8Array<ArrayBuffer> {
  // Uint8Array 构造函数接受 ArrayBufferView 时会拷贝字节并新建 ArrayBuffer，
  // 返回类型在新版 lib 里精确为 Uint8Array<ArrayBuffer>，正中 BodyInit 联合。
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out as Uint8Array<ArrayBuffer>;
}

// 单个附件最大 200MB。反向代理侧还会再设 body limit。
// 之前是 50MB（按"图片"设计），放开到任意格式后上调一档，方便传 PDF / 安装包零件 / 压缩包。
const MAX_ATTACHMENT_SIZE = 200 * 1024 * 1024;

export interface ExistingAttachmentForDedup {
  id?: string;
  path: string;
  filename?: string;
  mimeType: string;
  size: number;
  hash?: string | null;
}

export interface DeduplicatedAttachmentRow {
  id: string;
  url: string;
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * 阶段 B：hash 命中时不再直接复用旧附件 id，而是复制一行新的附件元数据。
 *
 * 背景：迁移 / 导入 / 粘贴去重命中后，如果正文继续引用旧 id，新笔记并没有自己的
 * attachments 行。后续按 noteId 清理、回滚或引用分析时都会失真。
 *
 * 策略：
 *   - 物理文件仍复用 source.path，不额外写盘；
 *   - 新建 attachments.id，并绑定到当前 noteId；
 *   - 删除时依赖 path 引用计数兜底，最后一个引用消失才 unlink。
 */
export function createDeduplicatedAttachmentRow(args: {
  source: ExistingAttachmentForDedup;
  noteId: string;
  userId: string;
  workspaceId: string | null;
  filename?: string;
  hash?: string | null;
  uploadSource?: string | null;
}): DeduplicatedAttachmentRow {
  const db = getDb();
  const id = uuid();
  const filename = args.filename || args.source.filename || args.source.path || `${id}.bin`;
  const hash = args.hash ?? args.source.hash ?? null;

  if (args.uploadSource !== undefined) {
    db.prepare(
      `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash, uploadSource)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      args.noteId,
      args.userId,
      filename,
      args.source.mimeType,
      args.source.size,
      args.source.path,
      args.workspaceId,
      hash,
      args.uploadSource,
    );
  } else {
    db.prepare(
      `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      args.noteId,
      args.userId,
      filename,
      args.source.mimeType,
      args.source.size,
      args.source.path,
      args.workspaceId,
      hash,
    );
  }

  return {
    id,
    url: `/api/attachments/${id}`,
    path: args.source.path,
    filename,
    mimeType: args.source.mimeType,
    size: args.source.size,
  };
}

/**
 * 不需要 JWT 的下载 handler。index.ts 直接把它挂在 JWT 中间件**之前**。
 *
 * 授权模型详见文件顶部注释：
 *   - 通过 id 不可枚举（uuid）保护；
 *   - 不调用 resolveNotePermission（因为拿不到 userId）；
 *   - 未来升级为签名 URL 时，在这里校验签名即可。
 *
 * v12 新增：缩略图分支
 *   支持 `?w=240|480|960` 查询参数，命中白名单且原图为 raster 时返回 webp 缩略图。
 *   - 不命中白名单 / 非 raster / sharp 不可用 → 透明降级为原图（不报错）。
 *   - 缩略图与原图共用同一份 immutable Cache-Control，浏览器二次访问无网络。
 *   - handler 改为 async：sharp 是异步管道。
 */
export async function handleDownloadAttachment(c: Context): Promise<Response> {
  // 可选的 Referer 校验（环境变量 ATTACHMENT_REFERER_CHECK=1 时开启）
  // 仅校验公网部署场景，内网家庭使用不需要。
  if (process.env.ATTACHMENT_REFERER_CHECK === "1") {
    const referer = c.req.header("Referer") || "";
    const host = c.req.header("Host") || "";
    if (referer && !referer.includes(host) && !referer.includes("localhost")) {
      return c.json({ error: "拒绝访问：来源不合法" }, 403);
    }
  }

  const id = c.req.param("id");
  const db = getDb();
  const row = db
    .prepare("SELECT id, mimeType, path, filename FROM attachments WHERE id = ?")
    .get(id) as { id: string; mimeType: string; path: string; filename: string } | undefined;
  if (!row) return c.json({ error: "附件不存在" }, 404);

  const absPath = path.join(ATTACHMENTS_DIR, row.path);
  if (!fs.existsSync(absPath)) {
    return c.json({ error: "附件文件丢失" }, 404);
  }

  const forceDownload = c.req.query("download") === "1";
  // ?inline=1 —— 显式声明"用于浏览器内联预览（如 <video>/<audio>/<iframe>）"。
  // 对于非图片附件，此参数会跳过 Content-Disposition: attachment，让浏览器直接渲染
  // 而不是触发下载。和 forceDownload 互斥（forceDownload 优先级更高，因为是用户明示）。
  // 注意：authorization 模型不变（uuid 不可枚举），inline 不会扩大攻击面——HTML/SVG 等
  // 高危类型由前端预览组件自行 sanitize 处理。
  const inlinePreview = c.req.query("inline") === "1";
  const requestedWidth = parseThumbnailWidth(c.req.query("w"));

  // 缩略图分支：仅在
  //   1) 请求带合法 ?w=
  //   2) 不是 ?download=1（下载场景必须给原文件）
  //   3) 原图是可缩略的 raster 图片
  // 三者同时满足时尝试。任何一步失败就回退到原图。
  if (requestedWidth && !forceDownload && isThumbnailable(row.mimeType)) {
    const thumb = await getOrCreateThumbnailAsync(
      ATTACHMENTS_DIR,
      row.id,
      absPath,
      row.mimeType,
      requestedWidth,
    );
    if (thumb) {
      return c.body(toResponseBody(thumb.buffer), 200, {
        "Content-Type": thumb.mimeType,
        // 缩略图与原图一样 immutable（webp 内容由 (id, w) 唯一决定）
        "Cache-Control": "public, max-age=31536000, immutable",
        // 让前端 / 代理可以观察到这张响应是缩略图
        "X-Thumbnail-Width": String(requestedWidth),
      });
    }
    // thumb 为 null（sharp 失败 / 不可用）→ fall through 返回原图
  }

  const buffer = fs.readFileSync(absPath);
  const headers: Record<string, string> = {
    "Content-Type": row.mimeType || "application/octet-stream",
    // uuid 文件名不可变，可以长缓存
    "Cache-Control": "public, max-age=31536000, immutable",
  };
  // 非图片（或显式 ?download=1）：带 Content-Disposition，浏览器点击会按原名下载。
  // 图片默认 inline，由 <img> 直接渲染。
  // 例外：?inline=1 用于前端预览组件（<video>/<audio>/svg 等），跳过 Content-Disposition，
  //       让浏览器直接渲染。?download=1 优先级更高（用户明示要下载）。
  if ((!isImageMime(row.mimeType) || forceDownload) && !(inlinePreview && !forceDownload)) {
    headers["Content-Disposition"] = encodeContentDispositionFilename(row.filename || "");
  }
  // 同上：Buffer → Uint8Array<ArrayBuffer> 视图，绕开 TS 5.7+ ArrayBufferLike 不兼容
  return c.body(toResponseBody(buffer), 200, headers);
}

// ============================================================================
// 下面的路由挂在 JWT 中间件之后（见 index.ts）：上传 / 删除
// ============================================================================
const app = new Hono();

/**
 * 上传附件（任意格式）。
 *
 * 请求：
 *   POST /api/attachments
 *   multipart/form-data：
 *     file:   File
 *     noteId: string  // 必传，用于 ACL 校验 + 外键
 *
 * 响应：
 *   { id, url, mimeType, size, filename, category: "image" | "file" }
 *   - url = `/api/attachments/<id>`，前端直接写到 <img src> 或 <a href>；
 *   - category 供前端决定编辑器里插 <img> 还是附件链接。
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
  // 同时拿到笔记的 workspaceId（null = 个人空间），用于附件行的 scope 归属：
  // 这样"文件管理"在个人空间 / 工作区两处列表才能严格按空间区分——否则
  // 所有通过编辑器粘贴 / 上传的图片都会落到 workspaceId IS NULL，
  // 被个人空间的 list 捞到，而工作区的 list（a.workspaceId = ?）反而看不见。
  const { permission, workspaceId: noteWorkspaceId } = resolveNotePermission(
    noteId,
    userId,
  );
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
  // 不限制格式：只拒绝少数高危可执行文件类型，其它任意 MIME 都放行。
  if (BLOCKED_MIMES.has(mime)) {
    return c.json({ error: `出于安全考虑，不支持该类型: ${mime}` }, 415);
  }

  // 落盘
  ensureAttachmentsDir();
  const id = uuid();
  const ext = pickExt(file.name, mime);
  const savePath = path.join(ATTACHMENTS_DIR, `${id}.${ext}`);

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch (err: any) {
    return c.json({ error: `读取上传内容失败: ${err?.message || err}` }, 500);
  }

  // v11 hash 去重：先算 SHA-256，在同 scope（userId + workspaceId）内查命中。
  // 阶段 B 命中策略：
  //   - 相同 (userId, workspaceId, hash) 已存在一行 → 不写新文件，但复制一行新的
  //     attachments 元数据绑定到当前 noteId，path 指向同一物理文件；
  //   - 未命中 → 走正常落盘 + 入库流程，把 hash 一并写下来供后续命中。
  // 范围"同 user 内"而非全局：避免跨用户 ACL 麻烦，删除时引用计数也只在
  // 自己的范围内有效（不会因为另一个用户的笔记还在引用就拒删自己的附件）。
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const dedupRow = db
    .prepare(
      noteWorkspaceId
        ? `SELECT id, path, mimeType, size, filename, hash FROM attachments
            WHERE userId = ? AND workspaceId = ? AND hash = ? LIMIT 1`
        : `SELECT id, path, mimeType, size, filename, hash FROM attachments
            WHERE userId = ? AND workspaceId IS NULL AND hash = ? LIMIT 1`,
    )
    .get(
      ...(noteWorkspaceId
        ? [userId, noteWorkspaceId, sha256]
        : [userId, sha256]),
    ) as ExistingAttachmentForDedup | undefined;

  if (dedupRow) {
    let clone: DeduplicatedAttachmentRow;
    try {
      clone = createDeduplicatedAttachmentRow({
        source: dedupRow,
        noteId,
        userId,
        workspaceId: noteWorkspaceId,
        filename: file.name || dedupRow.filename,
        hash: sha256,
      });
    } catch (err: any) {
      return c.json({ error: `写入数据库失败: ${err?.message || err}` }, 500);
    }

    enqueueAttachment({
      attachmentId: clone.id,
      userId,
      workspaceId: noteWorkspaceId,
      noteId,
    });

    return c.json(
      {
        id: clone.id,
        url: clone.url,
        mimeType: clone.mimeType,
        size: clone.size,
        filename: clone.filename,
        category: isImageMime(clone.mimeType) ? "image" : "file",
        deduplicated: true,
      },
      201,
    );
  }

  try {
    fs.writeFileSync(savePath, buffer);
  } catch (err: any) {
    return c.json({ error: `写入文件失败: ${err?.message || err}` }, 500);
  }

  // 写 DB。attachments.path 存**文件名**（相对 ATTACHMENTS_DIR）而非绝对路径，
  // 换部署环境只需搬目录。
  //
  // workspaceId 继承自 noteId 所属笔记：
  //   - 个人空间笔记 → workspaceId = NULL（文件管理"个人空间"可见）
  //   - 工作区笔记   → workspaceId = <该工作区 id>（该工作区成员在"工作区文件管理"可见）
  // 这与 files.ts 的 list/stats scope 过滤严格对齐，避免"上传到工作区笔记
  // 却只在个人空间看得见"的错位。
  try {
    db.prepare(
      `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      noteId,
      userId,
      file.name || `${id}.${ext}`,
      mime,
      file.size,
      `${id}.${ext}`,
      noteWorkspaceId,
      sha256,
    );
  } catch (err: any) {
    // DB 写失败时把已落盘文件清掉，避免孤儿
    try { fs.unlinkSync(savePath); } catch { /* ignore */ }
    return c.json({ error: `写入数据库失败: ${err?.message || err}` }, 500);
  }

  // v8：上传成功后立即把附件入队做内容索引。enqueueAttachment 内部吞错，
  // 即使队列表异常也不影响上传成功响应。
  enqueueAttachment({
    attachmentId: id,
    userId,
    workspaceId: noteWorkspaceId,
    noteId,
  });

  return c.json(
    {
      id,
      url: `/api/attachments/${id}`,
      mimeType: mime,
      size: file.size,
      filename: file.name || `${id}.${ext}`,
      // category 供前端决定「作为图片 <img> 还是附件链接 <a>」插入编辑器
      category: isImageMime(mime) ? "image" : "file",
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

  // v11 引用计数：dedup 启用后理论上同一 path 不会重复，但极小概率下（迁移
  // 之前的老数据、并发上传竞态）可能多行共享同一物理文件。删除前确认：
  // 若还有其它 attachments 行指向同一 path，仅删本行不动磁盘文件，避免造成
  // 另一行的引用变成"裂图/404"。
  const sameFileCount = db
    .prepare("SELECT COUNT(*) AS c FROM attachments WHERE path = ? AND id <> ?")
    .get(row.path, id) as { c: number };
  const shouldUnlink = sameFileCount.c === 0;

  if (shouldUnlink) {
    try {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    } catch {
      /* 文件删不掉不阻塞，DB 记录仍然要清掉 */
    }
    // v12：清理对应缩略图缓存（仅当确实 unlink 原图时）。
    // 阶段 B 后 id 与 path basename 可能不同，两个 key 都尝试清理。
    deleteThumbnailsFor(ATTACHMENTS_DIR, id);
    const baseName = (row.path || "").replace(/\.[^.]+$/, "");
    if (baseName && baseName !== id) deleteThumbnailsFor(ATTACHMENTS_DIR, baseName);
  } else {
    // 物理文件仍被其它行引用，但当前 id 的缩略图缓存已不可访问，可以清掉。
    deleteThumbnailsFor(ATTACHMENTS_DIR, id);
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
 *
 * @param workspaceId 目标笔记的 workspaceId（null = 个人空间）。必须传：
 *   否则附件的 workspaceId 与笔记不同步，会导致"文件管理"切空间时看不到图。
 *   调用方通常在调用前已经算出（notes.POST 的 inheritedWorkspaceId、
 *   notes.PUT 通过 resolveNotePermission、export 导入从 note 行读回）。
 */
export function extractInlineBase64Images(
  content: string,
  userId: string,
  noteId: string,
  workspaceId: string | null,
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
    `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // v11 hash dedup 命中查询：与 POST /api/attachments 走同款"同 user + 同 workspace"
  // 范围。阶段 B 起，命中后复制一行新元数据绑定当前 noteId，但 path 仍共享老物理文件。
  const dedupSelect = db.prepare(
    workspaceId
      ? `SELECT id, path, filename, mimeType, size, hash FROM attachments
          WHERE userId = ? AND workspaceId = ? AND hash = ? LIMIT 1`
      : `SELECT id, path, filename, mimeType, size, hash FROM attachments
          WHERE userId = ? AND workspaceId IS NULL AND hash = ? LIMIT 1`,
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

      // hash dedup：先查命中，命中则不写盘，但复制新元数据行并返回新 id
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      const hit = (workspaceId
        ? dedupSelect.get(userId, workspaceId, sha256)
        : dedupSelect.get(userId, sha256)) as ExistingAttachmentForDedup | undefined;
      if (hit) {
        try {
          const clone = createDeduplicatedAttachmentRow({
            source: hit,
            noteId,
            userId,
            workspaceId,
            filename: hit.filename,
            hash: sha256,
          });
          attachmentIds.push(clone.id);
          replacedCount++;
          return `${quote}${clone.url}${quote}`;
        } catch {
          return _match;
        }
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
        insertStmt.run(id, noteId, userId, filename, mimeLower, buffer.length, filename, workspaceId, sha256);
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

// ============================================================================
// 孤儿附件扫描器 + GC（A1）
// ----------------------------------------------------------------------------
// 背景：
//   即使 attachments 表对 notes 是 ON DELETE CASCADE，SQLite 也只删行不删
//   磁盘文件；而且像"删除整个笔记本"会沿着 notebooks→notes→attachments 两层
//   级联，业务代码很容易漏掉显式调用 deleteAttachmentFilesByNoteIds()。
//
//   "孤儿"分两类：
//     A. **DB 孤儿**：磁盘上 .png/.jpg... 文件存在，但 attachments 表已查无此 id
//        → 通常是上面级联删除的产物。可安全 unlink。
//     B. **内容孤儿**：attachments 表里有行、磁盘也有文件，但已经没有任何
//        notes.content 引用它了（用户在编辑器里删图但没触发清理）。
//        → 删除前需要谨慎，因为有可能是"刚上传还没保存到 content"的窗口期；
//        所以扫描时引入"宽限期"概念：只考虑 createdAt 早于 N 小时（默认 24h）
//        的附件，避免误杀刚上传的临时附件。
//
//   GC 接口：
//     GET  /api/attachments/_orphans/scan       — 扫描，返回两类孤儿数量+总字节
//     POST /api/attachments/_orphans/clean      — 执行清理（dryRun 默认 true）
//
//   仅管理员可访问。
// ============================================================================

interface OrphanScanResult {
  /** 磁盘存在但 DB 无对应行的文件 */
  dbOrphans: { filename: string; bytes: number }[];
  /** DB 有行但 notes.content 不再引用 */
  contentOrphans: { id: string; filename: string; bytes: number; noteId: string; createdAt: string }[];
  /** 总可回收字节数（dbOrphans + contentOrphans） */
  reclaimableBytes: number;
  /** 磁盘附件目录总占用 */
  totalAttachmentBytes: number;
  /** 扫描使用的内容孤儿宽限期小时数（早于该窗口的才参与） */
  graceHours: number;
}

/**
 * 扫描孤儿附件。
 *
 * @param graceHours 内容孤儿的宽限期：createdAt 距今不足该小时数的附件不参与
 *                   （避免误杀"刚上传还没保存到 content"的窗口期附件）
 */
export function scanOrphanAttachments(graceHours = 24): OrphanScanResult {
  ensureAttachmentsDir();
  const db = getDb();

  // 1) 物理目录全部文件
  // 跳过 .thumbs/ 这种隐藏子目录（v12 缩略图缓存）：isFile 已能挡住目录条目，
  // 但对未来若把缩略图改成同目录平铺命名时多一层防御。
  let diskFiles: string[] = [];
  try {
    diskFiles = fs.readdirSync(ATTACHMENTS_DIR).filter((f) => {
      if (f.startsWith(".")) return false;
      const abs = path.join(ATTACHMENTS_DIR, f);
      try {
        return fs.statSync(abs).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    diskFiles = [];
  }

  let totalAttachmentBytes = 0;
  const fileSizes = new Map<string, number>();
  for (const f of diskFiles) {
    try {
      const sz = fs.statSync(path.join(ATTACHMENTS_DIR, f)).size;
      fileSizes.set(f, sz);
      totalAttachmentBytes += sz;
    } catch {
      /* 单个 stat 失败忽略 */
    }
  }

  // 2) DB 中所有附件
  const dbRows = db
    .prepare("SELECT id, noteId, path, size, createdAt FROM attachments")
    .all() as { id: string; noteId: string; path: string; size: number; createdAt: string }[];
  const dbFilenames = new Set(dbRows.map((r) => r.path));

  // 3) DB 孤儿：磁盘有 + DB 无
  const dbOrphans: { filename: string; bytes: number }[] = [];
  for (const f of diskFiles) {
    if (!dbFilenames.has(f)) {
      dbOrphans.push({ filename: f, bytes: fileSizes.get(f) ?? 0 });
    }
  }

  // 4) 内容孤儿：DB 有行，但所属 note 的 content 不再含 `/api/attachments/<id>`
  //   - 我们一次性把所有 notes 的 content 拼起来做 indexOf 检查（避免 N+1）。
  //   - 内容字段可能很大，但只取 content（已知是 TEXT）。一次扫描 OK。
  const allContents = db.prepare("SELECT id, content FROM notes").all() as { id: string; content: string | null }[];
  // 也要把 task_attachments 等其他可能引用 attachment id 的源头一并考虑——
  // 当前项目只看到 notes.content 引用，task-attachments 是独立目录与表，
  // 所以这里只覆盖 notes。后续如新增引用源在 sources[] 加即可。
  const sources: string[] = [];
  for (const n of allContents) {
    if (n.content) sources.push(n.content);
  }
  const haystack = sources.join("\n");

  const cutoff = Date.now() - graceHours * 3600 * 1000;
  const contentOrphans: OrphanScanResult["contentOrphans"] = [];
  for (const r of dbRows) {
    // 仅扫描宽限期之外的附件
    const created = new Date(r.createdAt).getTime();
    if (Number.isFinite(created) && created > cutoff) continue;
    // 引用判定：搜 `/api/attachments/<id>`（uuid 不会与其他随机字符串混淆）
    if (haystack.indexOf(`/api/attachments/${r.id}`) >= 0) continue;
    contentOrphans.push({
      id: r.id,
      filename: r.path,
      bytes: r.size ?? fileSizes.get(r.path) ?? 0,
      noteId: r.noteId,
      createdAt: r.createdAt,
    });
  }

  const reclaimableBytes =
    dbOrphans.reduce((s, x) => s + x.bytes, 0) + contentOrphans.reduce((s, x) => s + x.bytes, 0);

  return {
    dbOrphans,
    contentOrphans,
    reclaimableBytes,
    totalAttachmentBytes,
    graceHours,
  };
}

interface AttachmentHealthIssue {
  id: string;
  noteId: string;
  noteTitle?: string;
  filename: string;
  path: string;
  mimeType?: string;
  size: number;
  createdAt: string;
  referencedBy: number;
}

interface AttachmentDanglingReference {
  attachmentId: string;
  noteId: string;
  noteTitle?: string;
  isTrashed?: boolean;
}

interface AttachmentSharedPhysicalFile {
  path: string;
  count: number;
  bytes: number;
  attachmentIds: string[];
}

interface AttachmentHealthReport {
  ok: boolean;
  totalAttachments: number;
  totalPhysicalFiles: number;
  totalAttachmentBytes: number;
  missingPhysicalFiles: AttachmentHealthIssue[];
  danglingReferences: AttachmentDanglingReference[];
  sharedPhysicalFiles: AttachmentSharedPhysicalFile[];
  orphans: OrphanScanResult;
  checkedAt: string;
}

/**
 * 阶段 C：附件健康检查。
 *
 * 目标不是清理，而是把“会导致用户看见裂图/404”的问题列出来：
 *   - missingPhysicalFiles：attachments 行存在，但 path 指向的物理文件不存在；
 *   - danglingReferences：notes.content 引用了 /api/attachments/<id>，但 DB 行不存在；
 *   - sharedPhysicalFiles：多条 attachments 行共享同一个 path（阶段 B 的正常形态），
 *     仅作观测，帮助确认引用计数兜底是否生效。
 */
export function scanAttachmentHealth(graceHours = 24): AttachmentHealthReport {
  ensureAttachmentsDir();
  const db = getDb();
  const orphans = scanOrphanAttachments(graceHours);

  let diskFiles: string[] = [];
  try {
    diskFiles = fs.readdirSync(ATTACHMENTS_DIR).filter((f) => {
      if (f.startsWith(".")) return false;
      try {
        return fs.statSync(path.join(ATTACHMENTS_DIR, f)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    diskFiles = [];
  }
  const diskFileSet = new Set(diskFiles);

  const rows = db
    .prepare(
      `SELECT a.id, a.noteId, a.path, a.filename, a.mimeType, COALESCE(a.size, 0) AS size,
              a.createdAt, n.title AS noteTitle
         FROM attachments a
         LEFT JOIN notes n ON n.id = a.noteId`,
    )
    .all() as Array<{
      id: string;
      noteId: string;
      path: string;
      filename: string;
      mimeType: string;
      size: number;
      createdAt: string;
      noteTitle?: string;
    }>;

  const attachmentIds = new Set(rows.map((r) => r.id.toLowerCase()));
  const refCount = new Map<string, number>();
  const danglingReferences: AttachmentDanglingReference[] = [];
  const notes = db
    .prepare("SELECT id, title, content, isTrashed FROM notes WHERE content IS NOT NULL AND content <> ''")
    .all() as Array<{ id: string; title?: string; content: string; isTrashed?: number }>;
  for (const n of notes) {
    const ids = extractAttachmentIdsFromContent(n.content);
    for (const id of ids) {
      refCount.set(id, (refCount.get(id) || 0) + 1);
      if (!attachmentIds.has(id)) {
        danglingReferences.push({
          attachmentId: id,
          noteId: n.id,
          noteTitle: n.title,
          isTrashed: !!n.isTrashed,
        });
      }
    }
  }

  const missingPhysicalFiles: AttachmentHealthIssue[] = [];
  const byPath = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!diskFileSet.has(r.path)) {
      missingPhysicalFiles.push({
        id: r.id,
        noteId: r.noteId,
        noteTitle: r.noteTitle,
        filename: r.filename || r.path,
        path: r.path,
        mimeType: r.mimeType,
        size: r.size || 0,
        createdAt: r.createdAt,
        referencedBy: refCount.get(r.id.toLowerCase()) || 0,
      });
    }
    const list = byPath.get(r.path) || [];
    list.push(r);
    byPath.set(r.path, list);
  }

  const sharedPhysicalFiles: AttachmentSharedPhysicalFile[] = [];
  for (const [p, list] of byPath.entries()) {
    if (list.length <= 1) continue;
    sharedPhysicalFiles.push({
      path: p,
      count: list.length,
      bytes: list[0]?.size || 0,
      attachmentIds: list.map((r) => r.id),
    });
  }
  sharedPhysicalFiles.sort((a, b) => b.count - a.count || b.bytes - a.bytes);

  return {
    ok: missingPhysicalFiles.length === 0 && danglingReferences.length === 0,
    totalAttachments: rows.length,
    totalPhysicalFiles: diskFiles.length,
    totalAttachmentBytes: orphans.totalAttachmentBytes,
    missingPhysicalFiles,
    danglingReferences,
    sharedPhysicalFiles,
    orphans,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * 清理孤儿附件。
 *
 * @param opts.dryRun     仅返回将要清理的清单，不动磁盘和 DB（默认 true）
 * @param opts.kinds      要清理的孤儿类型，默认 ["dbOrphans", "contentOrphans"]
 * @param opts.graceHours 内容孤儿宽限期，与扫描一致
 */
export function cleanOrphanAttachments(opts: {
  dryRun?: boolean;
  kinds?: ("dbOrphans" | "contentOrphans")[];
  graceHours?: number;
}): {
  dryRun: boolean;
  removedFiles: number;
  removedRows: number;
  freedBytes: number;
  scan: OrphanScanResult;
} {
  const dryRun = opts.dryRun !== false;
  const kinds = opts.kinds ?? ["dbOrphans", "contentOrphans"];
  const scan = scanOrphanAttachments(opts.graceHours ?? 24);

  let removedFiles = 0;
  let removedRows = 0;
  let freedBytes = 0;

  if (dryRun) {
    return { dryRun, removedFiles: 0, removedRows: 0, freedBytes: 0, scan };
  }

  // 删 DB 孤儿（仅文件）：scan.dbOrphans 的定义是“磁盘有、DB 无”，因此可直接 unlink。
  if (kinds.includes("dbOrphans")) {
    for (const f of scan.dbOrphans) {
      try {
        fs.unlinkSync(path.join(ATTACHMENTS_DIR, f.filename));
        removedFiles++;
        freedBytes += f.bytes;
      } catch {
        /* 单个失败不阻塞批量 */
      }
    }
  }

  // 删内容孤儿（DB 行 + 可安全回收的物理文件）。
  // 阶段 B 后多条 attachments 行可能共享同一个 path；只有当“本次删除集合以外”
  // 没有任何行继续引用该 path 时，才允许 unlink 物理文件。
  if (kinds.includes("contentOrphans") && scan.contentOrphans.length > 0) {
    const db = getDb();
    const orphanIds = new Set(scan.contentOrphans.map((o) => o.id));
    const pathToOrphans = new Map<string, typeof scan.contentOrphans>();
    for (const o of scan.contentOrphans) {
      const arr = pathToOrphans.get(o.filename) || [];
      arr.push(o);
      pathToOrphans.set(o.filename, arr);
    }

    const pathsSafeToUnlink = new Set<string>();
    for (const [p] of pathToOrphans.entries()) {
      const rows = db
        .prepare("SELECT id FROM attachments WHERE path = ?")
        .all(p) as { id: string }[];
      const hasLiveRef = rows.some((r) => !orphanIds.has(r.id));
      if (!hasLiveRef) pathsSafeToUnlink.add(p);
    }

    const del = db.prepare("DELETE FROM attachments WHERE id = ?");
    const tx = db.transaction(() => {
      for (const o of scan.contentOrphans) {
        try {
          const info = del.run(o.id);
          if (info.changes > 0) removedRows++;
        } catch {
          continue;
        }
        deleteThumbnailsFor(ATTACHMENTS_DIR, o.id);
      }
    });
    tx();

    for (const [p, list] of pathToOrphans.entries()) {
      if (!pathsSafeToUnlink.has(p)) continue;
      try {
        fs.unlinkSync(path.join(ATTACHMENTS_DIR, p));
        removedFiles++;
        freedBytes += list[0]?.bytes || 0;
      } catch {
        /* 文件已不存在或权限问题；DB 行已删，后续健康检查会显示 */
      }
      const baseName = (p || "").replace(/\.[^.]+$/, "");
      if (baseName) deleteThumbnailsFor(ATTACHMENTS_DIR, baseName);
    }
  }

  return { dryRun, removedFiles, removedRows, freedBytes, scan };
}

// ===== Admin 路由：扫描 / 清理 =====

/** 仅管理员；与 data-file.ts 同款实现，避免相互依赖。 */
function requireAdminOrDeny(c: Context): Response | null {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const db = getDb();
  const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined;
  if (!me || me.role !== "admin") return c.json({ error: "仅管理员可操作" }, 403);
  return null;
}

/** 管理员 + sudo：阶段 D 修复类写操作必须二次验证。 */
function requireAdminSudoOrDeny(c: Context): Response | null {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const db = getDb();
  const me = db
    .prepare("SELECT role, tokenVersion FROM users WHERE id = ?")
    .get(userId) as { role: string; tokenVersion: number } | undefined;
  if (!me || me.role !== "admin") return c.json({ error: "仅管理员可操作" }, 403);
  const sudo = verifySudoFromRequest(c, userId, me.tokenVersion ?? 0);
  if (!sudo.ok) return c.json({ error: sudo.message, code: sudo.code }, sudo.status as 401 | 403);
  return null;
}

/** GET /api/attachments/_orphans/scan?graceHours=24 */
app.get("/_orphans/scan", (c) => {
  const denied = requireAdminOrDeny(c);
  if (denied) return denied;
  const grace = Number(c.req.query("graceHours") || 24);
  return c.json(scanOrphanAttachments(Number.isFinite(grace) && grace >= 0 ? grace : 24));
});

/** GET /api/attachments/_health/report?graceHours=24 */
app.get("/_health/report", (c) => {
  const denied = requireAdminOrDeny(c);
  if (denied) return denied;
  const grace = Number(c.req.query("graceHours") || 24);
  return c.json(scanAttachmentHealth(Number.isFinite(grace) && grace >= 0 ? grace : 24));
});

/**
 * POST /api/attachments/_orphans/clean
 * body: { dryRun?: boolean, kinds?: ("dbOrphans"|"contentOrphans")[], graceHours?: number }
 *
 * 默认 dryRun=true，必须显式传 false 才会真正删除——避免管理员一次手抖清空所有附件。
 */
app.post("/_orphans/clean", async (c) => {
  const denied = requireAdminOrDeny(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as {
    dryRun?: boolean;
    kinds?: ("dbOrphans" | "contentOrphans")[];
    graceHours?: number;
  };
  const result = cleanOrphanAttachments({
    dryRun: body.dryRun !== false,
    kinds: body.kinds,
    graceHours: body.graceHours,
  });
  return c.json(result);
});

/**
 * POST /api/attachments/_repair/missing/:id/upload
 * multipart/form-data: file=<replacement>, force=1(optional)
 *
 * 阶段 D：手动上传替代文件，修复“DB 行存在但物理文件缺失”的裂图。
 * 默认只允许修复缺失文件；如物理文件已存在，必须显式 force=1 才覆盖。
 */
app.post("/_repair/missing/:id/upload", async (c) => {
  const denied = requireAdminSudoOrDeny(c);
  if (denied) return denied;

  const id = c.req.param("id");
  const db = getDb();
  const row = db
    .prepare("SELECT id, path FROM attachments WHERE id = ?")
    .get(id) as { id: string; path: string } | undefined;
  if (!row) return c.json({ error: "附件记录不存在" }, 404);
  if (!row.path || path.basename(row.path) !== row.path || row.path.includes("..")) {
    return c.json({ error: "附件路径异常，拒绝写入" }, 400);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "请求必须是 multipart/form-data" }, 400);
  }
  const file = form.get("file");
  const force = form.get("force") === "1";
  if (!(file instanceof File)) return c.json({ error: "缺少 file 字段" }, 400);
  if (file.size <= 0) return c.json({ error: "上传文件为空" }, 400);
  if (file.size > MAX_ATTACHMENT_SIZE) {
    return c.json({ error: `文件过大（最大 ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB）` }, 413);
  }

  const mime = (file.type || "application/octet-stream").toLowerCase();
  if (BLOCKED_MIMES.has(mime)) {
    return c.json({ error: `出于安全考虑，不支持该类型: ${mime}` }, 415);
  }

  ensureAttachmentsDir();
  const abs = path.join(ATTACHMENTS_DIR, row.path);
  if (fs.existsSync(abs) && !force) {
    return c.json({ error: "物理文件已存在；如需覆盖请显式 force=1", code: "FILE_EXISTS" }, 409);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch (err: any) {
    return c.json({ error: `读取上传内容失败: ${err?.message || err}` }, 500);
  }
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  try {
    fs.writeFileSync(abs, buffer);
  } catch (err: any) {
    return c.json({ error: `写入附件文件失败: ${err?.message || err}` }, 500);
  }

  const sameRows = db
    .prepare("SELECT id, noteId, userId, workspaceId FROM attachments WHERE path = ?")
    .all(row.path) as Array<{ id: string; noteId: string; userId: string; workspaceId: string | null }>;

  try {
    db.prepare("UPDATE attachments SET mimeType = ?, size = ?, hash = ? WHERE path = ?")
      .run(mime, buffer.length, sha256, row.path);
  } catch (err: any) {
    return c.json({ error: `更新附件元数据失败: ${err?.message || err}` }, 500);
  }

  const baseName = (row.path || "").replace(/\.[^.]+$/, "");
  if (baseName) deleteThumbnailsFor(ATTACHMENTS_DIR, baseName);
  for (const r of sameRows) {
    deleteThumbnailsFor(ATTACHMENTS_DIR, r.id);
    enqueueAttachment({
      attachmentId: r.id,
      userId: r.userId,
      workspaceId: r.workspaceId,
      noteId: r.noteId,
    });
  }

  return c.json({
    success: true,
    repairedRows: sameRows.length,
    path: row.path,
    size: buffer.length,
    hash: sha256,
    health: scanAttachmentHealth(24),
  });
});

/**
 * POST /api/attachments/_repair/dangling/remove
 * body: { attachmentIds: string[], noteIds?: string[] }
 *
 * 阶段 D：移除正文中指向不存在附件 ID 的坏引用。为了不破坏 Tiptap JSON 结构，
 * 最小安全动作是把 URL 字符串替换为空字符串；编辑器不再请求 404。
 */
app.post("/_repair/dangling/remove", async (c) => {
  const denied = requireAdminSudoOrDeny(c);
  if (denied) return denied;

  const body = (await c.req.json().catch(() => ({}))) as {
    attachmentIds?: string[];
    noteIds?: string[];
  };
  const ids = Array.from(new Set((body.attachmentIds || []).map((x) => String(x || "").toLowerCase()).filter(Boolean)));
  const noteFilter = new Set((body.noteIds || []).map((x) => String(x || "")).filter(Boolean));
  if (ids.length === 0) return c.json({ error: "attachmentIds 不能为空" }, 400);

  const db = getDb();
  const notes = db
    .prepare("SELECT id, content FROM notes WHERE content IS NOT NULL AND content <> ''")
    .all() as Array<{ id: string; content: string }>;

  let notesUpdated = 0;
  let referencesRemoved = 0;
  const changed: Array<{ noteId: string; removed: number }> = [];

  const tx = db.transaction(() => {
    const upd = db.prepare(
      "UPDATE notes SET content = ?, updatedAt = datetime('now'), version = version + 1 WHERE id = ?",
    );
    for (const n of notes) {
      if (noteFilter.size > 0 && !noteFilter.has(n.id)) continue;
      let next = n.content || "";
      let removedForNote = 0;
      for (const id of ids) {
        const needle = `/api/attachments/${id}`;
        const before = next.length;
        next = next.split(needle).join("");
        if (next.length !== before) {
          removedForNote += (before - next.length) / needle.length;
        }
      }
      if (removedForNote <= 0 || next === n.content) continue;
      upd.run(next, n.id);
      try {
        syncReferences(db, n.id, next);
      } catch (e) {
        console.warn("[attachments.repair] syncReferences failed for note", n.id, e);
      }
      notesUpdated++;
      referencesRemoved += removedForNote;
      changed.push({ noteId: n.id, removed: removedForNote });
    }
  });

  try {
    tx();
  } catch (err: any) {
    return c.json({ error: `移除悬空引用失败: ${err?.message || err}` }, 500);
  }

  return c.json({
    success: true,
    notesUpdated,
    referencesRemoved,
    changed,
    health: scanAttachmentHealth(24),
  });
});

export default app;
