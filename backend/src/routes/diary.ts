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
import fs from "fs";
import path from "path";
import {
  ensureAttachmentsDir,
  getAttachmentsDir,
  MIME_TO_EXT,
} from "./attachments";
import {
  getUserWorkspaceRole,
  canManageResource,
  requireWorkspaceFeature,
} from "../middleware/acl";
import { createMentions, broadcastToWorkspace } from "../lib/mentions";
import { ensureRunning, resetIdleTimer } from "../services/sensevoice-manager";

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

// 单张图片大小上限（字节）。比 notes 的 50MB 更保守，因为说说量大、不应被截图怼爆磁盘
const MAX_DIARY_IMAGE_SIZE = 10 * 1024 * 1024;

// 允许的图片 MIME（与 attachments 路由对齐，但不收 svg —— 防止 XSS 飘到时间线）
const ALLOWED_DIARY_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "audio/webm",
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/aac",
  "audio/m4a",
  "audio/x-m4a",
  "audio/mp4",
]);

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
  visibility: string;
  voice: string | null;
  createdAt: string;
  creatorName?: string | null;
  tagsJson?: string | null;
}

function rowToDiary(row: DiaryRow) {
  let images: string[] = [];
  try {
    const parsed = JSON.parse(row.images || "[]");
    if (Array.isArray(parsed)) {
      images = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* 旧数据脏 → 当作没图，避免接口 500 */
  }

  let voice = null;
  if (row.voice) {
    try {
      voice = JSON.parse(row.voice);
    } catch {
      /* ignore */
    }
  }

  const tags = row.tagsJson ? JSON.parse(row.tagsJson) : [];

  return {
    id: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    contentText: row.contentText,
    mood: row.mood,
    images,
    visibility: row.visibility || "PRIVATE",
    voice,
    createdAt: row.createdAt,
    creatorName: row.creatorName ?? null,
    tags,
  };
}

// ---------------------------------------------------------------------------
// 工具：删除一组 diary_attachments 行对应的磁盘文件
//   外键 ON DELETE CASCADE 只清 DB 行，磁盘文件需要手动收拾，否则积累孤儿。
//   返回真正 unlink 成功的文件数（仅用于日志）。
// ---------------------------------------------------------------------------
function deleteDiaryImageFilesByIds(ids: string[]): number {
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
  const dir = getAttachmentsDir();
  for (const r of rows) {
    if (!r?.path) continue;
    const abs = path.join(dir, r.path);
    try {
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        removed++;
      }
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
 *   body: { contentText: string, mood?: string, images?: string[] }
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
  const { contentText, mood, visibility, voice, createdAt, tagIds = [] } = body;
  const rawImages = Array.isArray(body.images) ? body.images : [];
  const images: string[] = rawImages
    .filter((x: unknown) => typeof x === "string")
    .slice(0, MAX_IMAGES_PER_DIARY);

  // 内容、图片、语音至少一项非空
  const hasText = typeof contentText === "string" && contentText.trim().length > 0;
  const hasVoice = voice && typeof voice.id === "string";
  if (!hasText && images.length === 0 && !hasVoice) {
    return c.json({ error: "Content, images, or voice recording is required" }, 400);
  }

  const id = crypto.randomUUID();
  const customCreatedAt = typeof createdAt === "string" ? createdAt : null;

  // 把整批写入放进事务：要么 diary 行 + 图片/语音 attach 一起成功，要么全部回滚
  const tx = db.transaction(() => {
    if (customCreatedAt) {
      db.prepare(
        "INSERT INTO diaries (id, userId, workspaceId, contentText, mood, images, visibility, voice, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        userId,
        scope.workspaceId,
        hasText ? contentText.trim() : "",
        typeof mood === "string" ? mood : "",
        JSON.stringify(images),
        typeof visibility === "string" ? visibility : "PRIVATE",
        hasVoice ? JSON.stringify(voice) : null,
        customCreatedAt,
      );
    } else {
      db.prepare(
        "INSERT INTO diaries (id, userId, workspaceId, contentText, mood, images, visibility, voice) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        userId,
        scope.workspaceId,
        hasText ? contentText.trim() : "",
        typeof mood === "string" ? mood : "",
        JSON.stringify(images),
        typeof visibility === "string" ? visibility : "PRIVATE",
        hasVoice ? JSON.stringify(voice) : null,
      );
    }

    if (hasVoice) {
      db.prepare(
        `UPDATE diary_attachments
            SET diaryId = ?, workspaceId = ?
          WHERE id = ?
            AND userId = ?
            AND diaryId IS NULL`,
      ).run(id, scope.workspaceId, voice.id, userId);
    }

    if (images.length > 0) {
      // 只 attach 真正"属于本人 + 仍悬空"的图片，杜绝越权 / 重复绑定。
      // 然后再读回真实更新成功的 id 列表覆写 images 字段，防止前端塞进无效 uuid
      // 后展示时拉到 404。
      // Y2: 同时把 diary_attachments.workspaceId 对齐到目标 scope，保持附件
      //     与说说的工作区归属一致（便于按工作区统计磁盘占用、清理）。
      const placeholders = images.map(() => "?").join(",");
      const upd = db.prepare(
        `UPDATE diary_attachments
            SET diaryId = ?, workspaceId = ?
          WHERE id IN (${placeholders})
            AND userId = ?
            AND diaryId IS NULL`,
      );
      upd.run(id, scope.workspaceId, ...images, userId);

      const validRows = db
        .prepare(
          `SELECT id FROM diary_attachments
            WHERE id IN (${placeholders}) AND userId = ? AND diaryId = ?`,
        )
        .all(...images, userId, id) as { id: string }[];
      const validIds = validRows.map((r) => r.id);
      // 保留前端传入的顺序（朋友圈宫格的视觉顺序由用户决定）
      const orderedValid = images.filter((i) => validIds.includes(i));
      if (orderedValid.length !== images.length) {
        db.prepare("UPDATE diaries SET images = ? WHERE id = ?").run(
          JSON.stringify(orderedValid),
          id,
        );
      }
    }

    if (Array.isArray(tagIds) && tagIds.length > 0) {
      const insertTag = db.prepare("INSERT INTO diary_tags (diaryId, tagId) VALUES (?, ?)");
      for (const tagId of tagIds) {
        insertTag.run(id, tagId);
      }
    }
  });

  try {
    tx();
  } catch (err: any) {
    return c.json({ error: `发布失败：${err?.message || err}` }, 500);
  }

  // 解析 @提及
  if (hasText) {
    try {
      createMentions("diary", id, contentText.trim().slice(0, 80), contentText.trim(), userId);
      // 通知工作区成员
      if (scope.workspaceId && contentText.trim()) {
        broadcastToWorkspace(
          scope.workspaceId, "diary_posted", "diary", id,
          contentText.trim().slice(0, 80), userId, userId,
        );
      }
    } catch (e) {
      console.warn("[diary.post] createMentions failed:", e);
    }
  }

  const created = db.prepare(`
    SELECT diaries.*, users.username AS creatorName,
           (SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color))
            FROM tags t
            JOIN diary_tags dt ON t.id = dt.tagId
            WHERE dt.diaryId = diaries.id) AS tagsJson
    FROM diaries LEFT JOIN users ON users.id = diaries.userId
    WHERE diaries.id = ?
  `).get(id) as DiaryRow;
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
  visibilityFilter?: string,
  tagId?: string | null,
  search?: string | null,
): { sql: string; args: unknown[] } {
  let sql: string;
  const args: unknown[] = [];
  const filter = visibilityFilter || "all";

  if (scope.scope === "workspace") {
    sql = "diaries.workspaceId = ?";
    args.push(scope.workspaceId);
  } else {
    sql = "diaries.workspaceId IS NULL";
  }

  if (filter === "private") {
    sql += " AND diaries.userId = ? AND diaries.visibility = 'PRIVATE'";
    args.push(userId);
  } else if (filter === "public") {
    sql += " AND diaries.visibility = 'PUBLIC'";
  } else {
    sql += " AND (diaries.userId = ? OR diaries.visibility = 'PUBLIC')";
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
  if (tagId) {
    sql += " AND diaries.id IN (SELECT diaryId FROM diary_tags WHERE tagId = ?)";
    args.push(tagId);
  }
  if (search && search.trim() !== "") {
    sql += " AND diaries.contentText LIKE ?";
    args.push(`%${search.trim()}%`);
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
  const visibilityFilter = c.req.query("visibility"); // 'all' | 'private' | 'public'
  const tagId = c.req.query("tagId");
  const search = c.req.query("search");

  const scope = resolveDiaryScope(c, userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const { sql: whereSql, args } = buildTimeRangeWhere(scope, userId, from, to, visibilityFilter, tagId, search);
  let finalWhere = whereSql;
  const finalArgs = [...args];
  if (cursor) {
    // 带 diaries. 前缀：因为本 SELECT 与 users 表 LEFT JOIN，避免 createdAt 歧义。
    finalWhere += " AND diaries.createdAt < ?";
    finalArgs.push(cursor);
  }

  const selectFields = `diaries.*, users.username AS creatorName,
    (SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color))
     FROM tags t
     JOIN diary_tags dt ON t.id = dt.tagId
     WHERE dt.diaryId = diaries.id) AS tagsJson`;

  const rows = db
    .prepare(
      `SELECT ${selectFields}
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
    const newImagesRaw: string[] | undefined = Array.isArray(body.images)
      ? body.images
          .filter((x: unknown) => typeof x === "string")
          .slice(0, MAX_IMAGES_PER_DIARY)
      : undefined;
    const newVisibility: string | undefined =
      typeof body.visibility === "string" ? body.visibility : undefined;
    const newVoice: any | undefined =
      body.voice !== undefined ? body.voice : undefined;
    const newTagIds: string[] | undefined = Array.isArray(body.tagIds) ? body.tagIds : undefined;

    // 计算合并后的最终值（仅用来做"text, images, voice 至少一项非空"校验）
    const finalText = newContentText !== undefined ? newContentText : row.contentText;
    const finalImagesPreview =
      newImagesRaw !== undefined ? newImagesRaw : (() => {
        try {
          const parsed = JSON.parse(row.images || "[]");
          return Array.isArray(parsed) ? parsed.filter((x: unknown) => typeof x === "string") : [];
        } catch {
          return [];
        }
      })();
    const finalVoice = newVoice !== undefined ? newVoice : (() => {
      try {
        return row.voice ? JSON.parse(row.voice) : null;
      } catch {
        return null;
      }
    })();
    const hasFinalVoice = finalVoice && typeof finalVoice.id === "string";

    if (!finalText && finalImagesPreview.length === 0 && !hasFinalVoice) {
      return c.json({ error: "Content, images, or voice recording is required" }, 400);
    }

    // 如果调用方没改任何字段，直接回当前值（幂等）
    if (
      newContentText === undefined &&
      newMood === undefined &&
      newImagesRaw === undefined &&
      newVisibility === undefined &&
      newVoice === undefined &&
      newTagIds === undefined
    ) {
      // 顺手加载已有 tags
      const currentTags = db.prepare(`
        SELECT t.* FROM tags t
        JOIN diary_tags dt ON t.id = dt.tagId
        WHERE dt.diaryId = ?
      `).all(id);
      return c.json({ ...rowToDiary(row), tags: currentTags });
    }

    // 准备图片差集（仅当调用方显式传入 images 时才处理）
    let toUnlinkIds: string[] = [];
    let finalImageOrder: string[] = [];
    if (newImagesRaw !== undefined) {
      // 当前已绑定的图片
      const currentRows = db
        .prepare(
          "SELECT id FROM diary_attachments WHERE diaryId = ? AND userId = ?",
        )
        .all(id, userId) as { id: string }[];
      const currentIds = new Set(currentRows.map((r) => r.id));
      const targetIds = new Set(newImagesRaw);
      toUnlinkIds = [...currentIds].filter((x) => !targetIds.has(x));
      finalImageOrder = newImagesRaw; // 顺序由调用方指定，但下面会被"实际仍存在"过滤
    }

    const tx = db.transaction(() => {
      // 1) 处理图片：先 unlink + 删除文件，再 attach 新图
      if (newImagesRaw !== undefined) {
        if (toUnlinkIds.length > 0) {
          // 先删盘（DB 行还在的时候才能查到 path），再删 DB 行
          deleteDiaryImageFilesByIds(toUnlinkIds);
          const ph = toUnlinkIds.map(() => "?").join(",");
          db.prepare(
            `DELETE FROM diary_attachments WHERE id IN (${ph}) AND diaryId = ? AND userId = ?`,
          ).run(...toUnlinkIds, id, userId);
        }
        // attach 新增的悬空图片到该 diary（顺序保留交给最后一步覆写 images 字段）
        const newOnes = newImagesRaw.filter((x) => !toUnlinkIds.includes(x));
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
        // 取真正属于本 diary 的图片，按调用方传入顺序排序覆写
        const validRows = db
          .prepare(
            `SELECT id FROM diary_attachments WHERE diaryId = ? AND userId = ?`,
          )
          .all(id, userId) as { id: string }[];
        const validSet = new Set(validRows.map((r) => r.id));
        finalImageOrder = newImagesRaw.filter((x) => validSet.has(x));
      }

      // 1.5) 处理语音更新
      if (newVoice !== undefined) {
        let oldVoiceId: string | null = null;
        if (row.voice) {
          try {
            const parsed = JSON.parse(row.voice);
            if (parsed && parsed.id) oldVoiceId = parsed.id;
          } catch {}
        }
        const newVoiceId = newVoice ? newVoice.id : null;
        if (oldVoiceId && oldVoiceId !== newVoiceId) {
          deleteDiaryImageFilesByIds([oldVoiceId]);
          db.prepare(
            `DELETE FROM diary_attachments WHERE id = ? AND diaryId = ? AND userId = ?`,
          ).run(oldVoiceId, id, userId);
        }
        if (newVoiceId && oldVoiceId !== newVoiceId) {
          db.prepare(
            `UPDATE diary_attachments
                SET diaryId = ?, workspaceId = ?
              WHERE id = ?
                AND userId = ?
                AND diaryId IS NULL`,
          ).run(id, row.workspaceId, newVoiceId, userId);
        }
      }

      if (newTagIds !== undefined) {
        db.prepare("DELETE FROM diary_tags WHERE diaryId = ?").run(id);
        if (newTagIds.length > 0) {
          const insertTag = db.prepare("INSERT INTO diary_tags (diaryId, tagId) VALUES (?, ?)");
          for (const tagId of newTagIds) {
            insertTag.run(id, tagId);
          }
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
      if (newImagesRaw !== undefined) {
        updates.push("images = ?");
        args.push(JSON.stringify(finalImageOrder));
      }
      if (newVisibility !== undefined) {
        updates.push("visibility = ?");
        args.push(newVisibility);
      }
      if (newVoice !== undefined) {
        updates.push("voice = ?");
        args.push(newVoice ? JSON.stringify(newVoice) : null);
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

    // 解析 @提及（内容变更时）
    if (newContentText) {
      try {
        createMentions("diary", id, newContentText.slice(0, 80), newContentText, userId);
      } catch (e) {
        console.warn("[diary.put] createMentions failed:", e);
      }
    }

    // 返回更新后的整条记录（顺手 LEFT JOIN 取 creatorName 保持契约一致）
    const updated = db
      .prepare(
        `SELECT diaries.*, users.username AS creatorName,
                (SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color))
                 FROM tags t
                 JOIN diary_tags dt ON t.id = dt.tagId
                 WHERE dt.diaryId = diaries.id) AS tagsJson
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
diary.delete("/:id", (c) => {
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

  // 必须**先**删磁盘文件，再删 DB（删 DB 后 path 就查不到了）
  deleteDiaryImageFilesByIds(imgIds);

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

/**
 * 获取日历数据：返回指定月份有说说的日期列表
 *   GET /api/diary/calendar?year=2026&month=6
 *   query: workspaceId?  (personal / <uuid>)
 */
diary.get("/calendar", requireWorkspaceFeature("diaries"), (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const year = parseInt(c.req.query("year") || "0");
  const month = parseInt(c.req.query("month") || "0");
  const tagId = c.req.query("tagId");
  const search = c.req.query("search");

  if (year < 2000 || year > 2100 || month < 1 || month > 12) {
    return c.json({ error: "参数错误" }, 400);
  }

  const scope = resolveDiaryScope(c, userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  // 计算该月起止时间
  const pad = (n: number) => n.toString().padStart(2, "0");
  const fromStr = `${year}-${pad(month)}-01 00:00:00`;
  // 下个月第一天
  const nextM = month === 12 ? 1 : month + 1;
  const nextY = month === 12 ? year + 1 : year;
  const toStr = `${nextY}-${pad(nextM)}-01 00:00:00`;

  // 复用可见性逻辑：只查时间范围内的日期（不做 page 级 join，轻量）
  let whereSql: string;
  const args: unknown[] = [];

  if (scope.scope === "workspace") {
    whereSql = "diaries.workspaceId = ?";
    args.push(scope.workspaceId);
  } else {
    whereSql = "diaries.workspaceId IS NULL";
  }

  whereSql += " AND (diaries.userId = ? OR diaries.visibility = 'PUBLIC')";
  args.push(userId);

  whereSql += " AND diaries.createdAt >= ? AND diaries.createdAt < ?";
  args.push(fromStr, toStr);

  if (tagId) {
    whereSql += " AND diaries.id IN (SELECT diaryId FROM diary_tags WHERE tagId = ?)";
    args.push(tagId);
  }

  if (search && search.trim() !== "") {
    whereSql += " AND diaries.contentText LIKE ?";
    args.push(`%${search.trim()}%`);
  }

  const rows = db
    .prepare(
      `SELECT DISTINCT SUBSTR(diaries.createdAt, 1, 10) as d
       FROM diaries WHERE ${whereSql}
       ORDER BY d ASC`,
    )
    .all(...args) as { d: string }[];

  const dates = rows.map((r) => r.d);
  return c.json({ dates, year, month });
});

// ===========================================================================
// 说说图片上传（受 JWT 保护）
//   挂在 /api/diary/attachments，返回的 url 走下面 handleDownloadDiaryImage。
// ===========================================================================

/**
 * 上传一张说说图片。
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

  if (file.size > MAX_DIARY_IMAGE_SIZE) {
    return c.json(
      { error: `文件过大（最大 ${MAX_DIARY_IMAGE_SIZE / 1024 / 1024}MB）` },
      413,
    );
  }
  const mime = (file.type || "application/octet-stream").toLowerCase();
  if (!ALLOWED_DIARY_MIMES.has(mime)) {
    return c.json({ error: `不支持的 MIME 类型: ${mime}` }, 415);
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
  const ext = MIME_TO_EXT[mime] || "bin";
  const filename = `${id}.${ext}`;
  const savePath = path.join(getAttachmentsDir(), filename);

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(savePath, buffer);
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
      fs.unlinkSync(savePath);
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
    },
    201,
  );
});

/**
 * 删除一张悬空（未绑定 diary）的图片。前端在用户预览时点 × 会调用此接口。
 * 已绑定 diary 的图片不允许通过这里删除（要走 DELETE /api/diary/:id 整条删）。
 */
diary.delete("/attachments/:id", (c) => {
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

  const abs = path.join(getAttachmentsDir(), row.path);
  try {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
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
 * 下载一张说说图片。授权模型同 attachments.handleDownloadAttachment：
 *   - id 是 uuid，不可枚举即天然权限；
 *   - <img> 标签拿不到 Authorization header 所以不能走 JWT；
 *   - 浏览器可以走长缓存（uuid 文件名不可变）。
 */
export function handleDownloadDiaryImage(c: Context): Response {
  const id = c.req.param("id");
  const db = getDb();
  const row = db
    .prepare("SELECT id, mimeType, path FROM diary_attachments WHERE id = ?")
    .get(id) as { id: string; mimeType: string; path: string } | undefined;
  if (!row) return c.json({ error: "图片不存在" }, 404);

  const absPath = path.join(getAttachmentsDir(), row.path);
  if (!fs.existsSync(absPath)) {
    return c.json({ error: "图片文件丢失" }, 404);
  }

  const buffer = fs.readFileSync(absPath);
  return new Response(buffer, {
    headers: {
      "Content-Type": row.mimeType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// ===========================================================================
// 孤儿清理：进程启动时跑一次 + 每 6 小时跑一次
//   清理超过 ORPHAN_TTL_MS 仍未绑定 diaryId 的悬空附件（DB 行 + 磁盘文件）。
//   这里用 setInterval 而不是 cron，单进程部署够用；多进程部署只会有一个把活干掉，
//   重复执行也是幂等的（已删的找不到行就跳过），无副作用。
// ===========================================================================
function sweepOrphanDiaryImages(): number {
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
    const removed = deleteDiaryImageFilesByIds(ids);
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
setTimeout(sweepOrphanDiaryImages, 30_000);
setInterval(sweepOrphanDiaryImages, 6 * 60 * 60 * 1000);

/**
 * 语音消息转文字 (Speech-to-Text)
 *   POST /api/diary/transcribe
 *   body: { diaryId: string, voiceId: string }
 */
diary.post("/transcribe", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const { diaryId, voiceId } = body;
  if (!diaryId || !voiceId) {
    return c.json({ error: "diaryId and voiceId required" }, 400);
  }

  // 1) 校验说说权限
  const diaryRow = db
    .prepare("SELECT * FROM diaries WHERE id = ?")
    .get(diaryId) as DiaryRow | undefined;
  if (!diaryRow) return c.json({ error: "说说不存在" }, 404);

  if (!canManageResource(diaryRow.userId, diaryRow.workspaceId, userId)) {
    // 允许同一个工作区的成员读取（转文字）
    const wsRole = diaryRow.workspaceId ? getUserWorkspaceRole(diaryRow.workspaceId, userId) : null;
    if (!wsRole && diaryRow.userId !== userId && diaryRow.visibility !== "PUBLIC") {
      return c.json({ error: "无权访问该说说", code: "FORBIDDEN" }, 403);
    }
  }

  // 2) 如果已经转过文字，直接返回
  if (diaryRow.voice) {
    try {
      const parsed = JSON.parse(diaryRow.voice);
      if (parsed && parsed.text) {
        return c.json({ text: parsed.text });
      }
    } catch {}
  }

  // 3) 查找语音附件
  const attachRow = db
    .prepare("SELECT path FROM diary_attachments WHERE id = ? AND diaryId = ?")
    .get(voiceId, diaryId) as { path: string } | undefined;
  if (!attachRow) {
    return c.json({ error: "语音附件不存在" }, 404);
  }

  const absPath = path.join(getAttachmentsDir(), attachRow.path);
  if (!fs.existsSync(absPath)) {
    return c.json({ error: "语音文件不存在" }, 404);
  }

  // 4) 确保 SenseVoice 服务在线（按需启动容器，~330MB 用完即释放）
  try {
    await ensureRunning();
  } catch (e: any) {
    return c.json({ error: `语音服务启动失败: ${e?.message || e}` }, 503);
  }

  // 5) 请求 SenseVoice FastAPI 接口
  try {
    const fileBuffer = fs.readFileSync(absPath);
    const blob = new Blob([fileBuffer]);
    const formData = new FormData();
    formData.append("file", blob, path.basename(attachRow.path));
    formData.append("model", "whisper-1");

    const response = await fetch("http://sensevoice:8000/v1/audio/transcriptions", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text();
      return c.json({ error: `SenseVoice error: ${response.status} ${errText}` }, 502);
    }

    const resJson = await response.json() as { text: string };
    const text = resJson.text || "";

    // 5) 更新 diaries 的 voice 字段以缓存转写出的文字
    let voiceObj: any = {};
    if (diaryRow.voice) {
      try {
        voiceObj = JSON.parse(diaryRow.voice);
      } catch {}
    }
    voiceObj.text = text;

    db.prepare("UPDATE diaries SET voice = ? WHERE id = ?").run(
      JSON.stringify(voiceObj),
      diaryId,
    );

    try { resetIdleTimer(); } catch {}

    return c.json({ text });
  } catch (err: any) {
    console.error("Transcription error:", err);
    return c.json({ error: `转文字失败: ${err?.message || err}` }, 500);
  }
});

export default diary;
