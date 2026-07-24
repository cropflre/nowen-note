import { Hono } from "hono";
import { projectMarkdownNoteForUser } from "../lib/markdownUserContent";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import { emitWebhook } from "../services/webhook";
import { logAudit } from "../services/audit";
import {
  resolveNotePermission,
  resolveNotebookPermission,
  hasPermission,
  getUserWorkspaceRole,
  hasRole,
} from "../middleware/acl";
import { broadcastNoteUpdated, broadcastNoteDeleted, broadcastYjsUpdate, broadcastToUser } from "../services/realtime";
import {
  yApplySubdocumentUpdate,
  yDestroyDoc,
  yFlush,
  yGetSubdocumentState,
  yPrepareSubdocuments,
  yReplaceContentAsUpdate,
} from "../services/yjs";
import {
  isYjsSubdocumentsEnabled,
  SubdocumentGenerationConflictError,
} from "../services/yjs-subdocuments";
import { deleteAttachmentFilesByNoteIds, extractInlineBase64Images } from "./attachments";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import { syncNoteLinks, getBacklinks } from "../lib/noteLinks";
import { syncNoteBlocks } from "../lib/noteBlocks";
import {
  readAuthoritativeNoteContent,
  readBlockAuthorityHistory,
  rebuildBlockAuthorityStore,
} from "../lib/blockAuthorityStore";
import { resolveBlockAuthorityMode, selectBlockAuthorityRead } from "../lib/blockAuthorityMode";
import { extractSearchableText } from "../lib/searchIndex";
import { syncAutomaticNoteLinkTitles } from "../lib/noteLinkTitles";
import { noteLinksRepository, noteTagsRepository, noteVersionsRepository, favoritesRepository, noteYsnapshotsRepository, noteYupdatesRepository } from "../repositories";
import { rebuildYjsSubdocumentsIfEnabled } from "../services/yjs-subdocuments";
import { reclaimSpace } from "../lib/reclaimSpace";
import { buildFtsSearchTerm } from "../lib/searchQuery";

const app = new Hono();

function wantsInternalNoteContent(c: any): boolean {
  return c.req.header("X-Nowen-Content-View") === "internal";
}

function presentNoteForResponse(db: any, c: any, note: any): any {
  if (!note || wantsInternalNoteContent(c)) return note;
  return projectMarkdownNoteForUser(db, note);
}

/**
 * 获取笔记列表
 *
 * workspaceId 查询参数（Phase 1 新增）：
 *   未传       → 兼容模式，返回用户个人空间笔记
 *   'personal' → 显式个人空间
 *   <id>       → 指定工作区（要求成员身份）
 */
app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const workspaceId = c.req.query("workspaceId");
  const notebookId = c.req.query("notebookId");
  const isFavorite = c.req.query("isFavorite");
  const isTrashed = c.req.query("isTrashed");
  const search = c.req.query("search");
  const tagId = c.req.query("tagId");
  // TAG-FILTER-MULTI-01: 支持多标签联合筛选
  // 优先使用 tagIds（逗号分隔），回退到单个 tagId
  const tagIdsRaw = c.req.query("tagIds");
  const tagIds: string[] = tagIdsRaw
    ? tagIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : tagId
    ? [tagId]
    : [];
  const tagMode = c.req.query("tagMode") || "and"; // "and"（默认）或 "or"
  const dateFrom = c.req.query("dateFrom"); // YYYY-MM-DD
  const dateTo = c.req.query("dateTo");     // YYYY-MM-DD
  // 排序：sortBy ∈ {manual, updatedAt, createdAt, title}；sortOrder ∈ {asc, desc}
  // - manual（默认）：保持历史行为 isPinned DESC, sortOrder ASC, updatedAt DESC，
  //   保留拖拽排序结果；
  // - 其他字段：忽略 sortOrder 字段（不影响置顶），按选定字段方向排序，置顶仍优先；
  //   title 排序对中文用 NOCASE 仅做大小写不敏感，中文按 UTF-8 字节序——可接受。
  const sortByRaw = c.req.query("sortBy");
  const sortOrderRaw = c.req.query("sortOrder");
  const sortBy: "manual" | "updatedAt" | "createdAt" | "title" =
    sortByRaw === "updatedAt" || sortByRaw === "createdAt" || sortByRaw === "title"
      ? sortByRaw
      : "manual";
  const sortDir: "ASC" | "DESC" = sortOrderRaw === "asc" ? "ASC" : "DESC";

  // Phase 2/Y1: isFavorite 不再来自 notes 列，而是按"当前请求用户是否在 favorites 表中收藏"
  // 动态计算（EXISTS 子查询，结果仍是 0/1，前端契约 Note.isFavorite: number 不变）。
  // 这样同一条工作区笔记在不同成员视角下的收藏状态互不影响。
  //
  // creatorName: LEFT JOIN users 取创建者用户名。
  //   - 工作区下笔记可由不同成员创建，前端列表需要标注"谁建的"，避免每个客户端再
  //     按 userId 反查成员表；
  //   - LEFT JOIN（而非 INNER JOIN）兜底"用户已被删除但 ON DELETE CASCADE 还没跑完"
  //     的极端窗口期 → 名字给 null，前端按"未知用户"渲染；
  //   - users.username 已有 UNIQUE 索引，单行 join 代价可忽略。
  let query = `SELECT notes.id, notes.userId, notes.notebookId, notes.workspaceId, notes.title,
    notes.contentText, notes.isPinned,
    CASE WHEN EXISTS(SELECT 1 FROM favorites f WHERE f.noteId = notes.id AND f.userId = ?) THEN 1 ELSE 0 END AS isFavorite,
    notes.isLocked, notes.isArchived, notes.isTrashed, notes.version, notes.sortOrder,
    notes.createdAt, notes.updatedAt,
    notes.contentFormat,
    users.username AS creatorName
    FROM notes
    LEFT JOIN users ON users.id = notes.userId
    WHERE 1=1`;
  const params: any[] = [userId];
  const useNotebookScope =
    Boolean(notebookId) && !search && isTrashed !== "1" && isFavorite !== "1" && tagIds.length === 0;

  // Scope 过滤
  if (useNotebookScope && notebookId) {
    const { permission } = resolveNotebookPermission(notebookId, userId);
    if (!hasPermission(permission, "read")) {
      return c.json({ error: "Notebook not found or forbidden" }, 404);
    }
  } else if (workspaceId && workspaceId !== "personal") {
    // 指定工作区：必须是成员
    const role = getUserWorkspaceRole(workspaceId, userId);
    if (!role) return c.json({ error: "无权访问该工作区" }, 403);
    query += " AND notes.workspaceId = ?";
    params.push(workspaceId);
  } else {
    // 个人空间（默认或 'personal'）
    query += " AND notes.userId = ? AND notes.workspaceId IS NULL";
    params.push(userId);
  }

  if (search) {
    const searchTerm = buildFtsSearchTerm(search);
    if (!searchTerm) return c.json([]);
    const ftsResults = db.prepare(`
      SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?
    `).all(searchTerm) as { rowid: number }[];
    if (ftsResults.length === 0) return c.json([]);
    const rowids = ftsResults.map((r) => r.rowid).join(",");
    query += ` AND notes.rowid IN (${rowids})`;
  } else if (isTrashed === "1") {
    query += " AND notes.isTrashed = 1";
  } else if (isFavorite === "1") {
    // Y1: 收藏过滤从"notes.isFavorite = 1"改为"当前用户在 favorites 中有该笔记记录"
    query += ` AND notes.isTrashed = 0
      AND EXISTS(SELECT 1 FROM favorites f2 WHERE f2.noteId = notes.id AND f2.userId = ?)`;
    params.push(userId);
  } else if (tagIds.length > 0) {
    query += " AND notes.isTrashed = 0";
    const filteredNoteIds = noteTagsRepository.listNoteIdsByTagFilter(tagIds, tagMode as "and" | "or");
    if (filteredNoteIds.length === 0) {
      // 无匹配标签，直接返回空
      return c.json([]);
    }
    const placeholders = filteredNoteIds.map(() => "?").join(",");
    query += ` AND notes.id IN (${placeholders})`;
    params.push(...filteredNoteIds);
  } else if (notebookId) {
    // 递归收集 notebookId 自身 + 全部后代笔记本，使笔记列表能展示子笔记本下的笔记
    // 用 SQLite 的递归 CTE：从给定 id 出发沿 parentId 反向向下展开
    const descendantRows = db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM notebooks WHERE id = ?
        UNION ALL
        SELECT n.id FROM notebooks n
        INNER JOIN descendants d ON n.parentId = d.id
      )
      SELECT id FROM descendants
    `).all(notebookId) as { id: string }[];
    const ids = descendantRows.map((r) => r.id);
    if (ids.length === 0) {
      // 给的 notebookId 不存在 → 直接返回空，避免 IN () 语法错误
      return c.json([]);
    }
    const placeholders = ids.map(() => "?").join(",");
    query += ` AND notes.notebookId IN (${placeholders}) AND notes.isTrashed = 0`;
    params.push(...ids);
  } else {
    query += " AND notes.isTrashed = 0";
  }

  // 日期范围筛选
  if (dateFrom) {
    query += " AND notes.updatedAt >= ?";
    params.push(dateFrom + " 00:00:00");
  }
  if (dateTo) {
    query += " AND notes.updatedAt <= ?";
    params.push(dateTo + " 23:59:59");
  }

  // 拼接 ORDER BY：
  //   - 置顶笔记永远在最前（不参与按字段排序），符合"置顶=固定置顶"语义；
  //   - manual 模式回退到历史行为；
  //   - title 用 COLLATE NOCASE 让 ABC/abc 不分大小写；中文为 UTF-8 字节序，足够稳定；
  //   - 兜底再加 id 让相等键的顺序不抖动。
  if (sortBy === "manual") {
    query += " ORDER BY notes.isPinned DESC, notes.sortOrder ASC, notes.updatedAt DESC, notes.id ASC";
  } else if (sortBy === "title") {
    query += ` ORDER BY notes.isPinned DESC, notes.title COLLATE NOCASE ${sortDir}, notes.id ASC`;
  } else {
    // updatedAt | createdAt
    query += ` ORDER BY notes.isPinned DESC, notes.${sortBy} ${sortDir}, notes.id ASC`;
  }
  const notes = db.prepare(query).all(...params);
  return c.json(notes);
});

// 清空回收站（必须在 /:id 路由之前注册，否则 'trash' 会被当作 :id 参数匹配）
// 批量永久删除当前用户回收站中所有未锁定的笔记（仅个人空间）
app.delete("/trash/empty", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";

  // 仅清理个人空间的回收站；工作区回收站由管理员操作
  const targets = db.prepare(
    "SELECT id FROM notes WHERE userId = ? AND workspaceId IS NULL AND isTrashed = 1 AND isLocked = 0"
  ).all(userId) as { id: string }[];

  const skipped = (db.prepare(
    "SELECT COUNT(*) as count FROM notes WHERE userId = ? AND workspaceId IS NULL AND isTrashed = 1 AND isLocked = 1"
  ).get(userId) as { count: number }).count;

  if (targets.length === 0) {
    return c.json({ success: true, count: 0, skipped, noteIds: [] });
  }

  const ids = targets.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");

  // ⚠ 必须在 DELETE FROM notes 之前清理磁盘附件文件：
  // attachments 表的 ON DELETE CASCADE 只会删 DB 行，磁盘 data/attachments/*.png
  // 不会被自动清理。删完 DB 就再也查不到 path 了。
  let removedFiles = 0;
  try {
    removedFiles = deleteAttachmentFilesByNoteIds(ids);
  } catch (e) {
    console.warn("[notes.trash/empty] deleteAttachmentFilesByNoteIds failed:", e);
  }

  // ⚠ 同理：算"将释放的字节数"也必须在 DELETE 之前，CASCADE 一执行就查不到了。
  // 用 attachments.size + notes 正文长度共同估算，作为 VACUUM 阈值的判定依据。
  let freedBytesEstimate = 0;
  try {
    const attBytes = db
      .prepare(
        `SELECT COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE noteId IN (${placeholders})`,
      )
      .get(...ids) as { bytes: number } | undefined;
    freedBytesEstimate += attBytes?.bytes || 0;
    const noteBytes = db
      .prepare(
        `SELECT COALESCE(SUM(
           COALESCE(LENGTH(content), 0) +
           COALESCE(LENGTH(contentText), 0) +
           COALESCE(LENGTH(title), 0)
         ), 0) AS bytes FROM notes WHERE id IN (${placeholders})`,
      )
      .get(...ids) as { bytes: number } | undefined;
    freedBytesEstimate += noteBytes?.bytes || 0;
  } catch {
    /* ignore — 估算失败就按 0 处理，后续不会触发 VACUUM */
  }

  const deleteMany = db.transaction((list: string[]) => {
    db.prepare(`DELETE FROM notes WHERE id IN (${placeholders})`).run(...list);
  });
  deleteMany(ids);

  // TAG-PRUNE-UNUSED-ON-NOTE-DELETE-01: 清空回收站后清理未使用的标签
  try {
    db.prepare(`
      DELETE FROM tags
      WHERE userId = ?
        AND workspaceId IS NULL
        AND id NOT IN (
          SELECT DISTINCT nt.tagId
          FROM note_tags nt
          JOIN notes n ON n.id = nt.noteId
          WHERE n.userId = ? AND n.isTrashed = 0
        )
    `).run(userId, userId);
  } catch (e) {
    console.warn("[notes.trash/empty] prune unused tags failed:", e);
  }

  // Phase 3: 释放所有被删笔记的内存 Y.Doc（外键 CASCADE 已清数据，这里只清内存）
  for (const id of ids) {
    try { yDestroyDoc(id); } catch {}
  }

  // ---- 回收磁盘空间 ----
  // 背景：SQLite 的 DELETE 只把 page 标成 free，不会归还给操作系统。用户
  // 反馈"清空回收站后占用没减少"，根因就在这里。
  //
  // 策略（由 reclaimSpace 统一实现）：
  //   1) 总是 wal_checkpoint(TRUNCATE)：-wal 文件立刻归零。
  //   2) 总是 incremental_vacuum：把主库里空闲 page 归还给 OS，
  //      .db 文件尺寸真正缩小（依赖连接初始化时的 auto_vacuum=INCREMENTAL）。
  //   3) 仅在本次释放量超过阈值（默认 50MB）时才做全量 VACUUM，避免小删除
  //      背负重写整库的代价。
  const { walTruncated, incrementalVacuumed, vacuumed } = reclaimSpace(db, {
    freedBytesEstimate,
    tag: "notes.trash/empty",
  });

  // SYNC-DELETE-01-B: 向该用户广播每条被永久删除的笔记，让列表页实时移除
  for (const noteId of ids) {
    try { broadcastNoteDeleted(noteId, { actorUserId: userId, trashed: false }); } catch {}
  }

  emitWebhook("note.trash_emptied", userId, { count: ids.length, removedFiles, vacuumed });
  logAudit(userId, "note", "trash_empty", { count: ids.length, noteIds: ids, removedFiles, vacuumed });

  return c.json({
    success: true,
    count: ids.length,
    skipped,
    noteIds: ids,
    removedFiles,
    // 让前端能感知"确实做了 checkpoint / VACUUM"，用于 toast 提示
    walTruncated,
    incrementalVacuumed,
    vacuumed,
    freedBytesEstimate,
  });
});

// 批量更新笔记排序（仅对有 write 权限的笔记生效）
app.put("/reorder/batch", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const items: { id: string; sortOrder: number }[] = body.items;
  if (!Array.isArray(items)) return c.json({ error: "items is required" }, 400);

  const stmt = db.prepare("UPDATE notes SET sortOrder = ? WHERE id = ?");
  const updateMany = db.transaction((list: { id: string; sortOrder: number }[]) => {
    for (const item of list) {
      const { permission } = resolveNotePermission(item.id, userId);
      if (hasPermission(permission, "write")) {
        stmt.run(item.sortOrder, item.id);
      }
    }
  });
  updateMany(items);
  return c.json({ success: true });
});

// 查询 Block 写入历史，只允许具备 read 权限的用户访问。
app.get("/:id/block-history", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("id");
  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "read")) {
    return c.json({ error: "Note not found or forbidden" }, 404);
  }
  const limit = Number(c.req.query("limit"));
  const offset = Number(c.req.query("offset"));
  try {
    return c.json(readBlockAuthorityHistory(db, noteId, {
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    }));
  } catch (error) {
    console.warn("[notes.block-history] corrupted history:", error instanceof Error ? error.message : error);
    return c.json({ error: "Block history is corrupted", code: "BLOCK_HISTORY_CORRUPTED" }, 500);
  }
});

// 获取单个笔记（完整内容）
//
// 性能说明：
//   notes.content 可能包含大量 base64 内联图片（粘贴图片 / 旧数据），单篇可达
//   几十 MB。对于"只想拿 version / 元数据"的场景（比如乐观锁冲突重试），应
//   传 ?slim=1，此时不 SELECT content，也跳过 yFlush，大幅降低延迟和阻塞。
app.get("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const slim = c.req.query("slim") === "1";

  const { permission } = resolveNotePermission(id, userId);
  if (!hasPermission(permission, "read")) {
    return c.json({ error: "Note not found or forbidden" }, 404);
  }

  // Phase 3: 若该笔记有活跃 Y.Doc，先把内存里的最新内容 flush 到磁盘
  // slim 模式不需要 content，因此跳过 flush（flush 本身也要读写大字段，很慢）。
  if (!slim) {
    try { yFlush(id); } catch {}
  }

  // slim 模式：只取元数据字段，不含 content / contentText。
  //   前端在"只想要 version"的路径（optimisticLockApi.makeFetchLatestNoteVersion、
  //   EditorPane 的 409 重试）用这个。
  // Y1: isFavorite 统一按 per-user 动态计算（EXISTS favorites 表），
  //   物理列 notes.isFavorite 已停止写入，不再用作来源。
  const favExpr = `CASE WHEN EXISTS(SELECT 1 FROM favorites f WHERE f.noteId = notes.id AND f.userId = ?) THEN 1 ELSE 0 END AS isFavorite`;
  const selectCols = slim
    ? `id, userId, notebookId, workspaceId, title, isPinned, ${favExpr}, isLocked,
       isArchived, isTrashed, version, sortOrder, createdAt, updatedAt, trashedAt, contentFormat`
    : `id, userId, notebookId, workspaceId, title, content, contentText, isPinned, ${favExpr},
       isLocked, isArchived, isTrashed, version, sortOrder, createdAt, updatedAt, trashedAt, contentFormat`;
  const note = db.prepare(`SELECT ${selectCols} FROM notes WHERE id = ?`).get(userId, id) as any;
  if (!note) return c.json({ error: "Note not found" }, 404);

  if (!slim && typeof note.content === "string") {
    const authoritative = readAuthoritativeNoteContent(db, id, note.content);
    const selected = selectBlockAuthorityRead(resolveBlockAuthorityMode(), authoritative, note.content);
    note.content = selected.content;
    note.blockAuthority = { source: selected.source, status: selected.status };
    if (selected.shouldRepair && ["tiptap-json", "markdown"].includes(note.contentFormat)) {
      try {
        const synced = syncNoteBlocks(db, id, note.content, note.contentFormat);
        if (synced.changed) {
          db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
            .run(synced.content, synced.contentText, id);
          note.content = synced.content;
          note.contentText = synced.contentText;
        }
        rebuildBlockAuthorityStore(db, id, note.content, note.contentFormat, {
          noteVersion: note.version,
          operationType: "read-repair",
        });
        rebuildYjsSubdocumentsIfEnabled(db, id, note.content, note.contentFormat);
        note.blockAuthority.repaired = true;
      } catch (error) {
        console.warn("[notes.get] block authority read repair failed:", error instanceof Error ? error.message : error);
      }
    }
  }

  const tags = noteTagsRepository.listTagsByNoteId(id);

  const responseNote = presentNoteForResponse(db, c, note);
  return c.json({ ...responseNote as any, tags, permission });
});

// 创建笔记
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();

  // 如果指定了 notebookId，必须对其有 write 权限，并从笔记本继承 workspaceId
  let inheritedWorkspaceId: string | null = null;
  if (body.notebookId) {
    const nb = db
      .prepare("SELECT workspaceId, isDeleted FROM notebooks WHERE id = ?")
      .get(body.notebookId) as
      | { workspaceId: string | null; isDeleted: number }
      | undefined;
    if (!nb) return c.json({ error: "笔记本不存在" }, 404);
    // v14：软删的笔记本在回收站里等待永久清理，不允许下发新笔记。
    if (nb.isDeleted === 1) {
      return c.json(
        { error: "笔记本已删除，无法在其下创建笔记", code: "NOTEBOOK_TRASHED" },
        400,
      );
    }
    inheritedWorkspaceId = nb.workspaceId;

    const { permission } = resolveNotebookPermission(body.notebookId, userId);
    if (!hasPermission(permission, "write")) {
      return c.json({ error: "您在该笔记本无创建权限" }, 403);
    }
  }

  // Phase D: 接受 client 提供的 id（用于离线创建场景，前端用 UUID v4 直接生成）。
  //   - 仅校验格式：必须是 UUID v4（避免被注入恶意值，比如路径片段）
  //   - INSERT 时若 id 已存在，SQLite UNIQUE 约束会抛错，下方 try/catch 转 409
  let id: string;
  if (typeof body.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.id)) {
    id = body.id;
  } else {
    id = uuid();
  }
  // contentText 由服务端从正文派生，客户端提交值不再作为索引真源。
  const contentFormat = body.contentFormat === "markdown" ? "markdown"
    : body.contentFormat === "html" ? "html"
    : "tiptap-json";
  const defaultContent = contentFormat === "markdown" ? "# 无标题 Markdown\n\n" : "{}";
  const initialContent = typeof body.content === "string" ? body.content : defaultContent;

  try {
    db.prepare(`
      INSERT INTO notes (id, userId, workspaceId, notebookId, title, content, contentText, contentFormat)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, userId, inheritedWorkspaceId, body.notebookId,
      body.title || "无标题笔记", initialContent,
      extractSearchableText(initialContent, contentFormat), contentFormat,
    );
  } catch (e: any) {
    if (String(e?.code || "").startsWith("SQLITE_CONSTRAINT")) {
      return c.json({ error: "笔记 ID 已存在", code: "NOTE_ID_CONFLICT" }, 409);
    }
    throw e;
  }

  // A2: 自动抽取 content 里的内联 data:image base64 → attachments 表 + 物理文件。
  // 创建路径同样可能携带 base64（如：富文本编辑器粘贴图片后立即新建笔记保存）。
  // 必须放在 INSERT 之后，attachments.noteId 外键要求 note 行先存在。
  // 短路保证常规无内联图的创建零额外成本。
  let finalContent = initialContent;
  if (typeof body.content === "string" && body.content.indexOf("data:image") >= 0) {
    try {
      const r = extractInlineBase64Images(body.content, userId, id, inheritedWorkspaceId);
      if (r.replacedCount > 0) {
        db.prepare("UPDATE notes SET content = ? WHERE id = ?").run(r.content, id);
        finalContent = r.content;
      }
    } catch (e) {
      // 抽取失败不阻断创建——base64 仍在 content 里，未来某次 PUT 会再尝试。
      console.warn("[notes.post] extractInlineBase64Images failed:", e instanceof Error ? e.message : e);
    }
  }

  // v11: 维护 attachment_references 倒排索引（写时维护）。
  // 失败仅打日志，不阻断笔记创建——倒排表行缺失只会让"反查引用"暂时不准，
  // 不影响主流程；下次该笔记 PUT 时会被重新 sync。
  if (typeof finalContent === "string" && finalContent.indexOf("/api/attachments/") >= 0) {
    try {
      syncAttachmentReferences(db, id, finalContent);
    } catch (e) {
      console.warn("[notes.post] syncAttachmentReferences failed:", e instanceof Error ? e.message : e);
    }
  }

  // BLOCK-INDEX-01: 先规范化块 ID 和派生索引，再同步链接关系。
  // 顺序不能反过来，否则 Markdown 首次保存时 sourceBlockId 仍为空。
  let normalizedLinkContent: string | null = null;
  try {
    const stored = db.prepare("SELECT content, contentFormat FROM notes WHERE id = ?").get(id) as
      | { content: string; contentFormat: string }
      | undefined;
    if (stored) {
      const synced = syncNoteBlocks(db, id, stored.content || "", stored.contentFormat || "tiptap-json");
      db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
        .run(synced.content, synced.contentText, id);
      normalizedLinkContent = synced.content;
      finalContent = synced.content;
      if (["tiptap-json", "markdown"].includes(stored.contentFormat || "tiptap-json")) {
        rebuildBlockAuthorityStore(db, id, synced.content, stored.contentFormat || "tiptap-json", {
          noteVersion: 1,
          operationType: "create",
        });
        rebuildYjsSubdocumentsIfEnabled(db, id, synced.content, stored.contentFormat || "tiptap-json");
      }
    }
  } catch (e) {
    console.warn("[notes.post] syncNoteBlocks failed:", e instanceof Error ? e.message : e);
  }
  if (normalizedLinkContent !== null) {
    try {
      syncNoteLinks(db, userId, id, normalizedLinkContent);
    } catch (e) {
      console.warn("[notes.post] syncNoteLinks failed:", e instanceof Error ? e.message : e);
    }
  }

  // Y1: SELECT 时 isFavorite 按当前用户动态计算；新建笔记当前用户尚未收藏，结果必为 0。
  const note = db.prepare(`
    SELECT id, userId, notebookId, workspaceId, title, content, contentText, isPinned,
      CASE WHEN EXISTS(SELECT 1 FROM favorites f WHERE f.noteId = notes.id AND f.userId = ?) THEN 1 ELSE 0 END AS isFavorite,
      isLocked, isArchived, isTrashed, version, sortOrder, createdAt, updatedAt, trashedAt, contentFormat
    FROM notes WHERE id = ?
  `).get(userId, id);
  logAudit(userId, "note", "create", { noteId: id, title: body.title }, { targetType: "note", targetId: id });

  const responseNote = presentNoteForResponse(db, c, note);
  return c.json({ ...responseNote as any, tags: [] }, 201);
});

// 更新笔记
app.put("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();

  // 权限校验
  const { permission, workspaceId: noteWorkspaceId } = resolveNotePermission(id, userId);

  // 根据变更字段决定所需权限
  const writeFields = ["title", "content", "contentText", "contentFormat", "notebookId", "isPinned", "isFavorite",
                       "isArchived", "isTrashed", "sortOrder"];
  const manageFields = ["isLocked"]; // 锁定需要 manage 权限
  const needsManage = manageFields.some((f) => body[f] !== undefined);
  const needsWrite = writeFields.some((f) => body[f] !== undefined);

  if (needsManage && !hasPermission(permission, "manage")) {
    return c.json({ error: "需要 manage 权限", code: "FORBIDDEN" }, 403);
  }
  if (needsWrite && !hasPermission(permission, "write")) {
    return c.json({ error: "权限不足", code: "FORBIDDEN" }, 403);
  }

  // H4: 乐观锁——对"内容类"变更强制要求 version 字段，防止客户端在未感知他人改动的
  //     情况下直接覆盖。元数据操作（isPinned / isFavorite / isArchived / isTrashed /
  //     isLocked / sortOrder / notebookId）不强制 version，这样右键菜单的快捷操作
  //     不会被阻塞。
  const versionRequiredFields = ["title", "content", "contentText", "contentFormat"];
  const needsVersion = versionRequiredFields.some((f) => body[f] !== undefined);

  if (needsVersion && body.version === undefined) {
    return c.json(
      { error: "缺少 version 字段，无法安全保存", code: "VERSION_REQUIRED" },
      400,
    );
  }

  // 乐观锁：检查版本号（body.version 存在时始终校验；内容类变更已在上面强制带上）
  if (body.version !== undefined) {
    const current = db.prepare("SELECT version FROM notes WHERE id = ?").get(id) as { version: number } | undefined;
    if (current && current.version !== body.version) {
      return c.json(
        { error: "Version conflict", code: "VERSION_CONFLICT", currentVersion: current.version },
        409,
      );
    }
  }

  // P0: 空内容监控——记录非空→空的内容更新，便于排查数据丢失问题。
  // 前端已通过 noteId 快照 + isSettingContent 守卫防止竞态导致的误保存，
  // 后端仅做日志监控，不拦截（避免阻塞用户主动清空文档的合法操作）。
  if (body.content !== undefined) {
    const existing = db.prepare("SELECT content, contentText FROM notes WHERE id = ?").get(id) as { content: string; contentText: string } | undefined;
    if (existing) {
      const oldContentPlain = (existing.content || "").replace(/<[^>]+>/g, "").replace(/\s+/g, "").trim();
      const newContentPlain = (body.content || "").replace(/<[^>]+>/g, "").replace(/\s+/g, "").trim();
      if (oldContentPlain.length > 0 && newContentPlain.length === 0) {
        console.warn("[notes.put] Suspicious empty content update (allowed)", {
          noteId: id, userId, oldLen: existing.content.length, newLen: (body.content || "").length,
          contentTextLen: (body.contentText || "").length,
        });
      }
    }
  }

  // 锁定保护：锁定状态下禁止修改内容（但允许切换 isLocked 本身和元数据操作）
  const contentFields = ["title", "content", "contentText", "contentFormat", "notebookId"];
  const isContentChange = contentFields.some((f) => body[f] !== undefined);
  const isOnlyLockToggle = body.isLocked !== undefined && Object.keys(body).filter(k => k !== "isLocked" && k !== "version").length === 0;

  if (isContentChange && !isOnlyLockToggle) {
    const note = db.prepare("SELECT isLocked FROM notes WHERE id = ?").get(id) as { isLocked: number } | undefined;
    if (note && note.isLocked === 1) {
      return c.json({ error: "Note is locked", code: "NOTE_LOCKED" }, 403);
    }
  }

  // 移动笔记到其他笔记本（改 notebookId）——严格的工作区隔离
  //
  // 规则：**源笔记所在的 workspace 必须与目标 notebook 所在的 workspace 完全一致**
  //       （含"都为 null = 个人空间"的情形）。跨工作区移动一律 400 拒绝。
  //
  // 背景：历史实现只检查"目标 notebook 存在 + 当前用户对其有 write 权限"，然后就
  //       把 notes.workspaceId 同步改成目标 notebook 的 workspaceId。对于同时是
  //       "个人空间 owner"和"某工作区 editor"的用户，两个 write 条件会同时成立，
  //       从而出现"在个人空间视图里把工作站工作区的笔记拖进个人笔记本 → 笔记被
  //       过户到个人空间"这类跨空间污染。
  //
  // 对照：notebooks.ts:179 的 /:id/move 路由已经正确做了同空间校验，此处补齐，
  //       让 notes 与 notebooks 的保护对称。
  //
  // 归一：个人空间在 DB 中以 workspaceId = NULL 表示；`|| null` 把 undefined/""
  //       也归一到 null 再比较，避免 "null !== undefined" 的字符串假阳性。
  let newWorkspaceId: string | null | undefined = undefined;
  if (body.notebookId !== undefined) {
    const nb = db
      .prepare("SELECT workspaceId, isDeleted FROM notebooks WHERE id = ?")
      .get(body.notebookId) as
      | { workspaceId: string | null; isDeleted: number }
      | undefined;
    if (!nb) return c.json({ error: "目标笔记本不存在" }, 404);
    // v14：不允许移到软删的笔记本。这个分支也负责拦住
    // "从回收站恢复笔记「顺便指向原父」" 的场景——还原之前前端会
    // 明确传一个未被软删的 notebookId。
    if (nb.isDeleted === 1) {
      return c.json(
        { error: "目标笔记本已删除", code: "NOTEBOOK_TRASHED" },
        400,
      );
    }
    newWorkspaceId = nb.workspaceId;

    // ★ 严格空间隔离：源/目标必须同 workspace（都为 null = 个人空间 也算同）
    const srcWs = noteWorkspaceId || null;
    const dstWs = nb.workspaceId || null;
    if (srcWs !== dstWs) {
      return c.json(
        {
          error: "不能跨工作区移动笔记",
          code: "CROSS_WORKSPACE_MOVE_FORBIDDEN",
          sourceWorkspaceId: srcWs,
          targetWorkspaceId: dstWs,
        },
        400,
      );
    }

    // 目标笔记本必须有 write 权限
    const targetPerm = resolveNotebookPermission(body.notebookId, userId);
    if (!hasPermission(targetPerm.permission, "write")) {
      return c.json({ error: "您对目标笔记本无权限" }, 403);
    }
  }

  // 防御性：即使前端误传 workspaceId 字段也一律忽略——workspaceId 的唯一合法
  // 来源是"目标 notebook 的归属"（见上），不允许客户端直接改写，以免绕过上面
  // 的同空间校验。writeFields 白名单里本就没有 workspaceId，这里只是显式说明。
  if ("workspaceId" in body) {
    // 不 return，只是清掉，不污染后续 UPDATE 字段收集
    delete (body as Record<string, unknown>).workspaceId;
  }

  // Phase 3: 保存版本历史（仅在内容有实质变更时）
  const VERSION_MERGE_WINDOW_MS = 5 * 60 * 1000; // 5 分钟
  if (body.content !== undefined || body.contentText !== undefined || body.title !== undefined || body.contentFormat !== undefined) {
    const currentNote = db.prepare("SELECT title, content, contentText, contentFormat, version, userId FROM notes WHERE id = ?").get(id) as any;
    if (currentNote) {
      const hasContentChange = (body.content !== undefined && body.content !== currentNote.content)
        || (body.contentText !== undefined && body.contentText !== currentNote.contentText)
        || (body.title !== undefined && body.title !== currentNote.title)
        || (body.contentFormat !== undefined && body.contentFormat !== currentNote.contentFormat);
      if (hasContentChange) {
        const lastEdit = noteVersionsRepository.getLastEditByNoteId(id);

        let shouldInsert = true;
        if (lastEdit) {
          const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(lastEdit.createdAt)
            ? lastEdit.createdAt
            : lastEdit.createdAt.replace(" ", "T") + "Z";
          const lastTs = new Date(normalized).getTime();
          if (!Number.isNaN(lastTs) && Date.now() - lastTs < VERSION_MERGE_WINDOW_MS) {
            shouldInsert = false;
          }
        }

        if (shouldInsert) {
          const versionId = uuid();
          // 版本历史里记录实际编辑者（可能与笔记所有者不同）
          noteVersionsRepository.create({
            id: versionId,
            noteId: id,
            userId,
            title: currentNote.title,
            content: currentNote.content,
            contentText: currentNote.contentText,
            contentFormat: currentNote.contentFormat,
            version: currentNote.version,
            changeType: 'edit',
          });
        }
      }
    }
  }

  const previousTitleRow = typeof body.title === "string"
    ? db.prepare("SELECT title FROM notes WHERE id = ?").get(id) as { title: string } | undefined
    : undefined;
  const fields: string[] = [];
  const params: any[] = [];

  // A2: 自动抽取 body.content 里的内联 data:image base64 为 attachments。
  // 必须先做：UPDATE 拼参数前替换掉 data URI，避免再把 MB 级 blob 写进 notes.content。
  // 注意：
  //   - 仅当本次 PUT 真的带了 content 才尝试（短路 indexOf("data:image")）；
  //   - extractInlineBase64Images 内部会 INSERT attachments 行，要求 noteId 已存在
  //     ——PUT 自然成立；
  //   - 失败保留原 data URI 不阻断保存；
  //   - 抽取改写后会让 contentText 与 content 体积出现"不对称变化"——但 contentText 是
  //     纯文本不含 base64，本身不受影响，FTS 重排逻辑（notes_au）也不会被打扰。
  if (typeof body.content === "string" && body.content.indexOf("data:image") >= 0) {
    try {
      const r = extractInlineBase64Images(body.content, userId, id, noteWorkspaceId);
      if (r.replacedCount > 0) {
        body.content = r.content;
      }
    } catch (e) {
      console.warn("[notes.put] extractInlineBase64Images failed:", e instanceof Error ? e.message : e);
    }
  }

  // Ignore untrusted client contentText and derive the searchable text after any
  // inline-image rewrite, using the effective stored content and format.
  if (body.content !== undefined || body.contentFormat !== undefined) {
    const currentSearchSource = db.prepare(
      "SELECT content, contentFormat FROM notes WHERE id = ?",
    ).get(id) as { content: string; contentFormat: string } | undefined;
    const effectiveContent = typeof body.content === "string"
      ? body.content
      : currentSearchSource?.content || "";
    const effectiveFormat = typeof body.contentFormat === "string"
      ? body.contentFormat
      : currentSearchSource?.contentFormat || "tiptap-json";
    body.contentText = extractSearchableText(effectiveContent, effectiveFormat);
  } else if (body.contentText !== undefined) {
    delete body.contentText;
  }

  if (body.title !== undefined) { fields.push("title = ?"); params.push(body.title); }
  if (body.content !== undefined) { fields.push("content = ?"); params.push(body.content); }
  if (body.contentText !== undefined) { fields.push("contentText = ?"); params.push(body.contentText); }
  if (body.contentFormat !== undefined) { fields.push("contentFormat = ?"); params.push(body.contentFormat); }
  if (body.notebookId !== undefined) {
    fields.push("notebookId = ?"); params.push(body.notebookId);
    // 同步 workspaceId
    fields.push("workspaceId = ?"); params.push(newWorkspaceId ?? null);
  }
  if (body.isPinned !== undefined) { fields.push("isPinned = ?"); params.push(body.isPinned); }
  // Y1: isFavorite 不再写 notes 列，改为操作 favorites 表（per-user 语义）。
  // 权限检查已在上面的 writeFields 里做过（仍需 write 权限才能切换自己的收藏）。
  // 幂等：truthy → INSERT OR IGNORE；falsy → DELETE。
  // 同一笔记的 workspaceId 从 notes 取，保持 favorites.workspaceId 与笔记同步，便于工作区维度统计。
  if (body.isFavorite !== undefined) {
    const favRow = db.prepare("SELECT workspaceId FROM notes WHERE id = ?").get(id) as
      | { workspaceId: string | null }
      | undefined;
    const favWsId = favRow?.workspaceId ?? null;
    if (body.isFavorite) {
      favoritesRepository.addFavorite(userId, id, favWsId);
    } else {
      favoritesRepository.removeFavorite(userId, id);
    }
  }
  if (body.isLocked !== undefined) { fields.push("isLocked = ?"); params.push(body.isLocked); }
  if (body.isArchived !== undefined) { fields.push("isArchived = ?"); params.push(body.isArchived); }
  if (body.isTrashed !== undefined) {
    // v14：从回收站恢复笔记时（isTrashed=1 → 0），若其父笔记本被软删，
    // 还原后笔记会「看不见」（被侧边栏 isDeleted=0 过滤）。
    //
    // 用户预期 = macOS Notes 的"还原文件夹"语义：
    //   恢复笔记 ⇒ 顺带把它的整条祖先笔记本链一起从笔记本回收站里取出来。
    //
    // 我们这样做：
    //   1) 查到当前笔记的 notebookId 及该笔记本的 isDeleted 状态；
    //   2) 若 isDeleted=1，沿 parentId 向上递归把所有还在软删态的祖先笔记本
    //      统一标记为 isDeleted=0、deletedAt=NULL；
    //   3) 然后正常完成笔记 isTrashed=0 的还原。
    // 这样用户一次操作即可恢复"笔记 + 笔记本树"，无 dead-end。
    if (body.isTrashed === 0 && body.notebookId === undefined) {
      try {
        const cur = db
          .prepare(
            `SELECT nb.id AS nbId, nb.isDeleted FROM notes n
               JOIN notebooks nb ON nb.id = n.notebookId
              WHERE n.id = ?`,
          )
          .get(id) as { nbId: string; isDeleted: number } | undefined;
        if (cur && cur.isDeleted === 1) {
          // 收集需要一并恢复的祖先笔记本 id（含自身），仅限当前是软删的
          const restoreIds = (db
            .prepare(
              `WITH RECURSIVE anc(id) AS (
                 SELECT id FROM notebooks WHERE id = ? AND isDeleted = 1
                 UNION ALL
                 SELECT n.id FROM notebooks n
                   JOIN anc ON n.id = (SELECT parentId FROM notebooks WHERE id = anc.id)
                  WHERE n.isDeleted = 1
               )
               SELECT id FROM anc`,
            )
            .all(cur.nbId) as { id: string }[]).map((r) => r.id);
          if (restoreIds.length > 0) {
            const placeholders = restoreIds.map(() => "?").join(",");
            db.prepare(
              `UPDATE notebooks
                  SET isDeleted = 0,
                      deletedAt = NULL,
                      updatedAt = datetime('now')
                WHERE id IN (${placeholders})`,
            ).run(...restoreIds);
          }
        }
      } catch (e) {
        console.warn(
          "[notes.put] auto-restore ancestor notebooks failed:",
          (e as Error).message,
        );
      }
    }
    fields.push("isTrashed = ?"); params.push(body.isTrashed);
    if (body.isTrashed) { fields.push("trashedAt = datetime('now')"); }
  }
  if (body.sortOrder !== undefined) { fields.push("sortOrder = ?"); params.push(body.sortOrder); }

  const contentFieldNames = ["title", "content", "contentText", "contentFormat", "notebookId"];
  const hasContentFieldChange = contentFieldNames.some((f) => body[f] !== undefined);

  // Y1: 判断本次 PUT 是否"只切换了 favorites"——此时 fields 数组会是空的。
  // 切换 favorites 属于 per-user 操作，不应该 bump notes.version（会误触发其他协作者
  // 的乐观锁刷新），也不应广播 note.updated。因此仅当确有 notes 列要改时才 UPDATE。
  const hasNoteColumnChange = fields.length > 0;

  if (hasNoteColumnChange) {
    fields.push("version = version + 1");
    if (hasContentFieldChange) {
      fields.push("updatedAt = datetime('now')");
    }
    params.push(id);
    db.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  }

  // v11: 同步 attachment_references 倒排（仅在 content 字段被改动时；非内容字段
  // 修改不影响附件引用关系）。失败仅打日志不阻断保存。
  if (body.content !== undefined && typeof body.content === "string") {
    try {
      syncAttachmentReferences(db, id, body.content);
    } catch (e) {
      console.warn("[notes.put] syncAttachmentReferences failed:", e instanceof Error ? e.message : e);
    }
  }

  // BLOCK-INDEX-01: 内容更新时先规范化块 ID，再从规范化正文同步链接。
  if (body.content !== undefined && typeof body.content === "string") {
    let normalizedLinkContent = body.content;
    try {
      const stored = db.prepare("SELECT content, contentFormat, version FROM notes WHERE id = ?").get(id) as
        | { content: string; contentFormat: string; version: number }
        | undefined;
      if (stored) {
        const synced = syncNoteBlocks(db, id, stored.content || "", stored.contentFormat || "tiptap-json");
        db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
          .run(synced.content, synced.contentText, id);
        normalizedLinkContent = synced.content;
        body.content = synced.content;
        body.contentText = synced.contentText;
        if (["tiptap-json", "markdown"].includes(stored.contentFormat || "tiptap-json")) {
          rebuildBlockAuthorityStore(db, id, synced.content, stored.contentFormat || "tiptap-json", {
            noteVersion: stored.version,
            operationType: "whole-save",
          });
          rebuildYjsSubdocumentsIfEnabled(db, id, synced.content, stored.contentFormat || "tiptap-json");
        }
      }
    } catch (e) {
      console.warn("[notes.put] syncNoteBlocks failed:", e instanceof Error ? e.message : e);
    }
    try {
      syncNoteLinks(db, userId, id, normalizedLinkContent);
    } catch (e) {
      console.warn("[notes.put] syncNoteLinks failed:", e instanceof Error ? e.message : e);
    }
  }

  if (previousTitleRow && typeof body.title === "string" && previousTitleRow.title !== body.title) {
    try {
      syncAutomaticNoteLinkTitles(db, id, previousTitleRow.title, body.title);
    } catch (e) {
      console.warn("[notes.put] syncAutomaticNoteLinkTitles failed:", e instanceof Error ? e.message : e);
    }
  }

  // Y1: 返回值里 isFavorite 按当前用户动态计算（EXISTS favorites 表），
  // 物理列 notes.isFavorite 已停止写入。
  const note = db.prepare(`
    SELECT id, userId, notebookId, workspaceId, title, content, contentText, isPinned,
      CASE WHEN EXISTS(SELECT 1 FROM favorites f WHERE f.noteId = notes.id AND f.userId = ?) THEN 1 ELSE 0 END AS isFavorite,
      isLocked, isArchived, isTrashed, version, sortOrder, createdAt, updatedAt, trashedAt, contentFormat
    FROM notes WHERE id = ?
  `).get(userId, id);

  // syncToYjs：调用方（目前是 EditorPane RTE→MD 切换）显式要求把 body.content 作为
  // markdown 同步写入 y room 的 yText。这里必须在 REST 落库成功之后才做，因为：
  //   1. 权限 / 乐观锁 / 版本历史都跑完了，失败已经早返回。
  //   2. 若 REST 成功而 yjs 失败，notes.content 与 yDoc 暂不一致——但客户端下次 room
  //      空闲销毁重启时，loadDocFromDb 会从 note_yupdates 恢复，最坏情况是 MD 编辑器
  //      里短暂看到旧内容；客户端仍可从 REST 拉 notes.content 得到正确值作为后备 UX。
  //     （对"彻底解决切换看不到最新内容"的主诉求已经不致命。）
  //
  // 只在 body.content 存在（即本次 PUT 带了新的 markdown 内容）且 syncToYjs=true 时触发。
  // updateBase64 拿到后调用 realtime 广播给房间内其它连接，使它们的 yDoc 一次性对齐。
  if (body.syncToYjs === true && typeof body.content === "string") {
    try {
      const result = yReplaceContentAsUpdate(id, body.content, userId || null);
      if (result) {
        try {
          broadcastYjsUpdate(id, result.updateBase64);
        } catch (e) {
          console.warn("[notes.put] broadcastYjsUpdate failed:", e);
        }
      }
    } catch (e) {
      console.warn("[notes.put] yReplaceContentAsUpdate failed:", e);
    }
  }

  const tags = noteTagsRepository.listTagsByNoteId(id);

  // Phase 2: 实时广播（失败不阻塞返回）
  // Y1: 仅切换 favorites 时不广播——per-user 操作对其他协作者无意义，广播会引发
  // 不必要的前端重渲染/乐观锁刷新。
  if (hasNoteColumnChange) {
    try {
      const n = note as any;
      // 自回声排除（P0-3 修复）：
      //   前端发起 PUT 的同时通过 X-Connection-Id 头声明自己的 WebSocket 连接 id，
      //   broadcastNoteUpdated 接受 actorConnectionId 并在房间分发时跳过该连接。
      //   不传该 header 时（如离线队列回放、外部自动化脚本）行为退化为旧逻辑，
      //   广播给包括发起者在内的所有订阅者，由前端 selfUserId 守卫兜底。
      //
      // 没有这一步会发生：
      //   1) 用户敲字 → debounce 500ms → PUT 200
      //   2) 服务端广播 note:updated 给当前用户自己的同 tab
      //   3) useRealtimeNote 虽然按 actorUserId 过滤了横幅，但 selfUserId 在 WS
      //      建立窗口期可能尚未就绪 → 横幅误弹 / 触发"重新加载"覆盖未派发的输入。
      const actorConnectionId = c.req.header("X-Connection-Id") || undefined;
      if (body.isTrashed === 1) {
        // 放入回收站，视作"删除"
        broadcastNoteDeleted(id, {
          actorUserId: userId,
          trashed: true,
        }, actorConnectionId);
      } else {
        broadcastNoteUpdated(id, {
          version: n.version,
          updatedAt: n.updatedAt,
          title: n.title,
          contentText: n.contentText,
          actorUserId: userId,
        }, actorConnectionId);
      }

      // 同账号多端列表同步：note:<id> 房间只覆盖“正在打开这篇笔记”的客户端，
      // 手机停留在列表页/其它笔记时不会收到。向当前用户所有连接额外广播轻量列表项，
      // 前端可直接 updateNoteInList，无需每次保存都全量 refresh。
      broadcastToUser(userId, {
        type: "note:list-updated" as any,
        note: {
          id: n.id,
          title: n.title,
          contentText: n.contentText,
          updatedAt: n.updatedAt,
          version: n.version,
          isPinned: n.isPinned,
          isTrashed: n.isTrashed,
          notebookId: n.notebookId,
          workspaceId: n.workspaceId,
        },
        actorUserId: userId,
        actorConnectionId: actorConnectionId || null,
      } as any);
    } catch (e) {
      console.warn("[notes.put] broadcast failed:", e);
    }
  }

  const responseNote = presentNoteForResponse(db, c, note);
  return c.json({ ...responseNote as any, tags });
});

// BACKLINKS-02: 获取笔记的反向链接（哪些笔记引用了当前笔记）
app.get("/:id/backlinks", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const targetNoteId = c.req.param("id");

  // 权限校验：用户必须对目标笔记有 read 权限
  const { permission } = resolveNotePermission(targetNoteId, userId);
  if (!hasPermission(permission, "read")) {
    return c.json({ error: "笔记不存在或无权限", code: "NOT_FOUND" }, 404);
  }

  // 检查目标笔记是否存在且未被删除
  const targetNote = db.prepare(
    "SELECT id, isTrashed FROM notes WHERE id = ?"
  ).get(targetNoteId) as { id: string; isTrashed: number } | undefined;

  if (!targetNote) {
    return c.json({ error: "笔记不存在", code: "NOT_FOUND" }, 404);
  }

  const limitParam = parseInt(c.req.query("limit") || "50", 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 50 : limitParam), 200);

  const backlinks = getBacklinks(db, userId, targetNoteId, limit);

  return c.json({ backlinks });
});

// BLOCK-LINKS-UI-01: 获取笔记的标题块列表（用于块级引用选择）
app.get("/:id/headings", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const targetNoteId = c.req.param("id");

  // 权限校验：用户必须对目标笔记有 read 权限
  const { permission } = resolveNotePermission(targetNoteId, userId);
  if (!hasPermission(permission, "read")) {
    return c.json({ error: "笔记不存在或无权限", code: "NOT_FOUND" }, 404);
  }

  // 检查目标笔记是否存在且未被删除
  const targetNote = db.prepare(
    "SELECT id, title, content, contentFormat, isTrashed FROM notes WHERE id = ?"
  ).get(targetNoteId) as { id: string; title: string; content: string; contentFormat: string; isTrashed: number } | undefined;

  if (!targetNote) {
    return c.json({ error: "笔记不存在", code: "NOT_FOUND" }, 404);
  }

  if (targetNote.isTrashed) {
    return c.json({ error: "笔记已删除", code: "NOT_FOUND" }, 404);
  }

  // 从 content 中提取 heading 节点
  const headings: Array<{ blockId: string; level: number; text: string; order: number }> = [];

  try {
    if (targetNote.contentFormat === "tiptap-json" && targetNote.content) {
      const content = JSON.parse(targetNote.content);

      // 递归遍历 TipTap JSON 提取 heading 节点
      let order = 0;
      const extractHeadings = (nodes: any[]) => {
        for (const node of nodes) {
          if (node.type === "heading" && node.attrs?.blockId) {
            // 提取 heading 文本
            let text = "";
            if (node.content) {
              for (const child of node.content) {
                if (child.type === "text") {
                  text += child.text;
                }
              }
            }

            if (text.trim()) {
              headings.push({
                blockId: node.attrs.blockId,
                level: node.attrs.level || 1,
                text: text.trim(),
                order: order++,
              });
            }
          }

          // 递归遍历子节点
          if (node.content) {
            extractHeadings(node.content);
          }
        }
      };

      extractHeadings(content.content || []);

      // 限制返回数量
      if (headings.length > 100) {
        headings.length = 100;
      }
    }
  } catch (e) {
    console.warn("[getHeadings] failed to parse content:", e instanceof Error ? e.message : e);
    // 解析失败返回空列表，不报错
  }

  return c.json({ headings });
});

/**
 * 释放 Y.js 房间（MD↔RTE 切换用）
 * ---------------------------------------------------------------------------
 * 语义：让客户端能够"断舍离"——在从 MD 切到 RTE 的瞬间主动请求服务端：
 *   1) 立即销毁内存中的 Y.Doc（否则要等 ROOM_IDLE_TIMEOUT 才销毁）
 *   2) 删除 note_yupdates / note_ysnapshots（否则下次 loadDocFromDb 会恢复
 *      出"上次 MD 会话的 yDoc"，盖掉 RTE 期间经由 REST 写入的 notes.content）
 *
 * 为什么是"切换后而非切换前"：
 *   - RTE→MD 切换时走 syncToYjs=true，让 yDoc 与 notes.content 对齐；
 *   - MD→RTE 则相反：接下来的编辑走 REST PUT 覆盖 notes.content，yDoc 不再
 *     代表权威内容，必须清理，否则再次切回 MD 会拿到旧 yDoc 的残留。
 *
 * 权限：
 *   - 必须对笔记有 write 权限；read-only 用户没有修改内容的能力，自然也不
 *     应该能清理房间（会影响其他协作者）。
 *
 * 并发 / 协作影响：
 *   - 若有其他客户端正订阅此 room，yDestroyDoc 会中断它们的 yCollab 连接；
 *     它们下次 y:join 会从 notes.content 冷启动 seed 到新 yDoc，看到的是
 *     切换用户 RTE 编辑前的那份 markdown，但随后自己的新编辑会被 yCollab
 *     正常合并。主流场景（单人 / 异步协作）表现为"干净重置"；极端场景
 *     （两个用户实时协作时其中一人切到 RTE）相当于"切换者退出协作"，我们
 *     接受这一代价以换取数据正确性。
 */
app.post("/:id/yjs/release-room", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  // 权限校验
  const { permission } = resolveNotePermission(id, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "需要 write 权限", code: "FORBIDDEN" }, 403);
  }

  // 1) 销毁内存 Y.Doc（若存在）
  try { yDestroyDoc(id); } catch (e) {
    console.warn("[notes.releaseYjsRoom] yDestroyDoc failed:", e);
  }

  // 2) 删除持久化 yjs 增量与快照，防止下次 loadDocFromDb 恢复旧状态
  //    顺序：先删 updates 再删 snapshots（两表独立，但用事务更安全）
  try {
    db.transaction(() => {
      noteYupdatesRepository.deleteByNoteId(id);
      noteYsnapshotsRepository.deleteByNoteId(id);
    })();
  } catch (e) {
    console.warn("[notes.releaseYjsRoom] delete yjs rows failed:", e);
    return c.json({ error: "release failed" }, 500);
  }

  return c.json({ success: true });
});

/** 超大富文本章节清单；章节快照按需读取，避免首次打开传输整篇 CRDT。 */
app.get("/:id/yjs/subdocuments", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("id");
  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "read")) {
    return c.json({ error: "需要 read 权限", code: "FORBIDDEN" }, 403);
  }
  if (!isYjsSubdocumentsEnabled()) {
    return c.json({ error: "Subdocument 功能未启用", code: "SUBDOCUMENTS_DISABLED" }, 409);
  }
  const manifest = yPrepareSubdocuments(noteId);
  if (!manifest) {
    return c.json({ error: "笔记不支持 Subdocument", code: "SUBDOCUMENTS_UNAVAILABLE" }, 409);
  }
  return c.json(manifest);
});

/** 按需返回单个章节快照。 */
app.get("/:id/yjs/subdocuments/:sectionId", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("id");
  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "read")) {
    return c.json({ error: "需要 read 权限", code: "FORBIDDEN" }, 403);
  }
  if (!isYjsSubdocumentsEnabled()) {
    return c.json({ error: "Subdocument 功能未启用", code: "SUBDOCUMENTS_DISABLED" }, 409);
  }
  const state = yGetSubdocumentState(noteId, c.req.param("sectionId"));
  return state
    ? c.json(state)
    : c.json({ error: "章节不存在", code: "SUBDOCUMENT_NOT_FOUND" }, 404);
});

/** 原子应用单章节 Y.js update，并同步整篇兼容快照和 Block 权威存储。 */
app.post("/:id/yjs/subdocuments/:sectionId", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("id");
  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "需要 write 权限", code: "FORBIDDEN" }, 403);
  }
  if (!isYjsSubdocumentsEnabled()) {
    return c.json({ error: "Subdocument 功能未启用", code: "SUBDOCUMENTS_DISABLED" }, 409);
  }
  const declaredLength = Number(c.req.header("Content-Length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > 1_600_000) {
    return c.json({ error: "章节更新过大", code: "SUBDOCUMENT_UPDATE_TOO_LARGE" }, 413);
  }
  let updateBase64 = "";
  let generation = 0;
  try {
    const rawBody = await c.req.text();
    if (rawBody.length > 1_600_000) {
      return c.json({ error: "章节更新过大", code: "SUBDOCUMENT_UPDATE_TOO_LARGE" }, 413);
    }
    const body = JSON.parse(rawBody);
    updateBase64 = typeof body?.updateBase64 === "string" ? body.updateBase64 : "";
    generation = Number(body?.generation);
  } catch {
    return c.json({ error: "无效章节更新", code: "INVALID_SUBDOCUMENT_UPDATE" }, 400);
  }
  if (
    !updateBase64
    || updateBase64.length > 1_500_000
    || updateBase64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(updateBase64)
    || !Number.isInteger(generation)
    || generation < 1
  ) {
    return c.json({ error: "无效章节更新", code: "INVALID_SUBDOCUMENT_UPDATE" }, 400);
  }
  try {
    const result = yApplySubdocumentUpdate(
      noteId,
      c.req.param("sectionId"),
      updateBase64,
      userId,
      generation,
    );
    if (!result) {
      return c.json({ error: "Subdocument 功能未启用", code: "SUBDOCUMENTS_DISABLED" }, 409);
    }
    const note = getDb().prepare(`
      SELECT version, updatedAt, title, contentText FROM notes WHERE id = ?
    `).get(noteId) as { version: number; updatedAt: string; title: string; contentText: string } | undefined;
    if (note) {
      broadcastNoteUpdated(noteId, { ...note, actorUserId: userId });
    }
    return c.json({ success: true, ...result });
  } catch (error) {
    console.warn("[notes.applySubdocumentUpdate] rejected:", error instanceof Error ? error.message : error);
    if (error instanceof SubdocumentGenerationConflictError) {
      return c.json({
        error: "章节代际已更新，请重新加载清单",
        code: error.code,
        manifest: error.manifest,
      }, 409);
    }
    if (error instanceof Error && error.message === "SUBDOCUMENT_NOT_FOUND") {
      return c.json({ error: "章节不存在", code: "SUBDOCUMENT_NOT_FOUND" }, 404);
    }
    if (error instanceof Error && error.message === "SUBDOCUMENT_LEGACY_ROOM_ACTIVE") {
      return c.json({
        error: "旧版协同会话仍在活动，请关闭旧编辑器后重试",
        code: "SUBDOCUMENT_LEGACY_ROOM_ACTIVE",
      }, 409);
    }
    if (error instanceof Error && error.message === "INVALID_SUBDOCUMENT_UPDATE_SIZE") {
      return c.json({ error: "章节更新过大", code: "SUBDOCUMENT_UPDATE_TOO_LARGE" }, 413);
    }
    return c.json({ error: "无效章节更新", code: "INVALID_SUBDOCUMENT_UPDATE" }, 400);
  }
});

// 删除笔记（永久）
app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const { permission } = resolveNotePermission(id, userId);
  if (!hasPermission(permission, "manage")) {
    // editor 不能永久删除，只能放入回收站
    return c.json({ error: "仅笔记 owner 或工作区管理员可永久删除", code: "FORBIDDEN" }, 403);
  }

  const note = db.prepare("SELECT isLocked FROM notes WHERE id = ?").get(id) as { isLocked: number } | undefined;
  if (note && note.isLocked === 1) {
    return c.json({ error: "Note is locked", code: "NOTE_LOCKED" }, 403);
  }

  // ⚠ 先清理磁盘附件物理文件（必须在 DELETE FROM notes 之前，否则 CASCADE 后查不到 path）
  let removedFiles = 0;
  try {
    removedFiles = deleteAttachmentFilesByNoteIds([id]);
  } catch (e) {
    console.warn("[notes.delete] deleteAttachmentFilesByNoteIds failed:", e);
  }

  // BACKLINKS-02-RV1: 永久删除笔记前清理 note_links 引用关系
  // 作为 source 或 target 的引用记录都需要清除，避免孤儿数据残留
  try {
    noteLinksRepository.deleteByNoteId(id);
  } catch (e) {
    console.warn("[notes.delete] cleanup note_links failed:", e);
  }

  // 估算本次释放的字节数——仅用于判断是否值当做全量 VACUUM。
  // 失败时当作 0，后续只会做 checkpoint + incremental_vacuum，不会误触发 VACUUM。
  let freedBytesEstimate = 0;
  try {
    const attBytes = db
      .prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE noteId = ?")
      .get(id) as { bytes: number } | undefined;
    freedBytesEstimate += attBytes?.bytes || 0;
    const noteBytes = db
      .prepare(
        `SELECT COALESCE(LENGTH(content), 0)
              + COALESCE(LENGTH(contentText), 0)
              + COALESCE(LENGTH(title), 0) AS bytes
           FROM notes WHERE id = ?`,
      )
      .get(id) as { bytes: number } | undefined;
    freedBytesEstimate += noteBytes?.bytes || 0;
  } catch { /* ignore */ }

  db.prepare("DELETE FROM notes WHERE id = ?").run(id);

  // TAG-PRUNE-UNUSED-ON-NOTE-DELETE-01: 永久删除笔记后清理未使用的标签
  // 删除该用户下没有任何笔记引用的标签（只删除个人空间标签，不删除工作区标签）
  try {
    db.prepare(`
      DELETE FROM tags
      WHERE userId = ?
        AND workspaceId IS NULL
        AND id NOT IN (
          SELECT DISTINCT nt.tagId
          FROM note_tags nt
          JOIN notes n ON n.id = nt.noteId
          WHERE n.userId = ? AND n.isTrashed = 0
        )
    `).run(userId, userId);
  } catch (e) {
    console.warn("[notes.delete] prune unused tags failed:", e);
  }

  // Phase 3: 释放内存 Y.Doc（CASCADE 已清 note_yupdates/note_ysnapshots）
  try { yDestroyDoc(id); } catch {}

  // 回收磁盘空间：与"清空回收站"一致的 checkpoint + incremental_vacuum 策略。
  // 没有这一步，单删笔记永远不会让 .db 主文件缩小（SQLite 默认不归还 free page），
  // 用户感知就是"删了笔记占用不降"，这是此前的缺陷。
  reclaimSpace(db, { freedBytesEstimate, tag: "notes.delete" });

  emitWebhook("note.deleted", userId, { noteId: id, removedFiles });
  logAudit(userId, "note", "delete", { noteId: id, removedFiles }, { targetType: "note", targetId: id });

  // Phase 2: 广播永久删除
  try {
    broadcastNoteDeleted(id, { actorUserId: userId, trashed: false });
  } catch {}

  return c.json({ success: true });
});

export default app;
