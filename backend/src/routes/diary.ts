/**
 * 说说（diary）路由
 * ---------------------------------------------------------------------------
 * 模块组成：
 *   - diaryRouter（默认导出）：受 JWT 保护的业务接口（发布 / 时间线 / 删除 /
 *     统计 / 图片上传 / 删除孤儿图片）。挂在 /api/diary。
 *   - handleDownloadDiaryImage：不走 JWT 的下载 handler。原因同
 *     attachments.handleDownloadAttachment：<img> 标签的原生请求不会自动带
 *     Authorization header。授权模型也保持一致 ——「id 不可枚举（uuid）」。
 *
 * 图片上传时序：
 *   1) 前端选好图后立刻 POST /api/diary/attachments 上传，拿到 { id, url }
 *      → 此时 diary_attachments 行的 diaryId 是 NULL（"悬空"状态）
 *   2) 用户点"发布" → POST /api/diary 把 images: string[]（uuid 数组）一起提交
 *      → 后端把这些 id 的 diaryId 字段更新为新建的 diary.id
 *   3) 上传后超过 24h 仍未绑定的孤儿，由模块加载时启动的轻量清理器扫除磁盘 + DB 行
 *
 * 与 notes 的 attachments 对比：
 *   - 这里 diaryId 允许 NULL（先上传后绑定），attachments 的 noteId 是 NOT NULL
 *   - 这里没有 ACL 中间件，因为说说本来就是个人空间产物（无协作 / 分享）
 *   - 文件落盘复用同一个 ATTACHMENTS_DIR（共用磁盘目录但各自管自己的 DB 表）
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import crypto from "crypto";
import {
  ensureAttachmentsDir,
  MIME_TO_EXT,
} from "./attachments";
import {
  deleteAttachmentObject,
  readAttachmentObject,
  writeAttachmentObject,
} from "../services/attachment-storage";
import {
  getUserWorkspaceRole,
  canManageResource,
  requireWorkspaceFeature,
} from "../middleware/acl";

const diary = new Hono();

// ---------------------------------------------------------------------------
// Phase 2/Y2: 工作区 scope 解析
// ---------------------------------------------------------------------------
// 说说路由兼容两种作用域：
//   - 个人空间：`?workspaceId=` 未传 / 传 'personal' → diaries.workspaceId IS NULL
//   - 工作区：   `?workspaceId=<uuid>`                → diaries.workspaceId = <uuid>
//                                                    （需要当前用户是该工作区成员，
//                                                     且 workspace.enabledFeatures.diaries !== false）
//
// 返回 { scope, workspaceId, error? }：
//   - error 非空时路由应立即返回 403
//   - scope === 'personal' 时 workspaceId 为 null（用于 SQL "IS NULL" 比较）
//   - scope === 'workspace' 时 workspaceId 为具体 uuid 字符串
function resolveDiaryScope(
  c: Context,
  userId: string,
): { scope: "personal" | "workspace"; workspaceId: string | null; error?: string } {
  const raw = c.req.query("workspaceId");
  if (!raw || raw === "personal") {
    return { scope: "personal", workspaceId: null };
  }
  const role = getUserWorkspaceRole(raw, userId);
  if (!role) {
    return { scope: "workspace", workspaceId: raw, error: "无权访问该工作区" };
  }
  return { scope: "workspace", workspaceId: raw };
}

// 单条说说最多 9 张图（朋友圈风格；前端也应该卡同样的上限做"快速失败"）
const MAX_IMAGES_PER_DIARY = 9;
const MAX_VIDEOS_PER_DIARY = 1;

// 单张图片大小上限（字节）。比 notes 的 50MB 更保守，因为说说量大、不应被截图怼爆磁盘
const MAX_DIARY_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_DIARY_VIDEO_SIZE = 100 * 1024 * 1024;

// 允许的图片 MIME（与 attachments 路由对齐，但不收 svg —— 防止 XSS 飘到时间线）
const ALLOWED_DIARY_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

const ALLOWED_DIARY_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

const DIARY_VIDEO_MIME_TO_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

type DiaryMediaType = "image" | "video";

interface DiaryMediaItem {
  id: string;
  type: DiaryMediaType;
}

// 上传超过这么久仍未绑定 diaryId 视为孤儿，会被清理器扫除
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ---------------------------------------------------------------------------
// 工具：把数据库行（含 images 文本字段）规整成前端期望的形状
// ---------------------------------------------------------------------------
interface DiaryRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  contentText: string;
  mood: string;
  images: string;
  media?: string;
  createdAt: string;
  /**
   * creatorName：工作区下展示"谁发的说说"。LEFT JOIN 取自 users.username，
   * 用户被删除时为 null（前端按"未知用户"渲染）。
   * 仅在 list 接口（/timeline）填充，单条创建/单条返回也会顺手填上保持契约一致。
   */
  creatorName?: string | null;
}

function mediaTypeFromMime(mime: string | null | undefined): DiaryMediaType | null {
  const m = (mime || "").toLowerCase();
  if (ALLOWED_DIARY_IMAGE_MIMES.has(m)) return "image";
  if (ALLOWED_DIARY_VIDEO_MIMES.has(m)) return "video";
  return null;
}

function parseDiaryImages(raw: string | null | undefined): string[] {
  let images: string[] = [];
  try {
    const parsed = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) {
      images = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* 旧数据脏 → 当作没图，避免接口 500 */
  }
  return images;
}

function parseDiaryMedia(raw: string | null | undefined): DiaryMediaItem[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x): DiaryMediaItem | null => {
        if (!x || typeof x !== "object") return null;
        const id = typeof (x as any).id === "string" ? (x as any).id : "";
        const type = (x as any).type === "video" ? "video" : (x as any).type === "image" ? "image" : null;
        return id && type ? { id, type } : null;
      })
      .filter((x): x is DiaryMediaItem => !!x);
  } catch {
    return [];
  }
}

function rowToDiary(row: DiaryRow) {
  const images = parseDiaryImages(row.images);
  let media = parseDiaryMedia(row.media);
  if (media.length === 0 && images.length > 0) {
    media = images.map((id) => ({ id, type: "image" as const }));
  }
  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    contentText: row.contentText,
    mood: row.mood,
    images,
    media,
    createdAt: row.createdAt,
    creatorName: row.creatorName ?? null,
  };
}

function normalizeRequestedMedia(body: any): { media: DiaryMediaItem[]; usedMedia: boolean; error?: string; status?: 400 } {
  if (Array.isArray(body?.media)) {
    const media = body.media
      .map((x: unknown): DiaryMediaItem | null => {
        if (!x || typeof x !== "object") return null;
        const id = typeof (x as any).id === "string" ? (x as any).id : "";
        const type = (x as any).type === "video" ? "video" : (x as any).type === "image" ? "image" : null;
        return id && type ? { id, type } : null;
      })
      .filter((x: DiaryMediaItem | null): x is DiaryMediaItem => !!x);
    return validateDiaryMedia(media, true);
  }

  const images = Array.isArray(body?.images)
    ? body.images.filter((x: unknown): x is string => typeof x === "string")
    : [];
  return validateDiaryMedia(images.map((id: string) => ({ id, type: "image" as const })), false);
}

function validateDiaryMedia(media: DiaryMediaItem[], usedMedia: boolean): { media: DiaryMediaItem[]; usedMedia: boolean; error?: string; status?: 400 } {
  const deduped: DiaryMediaItem[] = [];
  const seen = new Set<string>();
  for (const item of media) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }
  const imageCount = deduped.filter((x) => x.type === "image").length;
  const videoCount = deduped.filter((x) => x.type === "video").length;
  if (imageCount > 0 && videoCount > 0) {
    return { media: [], usedMedia, error: "暂不支持图片和视频混发", status: 400 };
  }
  if (imageCount > MAX_IMAGES_PER_DIARY) {
    return { media: [], usedMedia, error: `最多上传 ${MAX_IMAGES_PER_DIARY} 张图片`, status: 400 };
  }
  if (videoCount > MAX_VIDEOS_PER_DIARY) {
    return { media: [], usedMedia, error: `最多上传 ${MAX_VIDEOS_PER_DIARY} 个视频`, status: 400 };
  }
  return { media: deduped, usedMedia };
}

function mediaImages(media: DiaryMediaItem[]): string[] {
  return media.filter((x) => x.type === "image").map((x) => x.id);
}

function getValidDiaryMedia(
  ids: string[],
  userId: string,
  diaryId: string | null,
): DiaryMediaItem[] {
  if (!ids.length) return [];
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = diaryId
    ? db
        .prepare(
          `SELECT id, mimeType FROM diary_attachments
            WHERE id IN (${placeholders})
              AND (diaryId = ? OR (userId = ? AND diaryId IS NULL))`,
        )
        .all(...ids, diaryId, userId) as { id: string; mimeType: string }[]
    : db
        .prepare(
          `SELECT id, mimeType FROM diary_attachments
            WHERE id IN (${placeholders})
              AND userId = ?
              AND diaryId IS NULL`,
        )
        .all(...ids, userId) as { id: string; mimeType: string }[];
  const byId = new Map(rows.map((r) => [r.id, mediaTypeFromMime(r.mimeType)]));
  return ids
    .map((id) => {
      const type = byId.get(id);
      return type ? { id, type } : null;
    })
    .filter((x): x is DiaryMediaItem => !!x);
}

// ---------------------------------------------------------------------------
// 工具：删除一组 diary_attachments 行对应的磁盘文件
//   外键 ON DELETE CASCADE 只清 DB 行，磁盘文件需要手动收拾，否则积累孤儿。
//   返回真正 unlink 成功的文件数（仅用于日志）。
// ---------------------------------------------------------------------------
async function deleteDiaryMediaFilesByIds(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  let rows: { path: string }[] = [];
  try {
    rows = db
      .prepare(`SELECT path FROM diary_attachments WHERE id IN (${placeholders})`)
      .all(...ids) as { path: string }[];
  } catch {
    return 0;
  }
  let removed = 0;
  for (const r of rows) {
    if (!r?.path) continue;
    try {
      await deleteAttachmentObject(r.path);
      removed++;
    } catch {
      /* 单个失败不阻塞批量 */
    }
  }
  return removed;
}

// ===========================================================================
// 说说基础接口
// ===========================================================================

/**
 * 发布一条说说
 *   body: { contentText: string, mood?: string, images?: string[], media?: DiaryMediaItem[] }
 *   query: workspaceId?  (personal / <uuid>，省略即个人空间)
 *   - images 是先通过 POST /api/diary/attachments 上传得到的 uuid 数组；
 *     这里把它们的 diaryId 字段 UPDATE 为新 diary.id，完成"绑定"；同时
 *     把 diary_attachments.workspaceId 对齐到目标工作区（Y2：便于按工作区
 *     维度做存储配额 / 清理统计）。
 *   - 只更新真正属于当前 userId 且当前 diaryId 仍为 NULL 的行（防止有人偷接别人的图）。
 *   - 工作区 scope：必须是该工作区成员 + diaries 功能开关未被关闭（由
 *     requireWorkspaceFeature 中间件校验）。
 */
diary.post("/", requireWorkspaceFeature("diaries"), async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  const scope = resolveDiaryScope(c, userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const { contentText, mood } = body;
  const requested = normalizeRequestedMedia(body);
  if (requested.error) return c.json({ error: requested.error }, requested.status || 400);
  const requestedMedia = requested.media;

  // 内容与媒体至少一项非空（纯图片 / 纯视频说说也允许）
  const hasText = typeof contentText === "string" && contentText.trim().length > 0;
  if (!hasText && requestedMedia.length === 0) {
    return c.json({ error: "Content or media required" }, 400);
  }

  const id = crypto.randomUUID();
  const orderedValidMedia = getValidDiaryMedia(
    requestedMedia.map((x) => x.id),
    userId,
    null,
  );
  if (orderedValidMedia.length !== requestedMedia.length) {
    return c.json({ error: "媒体附件不存在或已被使用" }, 400);
  }
  const checked = validateDiaryMedia(orderedValidMedia, requested.usedMedia);
  if (checked.error) return c.json({ error: checked.error }, checked.status || 400);
  const media = checked.media;
  const images = mediaImages(media);

  // 把整批写入放进事务：要么 diary 行 + 图片 attach 一起成功，要么全部回滚
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO diaries (id, userId, workspaceId, contentText, mood, images, media) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      userId,
      scope.workspaceId,
      hasText ? contentText.trim() : "",
      typeof mood === "string" ? mood : "",
      JSON.stringify(images),
      JSON.stringify(media),
    );

    if (media.length > 0) {
      // 只 attach 真正"属于本人 + 仍悬空"的媒体，杜绝越权 / 重复绑定。
      // Y2: 同时把 diary_attachments.workspaceId 对齐到目标 scope，保持附件
      //     与说说的工作区归属一致（便于按工作区统计磁盘占用、清理）。
      const mediaIds = media.map((x) => x.id);
      const placeholders = mediaIds.map(() => "?").join(",");
      const upd = db.prepare(
        `UPDATE diary_attachments
            SET diaryId = ?, workspaceId = ?
          WHERE id IN (${placeholders})
            AND userId = ?
            AND diaryId IS NULL`,
      );
      upd.run(id, scope.workspaceId, ...mediaIds, userId);
    }
  });

  try {
    tx();
  } catch (err: any) {
    return c.json({ error: `发布失败：${err?.message || err}` }, 500);
  }

  const created = db.prepare("SELECT * FROM diaries WHERE id = ?").get(id) as DiaryRow;
  return c.json(rowToDiary(created), 201);
});

// ---------------------------------------------------------------------------
// 时间筛选：把前端传入的 from/to 规整成"可与 createdAt 字符串比较"的形式。
//   - createdAt 入库形如 "YYYY-MM-DD HH:MM:SS"（UTC，由 SQLite datetime('now')）
//   - 前端可以传：
//       * "YYYY-MM-DD"  → from 视为 00:00:00、to 视为 23:59:59（同 UTC 字符串语义）
//       * "YYYY-MM-DD HH:MM:SS" / "YYYY-MM-DDTHH:MM:SS[Z]" → 全部归一到空格分隔的形式
//   - 非法值直接忽略（返回 null），不报错，避免前端日期组件偶尔出脏值阻塞列表
// ---------------------------------------------------------------------------
function normalizeDateBound(raw: string | undefined, kind: "from" | "to"): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // 纯日期：补时分秒
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return kind === "from" ? `${s} 00:00:00` : `${s} 23:59:59`;
  }
  // 完整时间：把 T/Z 去掉，统一成 SQLite 习惯的空格分隔
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/);
  if (m) return `${m[1]} ${m[2]}`;
  return null; // 形态不认识就当没传
}

// 公用：把 scope + 可选 from/to 拼成 WHERE 子句 + 参数数组（cursor 由调用方追加）
// Y2:
//   - scope.personal → `userId = ? AND workspaceId IS NULL`
//   - scope.workspace → `workspaceId = ?`（全员可见，不再按 userId 过滤）
//
// 字段前缀说明：
//   timeline 列表为了拉 creatorName 与 users 表 LEFT JOIN，
//   而 users 表也存在 `createdAt`、`id` 同名列；为防止 SQLite 解析成歧义，
//   涉及双表都有的列（这里只有 createdAt）一律带 `diaries.` 表前缀。
//   `userId` 仅 diaries 有（users 叫 `id`），不需要前缀；
//   `workspaceId` 仅 diaries 有，同上。
function buildTimeRangeWhere(
  scope: { scope: "personal" | "workspace"; workspaceId: string | null },
  userId: string,
  from: string | null,
  to: string | null,
): { sql: string; args: unknown[] } {
  let sql: string;
  const args: unknown[] = [];
  if (scope.scope === "workspace") {
    sql = "diaries.workspaceId = ?";
    args.push(scope.workspaceId);
  } else {
    sql = "diaries.userId = ? AND diaries.workspaceId IS NULL";
    args.push(userId);
  }
  if (from) {
    sql += " AND diaries.createdAt >= ?";
    args.push(from);
  }
  if (to) {
    sql += " AND diaries.createdAt <= ?";
    args.push(to);
  }
  return { sql, args };
}

// 获取时间线（分页，按时间倒序，可按 from/to 过滤）
diary.get("/timeline", requireWorkspaceFeature("diaries"), (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const cursor = c.req.query("cursor"); // 上次最后一条的 createdAt
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);
  const from = normalizeDateBound(c.req.query("from"), "from");
  const to = normalizeDateBound(c.req.query("to"), "to");

  const scope = resolveDiaryScope(c, userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const { sql: whereSql, args } = buildTimeRangeWhere(scope, userId, from, to);
  let finalWhere = whereSql;
  const finalArgs = [...args];
  if (cursor) {
    // 带 diaries. 前缀：因为本 SELECT 与 users 表 LEFT JOIN，避免 createdAt 歧义。
    finalWhere += " AND diaries.createdAt < ?";
    finalArgs.push(cursor);
  }

  const rows = db
    .prepare(
      // creatorName: LEFT JOIN users 取创建者用户名（工作区下展示"谁发的"）。
      // diaries.* 保留原契约；新增 creatorName 字段由 rowToDiary 透传给前端。
      // ORDER BY 显式带 diaries.createdAt 前缀，避免和 users 表潜在的同名列歧义。
      `SELECT diaries.*, users.username AS creatorName
       FROM diaries LEFT JOIN users ON users.id = diaries.userId
       WHERE ${finalWhere}
       ORDER BY diaries.createdAt DESC
       LIMIT ?`,
    )
    .all(...finalArgs, limit) as DiaryRow[];

  const hasMore = rows.length === limit;
  const nextCursor = rows.length > 0 ? rows[rows.length - 1].createdAt : null;

  return c.json({
    items: rows.map(rowToDiary),
    hasMore,
    nextCursor,
  });
});

/**
 * 编辑一条说说
 *   PUT /api/diary/:id
 *   body: { contentText?: string, mood?: string, images?: string[] }
 *
 * 鉴权：复用 canManageResource —— 个人说说仅作者本人；工作区说说允许
 *        作者本人 + 该工作区 admin/owner（与 DELETE 同口径）。
 *
 * 处理要点：
 *   - 仅更新调用方显式传入的字段（undefined 跳过，不会被清空）；
 *   - 图片更新（images 字段）需要做"差集 attach / 反 attach"：
 *       新增：把"属于本人 + 仍悬空"的图片 attach 到该 diary；
 *       移除：把"属于本人 + 当前 attach 到该 diary 但不在新列表里"的图片
 *             连同磁盘文件一并删除（与 DELETE 整条说说同口径）。
 *     这样既保证存量图片不被反复改写，也避免漏删导致磁盘孤儿；
 *   - 与 POST 一样：text 与 images 至少一项非空，纯空说说不允许保存；
 *   - 整批写入放进事务，部分失败整体回滚，避免出现"图片删了但 diary 没改"的中间态。
 */
diary.put("/:id", (c) => {
  return (async () => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const id = c.req.param("id");

    const row = db
      .prepare("SELECT * FROM diaries WHERE id = ?")
      .get(id) as DiaryRow | undefined;
    if (!row) return c.json({ error: "Not found" }, 404);

    if (!canManageResource(row.userId, row.workspaceId, userId)) {
      return c.json({ error: "无权编辑该说说", code: "FORBIDDEN" }, 403);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // 解析输入。注意"未传"和"传空字符串/空数组"含义不同：
    //   - 未传（undefined）：保持不变；
    //   - 显式传入：覆盖该字段。
    const newContentText: string | undefined =
      typeof body.contentText === "string" ? body.contentText.trim() : undefined;
    const newMood: string | undefined =
      typeof body.mood === "string" ? body.mood : undefined;
    const mediaProvided = Array.isArray(body.media) || Array.isArray(body.images);
    const requested = mediaProvided ? normalizeRequestedMedia(body) : null;
    if (requested?.error) return c.json({ error: requested.error }, requested.status || 400);

    const currentMedia = (() => {
      const parsed = parseDiaryMedia(row.media);
      if (parsed.length > 0) return parsed;
      return parseDiaryImages(row.images).map((mediaId) => ({ id: mediaId, type: "image" as const }));
    })();

    // 计算合并后的最终值（仅用来做"text 和 media 至少一项非空"校验）
    const finalText = newContentText !== undefined ? newContentText : row.contentText;
    const finalMediaPreview = requested ? requested.media : currentMedia;
    if (!finalText && finalMediaPreview.length === 0) {
      return c.json({ error: "Content or media required" }, 400);
    }

    // 如果调用方没改任何字段，直接回当前值（幂等）
    if (
      newContentText === undefined &&
      newMood === undefined &&
      !mediaProvided
    ) {
      return c.json(rowToDiary(row));
    }

    // 准备媒体差集（仅当调用方显式传入 media/images 时才处理）
    let toUnlinkIds: string[] = [];
    let finalMediaOrder: DiaryMediaItem[] = [];
    if (requested) {
      const requestedIds = requested.media.map((x) => x.id);
      finalMediaOrder = getValidDiaryMedia(requestedIds, userId, id);
      if (finalMediaOrder.length !== requested.media.length) {
        return c.json({ error: "媒体附件不存在或已被使用" }, 400);
      }
      const checked = validateDiaryMedia(finalMediaOrder, requested.usedMedia);
      if (checked.error) return c.json({ error: checked.error }, checked.status || 400);
      finalMediaOrder = checked.media;

      const currentRows = db
        .prepare("SELECT id FROM diary_attachments WHERE diaryId = ?")
        .all(id) as { id: string }[];
      const currentIds = new Set(currentRows.map((r) => r.id));
      const targetIds = new Set(finalMediaOrder.map((x) => x.id));
      toUnlinkIds = [...currentIds].filter((x) => !targetIds.has(x));
    }

    if (toUnlinkIds.length > 0) {
      await deleteDiaryMediaFilesByIds(toUnlinkIds);
    }

    const tx = db.transaction(() => {
      // 1) 处理媒体：删除被移除项的 DB 行，再 attach 新媒体
      if (requested) {
        if (toUnlinkIds.length > 0) {
          const ph = toUnlinkIds.map(() => "?").join(",");
          db.prepare(
            `DELETE FROM diary_attachments WHERE id IN (${ph}) AND diaryId = ?`,
          ).run(...toUnlinkIds, id);
        }
        // attach 新增的悬空媒体到该 diary（顺序保留交给最后一步覆写 media 字段）
        const newOnes = finalMediaOrder
          .map((x) => x.id)
          .filter((x) => !currentMedia.some((m) => m.id === x));
        if (newOnes.length > 0) {
          const ph = newOnes.map(() => "?").join(",");
          db.prepare(
            `UPDATE diary_attachments
                SET diaryId = ?, workspaceId = ?
              WHERE id IN (${ph})
                AND userId = ?
                AND (diaryId IS NULL OR diaryId = ?)`,
          ).run(id, row.workspaceId, ...newOnes, userId, id);
        }
      }

      // 2) 更新 diary 主行
      const updates: string[] = [];
      const args: unknown[] = [];
      if (newContentText !== undefined) {
        updates.push("contentText = ?");
        args.push(newContentText);
      }
      if (newMood !== undefined) {
        updates.push("mood = ?");
        args.push(newMood);
      }
      if (requested) {
        updates.push("images = ?");
        args.push(JSON.stringify(mediaImages(finalMediaOrder)));
        updates.push("media = ?");
        args.push(JSON.stringify(finalMediaOrder));
      }
      if (updates.length > 0) {
        args.push(id);
        db.prepare(
          `UPDATE diaries SET ${updates.join(", ")} WHERE id = ?`,
        ).run(...args);
      }
    });

    try {
      tx();
    } catch (err: any) {
      return c.json({ error: `保存失败：${err?.message || err}` }, 500);
    }

    // 返回更新后的整条记录（顺手 LEFT JOIN 取 creatorName 保持契约一致）
    const updated = db
      .prepare(
        `SELECT diaries.*, users.username AS creatorName
           FROM diaries LEFT JOIN users ON users.id = diaries.userId
          WHERE diaries.id = ?`,
      )
      .get(id) as DiaryRow;
    return c.json(rowToDiary(updated));
  })();
});

// 删除一条说说（同时清理它名下所有图片：磁盘 + DB 行）
// Y2: 工作区说说走 canManageResource —— 创建者本人 + admin/owner 可删；
//      个人说说仍只有创建者本人可删。
diary.delete("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");

  const row = db
    .prepare("SELECT id, userId, workspaceId FROM diaries WHERE id = ?")
    .get(id) as { id: string; userId: string; workspaceId: string | null } | undefined;
  if (!row) return c.json({ error: "Not found" }, 404);

  if (!canManageResource(row.userId, row.workspaceId, userId)) {
    return c.json({ error: "无权删除该说说", code: "FORBIDDEN" }, 403);
  }

  // 先查出图片 id（DELETE CASCADE 之后行就没了，查不到 path）
  const imgRows = db
    .prepare("SELECT id FROM diary_attachments WHERE diaryId = ?")
    .all(id) as { id: string }[];
  const imgIds = imgRows.map((r) => r.id);

  await deleteDiaryMediaFilesByIds(imgIds);
  // diary_attachments 通过 ON DELETE CASCADE 自动清理
  db.prepare("DELETE FROM diaries WHERE id = ?").run(id);
  return c.json({ success: true });
});

// 统计
//   - 不带 from/to：返回"全部 + 今日"两个数（保留旧行为，兼容已有调用）
//   - 带 from/to：返回当前筛选范围内的总数（todayCount 仍按"今日"统计，不受筛选影响）
// Y2: 按 scope（personal / workspace）统计；工作区模式下 todayCount 也按 workspace
//      统计（不再限定 userId），与 timeline 的可见范围保持一致。
diary.get("/stats", requireWorkspaceFeature("diaries"), (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const from = normalizeDateBound(c.req.query("from"), "from");
  const to = normalizeDateBound(c.req.query("to"), "to");

  const scope = resolveDiaryScope(c, userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const { sql: whereSql, args } = buildTimeRangeWhere(scope, userId, from, to);
  const total = (
    db
      .prepare(`SELECT COUNT(*) as count FROM diaries WHERE ${whereSql}`)
      .get(...args) as any
  ).count;

  // 今日发布数：始终按"今天"统计，独立于筛选范围（前端用作活跃度参考）。
  const today = new Date().toISOString().split("T")[0];
  const todayCount = (() => {
    if (scope.scope === "workspace") {
      return (
        db
          .prepare(
            "SELECT COUNT(*) as count FROM diaries WHERE workspaceId = ? AND createdAt >= ?",
          )
          .get(scope.workspaceId, today) as any
      ).count;
    }
    return (
      db
        .prepare(
          "SELECT COUNT(*) as count FROM diaries WHERE userId = ? AND workspaceId IS NULL AND createdAt >= ?",
        )
        .get(userId, today) as any
    ).count;
  })();

  return c.json({ total, todayCount });
});

// ===========================================================================
// 说说媒体上传（受 JWT 保护）
//   挂在 /api/diary/attachments，返回的 url 走下面 handleDownloadDiaryImage。
// ===========================================================================

/**
 * 上传一个说说媒体附件。
 *   POST /api/diary/attachments
 *   query: workspaceId?  (personal / <uuid>)
 *   multipart: file
 *
 * 此时返回的附件 diaryId 是 NULL，等用户实际点"发布"时 POST /api/diary
 * 再带上 images: [id...] 完成绑定（见上面 diary.post 注释）。
 *
 * Y2:
 *   - 上传时即记录目标 workspaceId（若指定工作区且为成员）；diary 发布时若
 *     scope 不一致会被 UPDATE 一次对齐（见 diary.post）；
 *   - orphan 上限"50 张"按 scope 分别计数（避免在工作区上传把个人空间额度也吃光）。
 */
diary.post("/attachments", requireWorkspaceFeature("diaries"), async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const db = getDb();

  const scope = resolveDiaryScope(c, userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  let body: Record<string, any>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "invalid multipart body" }, 400);
  }

  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ error: "file 字段缺失或非文件" }, 400);
  }

  const mime = (file.type || "application/octet-stream").toLowerCase();
  const mediaType = mediaTypeFromMime(mime);
  if (!mediaType) {
    return c.json({ error: `不支持的 MIME 类型: ${mime}` }, 415);
  }

  const sizeLimit = mediaType === "video" ? MAX_DIARY_VIDEO_SIZE : MAX_DIARY_IMAGE_SIZE;
  if (file.size > sizeLimit) {
    return c.json(
      {
        error:
          mediaType === "video"
            ? `视频过大（最大 ${MAX_DIARY_VIDEO_SIZE / 1024 / 1024}MB）`
            : `图片过大（最大 ${MAX_DIARY_IMAGE_SIZE / 1024 / 1024}MB）`,
      },
      413,
    );
  }

  // 单用户当前悬空附件数限制：防止恶意客户端只上传不发布把磁盘怼爆。
  // 这里用一个简单上限 50 张：正常用户撑死也就一次发 9 张；触发就回 429。
  // Y2: 按 scope 分别计数。
  const orphanCountQuery = scope.scope === "workspace"
    ? db.prepare(
        "SELECT COUNT(*) as count FROM diary_attachments WHERE userId = ? AND diaryId IS NULL AND workspaceId = ?",
      )
    : db.prepare(
        "SELECT COUNT(*) as count FROM diary_attachments WHERE userId = ? AND diaryId IS NULL AND workspaceId IS NULL",
      );
  const orphanCount = (
    scope.scope === "workspace"
      ? (orphanCountQuery.get(userId, scope.workspaceId) as any)
      : (orphanCountQuery.get(userId) as any)
  ).count;
  if (orphanCount >= 50) {
    return c.json(
      { error: "上传过于频繁，请稍后再试", code: "TOO_MANY_PENDING" },
      429,
    );
  }

  ensureAttachmentsDir();
  const id = crypto.randomUUID();
  const ext = MIME_TO_EXT[mime] || DIARY_VIDEO_MIME_TO_EXT[mime] || "bin";
  const filename = `${id}.${ext}`;

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeAttachmentObject(filename, buffer, mime);
  } catch (err: any) {
    return c.json({ error: `写入文件失败: ${err?.message || err}` }, 500);
  }

  try {
    db.prepare(
      `INSERT INTO diary_attachments (id, diaryId, userId, workspaceId, mimeType, size, path)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    ).run(id, userId, scope.workspaceId, mime, file.size, filename);
  } catch (err: any) {
    try {
      await deleteAttachmentObject(filename);
    } catch {
      /* ignore */
    }
    return c.json({ error: `写入数据库失败: ${err?.message || err}` }, 500);
  }

  return c.json(
    {
      id,
      url: `/api/diary/attachments/${id}`,
      mimeType: mime,
      size: file.size,
      filename: file.name || filename,
      type: mediaType,
    },
    201,
  );
});

/**
 * 删除一张悬空（未绑定 diary）的图片。前端在用户预览时点 × 会调用此接口。
 * 已绑定 diary 的图片不允许通过这里删除（要走 DELETE /api/diary/:id 整条删）。
 */
diary.delete("/attachments/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const row = db
    .prepare(
      "SELECT id, userId, diaryId, path FROM diary_attachments WHERE id = ?",
    )
    .get(id) as
    | { id: string; userId: string; diaryId: string | null; path: string }
    | undefined;
  if (!row) return c.json({ error: "图片不存在" }, 404);
  if (row.userId !== userId) {
    return c.json({ error: "无权删除该图片" }, 403);
  }
  if (row.diaryId) {
    return c.json(
      { error: "图片已发布，请删除整条说说", code: "ALREADY_BOUND" },
      400,
    );
  }

  try {
    await deleteAttachmentObject(row.path);
  } catch {
    /* 磁盘删失败不阻塞 DB 删 */
  }
  db.prepare("DELETE FROM diary_attachments WHERE id = ?").run(id);
  return c.json({ success: true });
});

// ===========================================================================
// 下载（不走 JWT；index.ts 会显式挂在 JWT 之前）
// ===========================================================================

/**
 * 下载一个说说媒体附件。授权模型同 attachments.handleDownloadAttachment：
 *   - id 是 uuid，不可枚举即天然权限；
 *   - <img> 标签拿不到 Authorization header 所以不能走 JWT；
 *   - 浏览器可以走长缓存（uuid 文件名不可变）。
 */
export async function handleDownloadDiaryImage(c: Context): Promise<Response> {
  const id = c.req.param("id");
  const db = getDb();
  const row = db
    .prepare("SELECT id, mimeType, path FROM diary_attachments WHERE id = ?")
    .get(id) as { id: string; mimeType: string; path: string } | undefined;
  if (!row) return c.json({ error: "媒体不存在" }, 404);

  const buffer = await readAttachmentObject(row.path);
  if (!buffer) {
    return c.json({ error: "media file missing" }, 404);
  }
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": row.mimeType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ===========================================================================
// 孤儿清理// 孤儿清理：进程启动时跑一次 + 每 6 小时跑一次
//   清理超过 ORPHAN_TTL_MS 仍未绑定 diaryId 的悬空附件（DB 行 + 磁盘文件）。
//   这里用 setInterval 而不是 cron，单进程部署够用；多进程部署只会有一个把活干掉，
//   重复执行也是幂等的（已删的找不到行就跳过），无副作用。
// ===========================================================================
async function sweepOrphanDiaryImages(): Promise<number> {
  try {
    const db = getDb();
    const cutoffIso = new Date(Date.now() - ORPHAN_TTL_MS)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const orphans = db
      .prepare(
        `SELECT id FROM diary_attachments
          WHERE diaryId IS NULL AND createdAt < ?`,
      )
      .all(cutoffIso) as { id: string }[];
    if (!orphans.length) return 0;
    const ids = orphans.map((o) => o.id);
    const removed = await deleteDiaryMediaFilesByIds(ids);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM diary_attachments WHERE id IN (${placeholders})`,
    ).run(...ids);
    if (removed > 0) {
      console.log(
        `[diary] swept ${ids.length} orphan diary images (unlinked ${removed} files)`,
      );
    }
    return ids.length;
  } catch (err) {
    console.warn("[diary] sweepOrphanDiaryImages failed:", err);
    return 0;
  }
}

// 启动后延后 30 秒跑第一次（避开服务刚起来时的拥塞），之后每 6 小时一次
setTimeout(() => void sweepOrphanDiaryImages(), 30_000);
setInterval(() => void sweepOrphanDiaryImages(), 6 * 60 * 60 * 1000);

export default diary;
