import { Hono } from "hono";
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
import { broadcastNoteUpdated, broadcastNoteDeleted, broadcastYjsUpdate } from "../services/realtime";
import { yFlush, yDestroyDoc, yReplaceContentAsUpdate } from "../services/yjs";
import { deleteAttachmentFilesByNoteIds } from "./attachments";

const app = new Hono();

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
  const dateFrom = c.req.query("dateFrom"); // YYYY-MM-DD
  const dateTo = c.req.query("dateTo");     // YYYY-MM-DD

  let query = `SELECT id, userId, notebookId, workspaceId, title, contentText, isPinned, isFavorite, isLocked,
    isArchived, isTrashed, version, createdAt, updatedAt FROM notes WHERE 1=1`;
  const params: any[] = [];

  // Scope 过滤
  if (workspaceId && workspaceId !== "personal") {
    // 指定工作区：必须是成员
    const role = getUserWorkspaceRole(workspaceId, userId);
    if (!role) return c.json({ error: "无权访问该工作区" }, 403);
    query += " AND workspaceId = ?";
    params.push(workspaceId);
  } else {
    // 个人空间（默认或 'personal'）
    query += " AND userId = ? AND workspaceId IS NULL";
    params.push(userId);
  }

  if (search) {
    const ftsResults = db.prepare(`
      SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?
    `).all(search) as { rowid: number }[];
    if (ftsResults.length === 0) return c.json([]);
    const rowids = ftsResults.map((r) => r.rowid).join(",");
    query += ` AND rowid IN (${rowids})`;
  } else if (isTrashed === "1") {
    query += " AND isTrashed = 1";
  } else if (isFavorite === "1") {
    query += " AND isFavorite = 1 AND isTrashed = 0";
  } else if (tagId) {
    query += " AND isTrashed = 0 AND id IN (SELECT noteId FROM note_tags WHERE tagId = ?)";
    params.push(tagId);
  } else if (notebookId) {
    query += " AND notebookId = ? AND isTrashed = 0";
    params.push(notebookId);
  } else {
    query += " AND isTrashed = 0";
  }

  // 日期范围筛选
  if (dateFrom) {
    query += " AND updatedAt >= ?";
    params.push(dateFrom + " 00:00:00");
  }
  if (dateTo) {
    query += " AND updatedAt <= ?";
    params.push(dateTo + " 23:59:59");
  }

  query += " ORDER BY isPinned DESC, sortOrder ASC, updatedAt DESC";
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
    return c.json({ success: true, count: 0, skipped });
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

  const deleteMany = db.transaction((list: string[]) => {
    db.prepare(`DELETE FROM notes WHERE id IN (${placeholders})`).run(...list);
  });
  deleteMany(ids);

  // Phase 3: 释放所有被删笔记的内存 Y.Doc（外键 CASCADE 已清数据，这里只清内存）
  for (const id of ids) {
    try { yDestroyDoc(id); } catch {}
  }

  emitWebhook("note.trash_emptied", userId, { count: ids.length, removedFiles });
  logAudit(userId, "note", "trash_empty", { count: ids.length, noteIds: ids, removedFiles });

  return c.json({ success: true, count: ids.length, skipped, removedFiles });
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
  const selectCols = slim
    ? `id, userId, notebookId, workspaceId, title, isPinned, isFavorite, isLocked,
       isArchived, isTrashed, version, sortOrder, createdAt, updatedAt, trashedAt`
    : "*";
  const note = db.prepare(`SELECT ${selectCols} FROM notes WHERE id = ?`).get(id);
  if (!note) return c.json({ error: "Note not found" }, 404);

  const tags = db.prepare(`
    SELECT t.* FROM tags t
    JOIN note_tags nt ON t.id = nt.tagId
    WHERE nt.noteId = ?
  `).all(id);

  return c.json({ ...note as any, tags, permission });
});

// 创建笔记
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();

  // 如果指定了 notebookId，必须对其有 write 权限，并从笔记本继承 workspaceId
  let inheritedWorkspaceId: string | null = null;
  if (body.notebookId) {
    const nb = db.prepare("SELECT workspaceId FROM notebooks WHERE id = ?").get(body.notebookId) as
      | { workspaceId: string | null }
      | undefined;
    if (!nb) return c.json({ error: "笔记本不存在" }, 404);
    inheritedWorkspaceId = nb.workspaceId;

    const { permission } = resolveNotebookPermission(body.notebookId, userId);
    if (!hasPermission(permission, "write")) {
      return c.json({ error: "您在该笔记本无创建权限" }, 403);
    }
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO notes (id, userId, workspaceId, notebookId, title, content, contentText)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId, inheritedWorkspaceId, body.notebookId,
    body.title || "无标题笔记", body.content || "{}", body.contentText || "",
  );
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);

  emitWebhook("note.created", userId, { noteId: id, title: body.title || "无标题笔记" });
  logAudit(userId, "note", "create", { noteId: id, title: body.title }, { targetType: "note", targetId: id });

  return c.json({ ...note as any, tags: [] }, 201);
});

// 更新笔记
app.put("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();

  // 权限校验
  const { permission } = resolveNotePermission(id, userId);

  // 根据变更字段决定所需权限
  const writeFields = ["title", "content", "contentText", "notebookId", "isPinned", "isFavorite",
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
  const versionRequiredFields = ["title", "content", "contentText"];
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

  // 锁定保护：锁定状态下禁止修改内容（但允许切换 isLocked 本身和元数据操作）
  const contentFields = ["title", "content", "contentText", "notebookId"];
  const isContentChange = contentFields.some((f) => body[f] !== undefined);
  const isOnlyLockToggle = body.isLocked !== undefined && Object.keys(body).filter(k => k !== "isLocked" && k !== "version").length === 0;

  if (isContentChange && !isOnlyLockToggle) {
    const note = db.prepare("SELECT isLocked FROM notes WHERE id = ?").get(id) as { isLocked: number } | undefined;
    if (note && note.isLocked === 1) {
      return c.json({ error: "Note is locked", code: "NOTE_LOCKED" }, 403);
    }
  }

  // 移动笔记到其他笔记本时，同步更新 workspaceId
  let newWorkspaceId: string | null | undefined = undefined;
  if (body.notebookId !== undefined) {
    const nb = db.prepare("SELECT workspaceId FROM notebooks WHERE id = ?").get(body.notebookId) as
      | { workspaceId: string | null }
      | undefined;
    if (!nb) return c.json({ error: "目标笔记本不存在" }, 404);
    newWorkspaceId = nb.workspaceId;

    // 目标笔记本必须有 write 权限
    const targetPerm = resolveNotebookPermission(body.notebookId, userId);
    if (!hasPermission(targetPerm.permission, "write")) {
      return c.json({ error: "您对目标笔记本无权限" }, 403);
    }
  }

  // Phase 3: 保存版本历史（仅在内容有实质变更时）
  const VERSION_MERGE_WINDOW_MS = 5 * 60 * 1000; // 5 分钟
  if (body.content !== undefined || body.title !== undefined) {
    const currentNote = db.prepare("SELECT title, content, contentText, version, userId FROM notes WHERE id = ?").get(id) as any;
    if (currentNote) {
      const hasContentChange = (body.content !== undefined && body.content !== currentNote.content)
        || (body.title !== undefined && body.title !== currentNote.title);
      if (hasContentChange) {
        const lastEdit = db.prepare(`
          SELECT createdAt FROM note_versions
          WHERE noteId = ? AND changeType = 'edit'
          ORDER BY version DESC
          LIMIT 1
        `).get(id) as { createdAt: string } | undefined;

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
          db.prepare(`
            INSERT INTO note_versions (id, noteId, userId, title, content, contentText, version, changeType)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'edit')
          `).run(versionId, id, userId, currentNote.title, currentNote.content, currentNote.contentText, currentNote.version);
        }
      }
    }
  }

  const fields: string[] = [];
  const params: any[] = [];

  if (body.title !== undefined) { fields.push("title = ?"); params.push(body.title); }
  if (body.content !== undefined) { fields.push("content = ?"); params.push(body.content); }
  if (body.contentText !== undefined) { fields.push("contentText = ?"); params.push(body.contentText); }
  if (body.notebookId !== undefined) {
    fields.push("notebookId = ?"); params.push(body.notebookId);
    // 同步 workspaceId
    fields.push("workspaceId = ?"); params.push(newWorkspaceId ?? null);
  }
  if (body.isPinned !== undefined) { fields.push("isPinned = ?"); params.push(body.isPinned); }
  if (body.isFavorite !== undefined) { fields.push("isFavorite = ?"); params.push(body.isFavorite); }
  if (body.isLocked !== undefined) { fields.push("isLocked = ?"); params.push(body.isLocked); }
  if (body.isArchived !== undefined) { fields.push("isArchived = ?"); params.push(body.isArchived); }
  if (body.isTrashed !== undefined) {
    fields.push("isTrashed = ?"); params.push(body.isTrashed);
    if (body.isTrashed) { fields.push("trashedAt = datetime('now')"); }
  }
  if (body.sortOrder !== undefined) { fields.push("sortOrder = ?"); params.push(body.sortOrder); }

  const contentFieldNames = ["title", "content", "contentText", "notebookId"];
  const hasContentFieldChange = contentFieldNames.some((f) => body[f] !== undefined);

  fields.push("version = version + 1");
  if (hasContentFieldChange) {
    fields.push("updatedAt = datetime('now')");
  }
  params.push(id);

  db.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);

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

  const tags = db.prepare(`
    SELECT t.* FROM tags t
    JOIN note_tags nt ON t.id = nt.tagId
    WHERE nt.noteId = ?
  `).all(id);

  // Phase 2: 实时广播（失败不阻塞返回）
  try {
    const n = note as any;
    if (body.isTrashed === 1) {
      // 放入回收站，视作"删除"
      broadcastNoteDeleted(id, {
        actorUserId: userId,
        trashed: true,
      });
    } else {
      broadcastNoteUpdated(id, {
        version: n.version,
        updatedAt: n.updatedAt,
        title: n.title,
        contentText: n.contentText,
        actorUserId: userId,
      });
    }
  } catch (e) {
    console.warn("[notes.put] broadcast failed:", e);
  }

  return c.json({ ...note as any, tags });
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
      db.prepare("DELETE FROM note_yupdates WHERE noteId = ?").run(id);
      db.prepare("DELETE FROM note_ysnapshots WHERE noteId = ?").run(id);
    })();
  } catch (e) {
    console.warn("[notes.releaseYjsRoom] delete yjs rows failed:", e);
    return c.json({ error: "release failed" }, 500);
  }

  return c.json({ success: true });
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

  db.prepare("DELETE FROM notes WHERE id = ?").run(id);

  // Phase 3: 释放内存 Y.Doc（CASCADE 已清 note_yupdates/note_ysnapshots）
  try { yDestroyDoc(id); } catch {}

  emitWebhook("note.deleted", userId, { noteId: id, removedFiles });
  logAudit(userId, "note", "delete", { noteId: id, removedFiles }, { targetType: "note", targetId: id });

  // Phase 2: 广播永久删除
  try {
    broadcastNoteDeleted(id, { actorUserId: userId, trashed: false });
  } catch {}

  return c.json({ success: true });
});

export default app;
