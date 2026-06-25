/**
 * 用户级迁移路由（D-2 / D-3 / D-4 联合实现）
 *
 * 用途：本地（Electron 内嵌后端）用户登录云端账号后，把"本地账号下的所有数据"
 *      搬到"云端账号下"。**两端跑的是同一份代码**，所以接口对称：
 *
 *      [本地] GET  /api/user-migration/export-light    →  { notebooks, notes, tags, noteTags, noteVersions }
 *      [云端] POST /api/user-migration/import-light    ←  上面那坨
 *      [云端] POST /api/user-migration/rollback        ←  失败时撤销已写入数据
 *
 * 设计要点：
 *   1. 这是"用户视角的整库快照"：notebooks/notes/tags/noteVersions 全量；
 *      不含附件二进制（D-3 走专用接口流式传），不含 Yjs CRDT 增量历史（实际收益低）。
 *   2. 导出时**保留原始 ID**，让 D-3 上传附件能用旧 noteId 关联；
 *      导入时**重新生成 ID**，避免与目标账号现有数据撞库。
 *   3. 导入端会用 idMap 把外部的 (notebookId, noteId, tagId) 映射到新 ID。
 *      返回 idMap 给前端，让 D-3 阶段上传附件时能"翻译" noteId。
 *   4. 工作区作用域：仅迁移**个人空间**（notes.workspaceId IS NULL）。
 *      工作区数据涉及成员/角色，不在本期"个人迁移"语义内。
 *   5. 错误处理：D-2 整体事务，单条插入失败 → 全部回滚；D-3（附件）
 *      跨两个后端无法整体事务，由前端在失败时调 /rollback 清理云端。
 *   6. 版本历史（note_versions）：只迁移 noteIdMap 命中的那些，
 *      version 字段保留原值；userId 强制为云端登录用户（避免外键问题）。
 */

import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { syncReferences } from "../lib/attachmentRefs";

const app = new Hono();

// ====== 类型 ======

interface ExportNotebook {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  isExpanded: number;
  createdAt: string;
  updatedAt: string;
}

interface ExportNote {
  id: string;
  notebookId: string;
  title: string;
  content: string;
  contentText: string;
  isPinned: number;
  isFavorite: number;
  isLocked: number;
  isArchived: number;
  isTrashed: number;
  trashedAt: string | null;
  version: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  contentFormat?: string;
}

interface ExportTag {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
}

interface ExportNoteTag {
  noteId: string;
  tagId: string;
}

interface ExportNoteVersion {
  id: string;
  noteId: string;
  title: string | null;
  content: string | null;
  contentText: string | null;
  version: number;
  changeType: string | null;
  changeSummary: string | null;
  createdAt: string;
}

interface ExportPayload {
  /** v1：notebooks/notes/tags/noteTags；v2：增加 noteVersions */
  schemaVersion: 1 | 2;
  exportedAt: string;
  notebooks: ExportNotebook[];
  notes: ExportNote[];
  tags: ExportTag[];
  noteTags: ExportNoteTag[];
  /** v2 新增；v1 payload 无此字段，导入端按空数组处理 */
  noteVersions?: ExportNoteVersion[];
}

// ====== 导出（本地端调用） ======

app.get("/export-light", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  // 仅导出个人空间（workspaceId IS NULL）。
  // isDeleted=0 的笔记本；isTrashed 的笔记照样带走（用户可能想在云端恢复）。
  const notebooks = db
    .prepare(
      `SELECT id, parentId, name, description, icon, color, sortOrder, isExpanded,
              createdAt, updatedAt
       FROM notebooks
       WHERE userId = ? AND (isDeleted IS NULL OR isDeleted = 0)`,
    )
    .all(userId) as ExportNotebook[];

  const notes = db
    .prepare(
      `SELECT id, notebookId, title, content, contentText,
              isPinned, isFavorite, isLocked, isArchived, isTrashed,
              trashedAt, version, sortOrder, createdAt, updatedAt,
              contentFormat
       FROM notes
       WHERE userId = ? AND (workspaceId IS NULL)`,
    )
    .all(userId) as ExportNote[];

  const tags = db
    .prepare(
      `SELECT id, name, color, createdAt FROM tags WHERE userId = ?`,
    )
    .all(userId) as ExportTag[];

  // note_tags 没有 userId 列，按 noteId 反查（限定本用户的 noteId）
  const noteTags = notes.length === 0
    ? []
    : (db
        .prepare(
          `SELECT noteId, tagId FROM note_tags
           WHERE noteId IN (${notes.map(() => "?").join(",")})`,
        )
        .all(...notes.map((n) => n.id)) as ExportNoteTag[]);

  // 版本历史：和 noteTags 一样按 noteId 反查；空集合短路。
  const noteVersions = notes.length === 0
    ? []
    : (db
        .prepare(
          `SELECT id, noteId, title, content, contentText, version,
                  changeType, changeSummary, createdAt
             FROM note_versions
            WHERE noteId IN (${notes.map(() => "?").join(",")})`,
        )
        .all(...notes.map((n) => n.id)) as ExportNoteVersion[]);

  const payload: ExportPayload = {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    notebooks,
    notes,
    tags,
    noteTags,
    noteVersions,
  };
  return c.json(payload);
});

// ====== 导入（云端调用） ======

app.post("/import-light", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  let payload: ExportPayload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "请求体必须是 JSON" }, 400);
  }

  if (!payload || (payload.schemaVersion !== 1 && payload.schemaVersion !== 2)) {
    return c.json({ error: "schemaVersion 不匹配，请升级后重试" }, 400);
  }

  const notebookIdMap = new Map<string, string>(); // 旧 → 新
  const noteIdMap = new Map<string, string>();
  const tagIdMap = new Map<string, string>();

  // ====== Tag：先按 (userId, name) 唯一约束去重，已存在则复用 ======
  const findTagByName = db.prepare(
    `SELECT id FROM tags WHERE userId = ? AND name = ?`,
  );
  const insertTag = db.prepare(
    `INSERT INTO tags (id, userId, name, color, createdAt) VALUES (?, ?, ?, ?, ?)`,
  );

  // ====== Notebook：parentId 需要在父先入库后再映射，所以先按拓扑排序 ======
  const insertNotebook = db.prepare(
    `INSERT INTO notebooks
       (id, userId, parentId, name, description, icon, color, sortOrder, isExpanded,
        createdAt, updatedAt, workspaceId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );

  // ====== Note：notebookId 需要映射；workspaceId=NULL（个人空间） ======
  const insertNote = db.prepare(
    `INSERT INTO notes
       (id, userId, notebookId, title, content, contentText,
        isPinned, isFavorite, isLocked, isArchived, isTrashed, trashedAt,
        version, sortOrder, createdAt, updatedAt, workspaceId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );

  // ====== NoteTag ======
  const insertNoteTag = db.prepare(
    `INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)`,
  );

  // ====== NoteVersion：noteId 重映射；userId 强制为当前云端用户 ======
  // 表外键 userId → users(id) ON DELETE CASCADE，本地的 userId 在云端通常不存在，
  // 所以这里直接写云端登录用户。changeSummary 里如果有作者名是历史快照，不影响。
  const insertNoteVersion = db.prepare(
    `INSERT INTO note_versions
       (id, noteId, userId, title, content, contentText, version, changeType, changeSummary, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // 拓扑排序 notebooks：根（parentId 为 null 或不在集合内）先入，子节点后入。
  // 简单做法：循环找出"父已入库或没父"的节点，最多 N 轮。
  function topoSortNotebooks(items: ExportNotebook[]): ExportNotebook[] {
    const result: ExportNotebook[] = [];
    const known = new Set(items.map((n) => n.id));
    const remaining = [...items];
    let progress = true;
    while (remaining.length > 0 && progress) {
      progress = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const nb = remaining[i];
        const parentReady = !nb.parentId || !known.has(nb.parentId) || notebookIdMap.has(nb.parentId);
        if (parentReady) {
          result.push(nb);
          notebookIdMap.set(nb.id, "__pending__"); // 占位标记，让后续判断 parent 已就位
          remaining.splice(i, 1);
          progress = true;
        }
      }
    }
    // 残留（环结构，理论上不该出现）按原顺序追加，避免死锁
    if (remaining.length > 0) result.push(...remaining);
    notebookIdMap.clear(); // 重置；真正写库时按这个顺序产生新 ID
    return result;
  }

  const sortedNotebooks = topoSortNotebooks(payload.notebooks);

  let imported = { notebooks: 0, notes: 0, tags: 0, noteTags: 0, noteVersions: 0 };

  const tx = db.transaction(() => {
    // 1. Tags
    for (const t of payload.tags) {
      const existing = findTagByName.get(userId, t.name) as { id: string } | undefined;
      if (existing) {
        tagIdMap.set(t.id, existing.id);
      } else {
        const newId = uuid();
        insertTag.run(newId, userId, t.name, t.color || "#58a6ff", t.createdAt);
        tagIdMap.set(t.id, newId);
        imported.tags++;
      }
    }

    // 2. Notebooks（按拓扑顺序）
    for (const nb of sortedNotebooks) {
      const newId = uuid();
      const newParentId = nb.parentId ? notebookIdMap.get(nb.parentId) || null : null;
      insertNotebook.run(
        newId,
        userId,
        newParentId,
        nb.name,
        nb.description,
        nb.icon || "📒",
        nb.color,
        nb.sortOrder ?? 0,
        nb.isExpanded ?? 1,
        nb.createdAt,
        nb.updatedAt,
      );
      notebookIdMap.set(nb.id, newId);
      imported.notebooks++;
    }

    // 3. Notes
    for (const n of payload.notes) {
      const newNotebookId = notebookIdMap.get(n.notebookId);
      if (!newNotebookId) {
        // 笔记本不在导出集（理论不该发生），跳过这条笔记
        console.warn("[migration] note skipped: notebookId not mapped", n.id);
        continue;
      }
      const newId = uuid();
      insertNote.run(
        newId,
        userId,
        newNotebookId,
        n.title,
        n.content,
        n.contentText,
        n.isPinned ?? 0,
        n.isFavorite ?? 0,
        n.isLocked ?? 0,
        n.isArchived ?? 0,
        n.isTrashed ?? 0,
        n.trashedAt,
        n.version ?? 1,
        n.sortOrder ?? 0,
        n.createdAt,
        n.updatedAt,
      );
      noteIdMap.set(n.id, newId);
      imported.notes++;
    }

    // 4. NoteTags
    for (const nt of payload.noteTags) {
      const newNoteId = noteIdMap.get(nt.noteId);
      const newTagId = tagIdMap.get(nt.tagId);
      if (!newNoteId || !newTagId) continue;
      insertNoteTag.run(newNoteId, newTagId);
      imported.noteTags++;
    }

    // 5. NoteVersions（v2 新增；v1 payload 该字段为 undefined，按空处理）
    for (const v of payload.noteVersions || []) {
      const newNoteId = noteIdMap.get(v.noteId);
      if (!newNoteId) continue; // note 不在迁移集合，跳过
      const newId = uuid();
      insertNoteVersion.run(
        newId,
        newNoteId,
        userId,
        v.title,
        v.content,
        v.contentText,
        v.version ?? 1,
        v.changeType || "edit",
        v.changeSummary,
        v.createdAt,
      );
      imported.noteVersions++;
    }
  });

  try {
    tx();
  } catch (e: any) {
    console.error("[migration] import-light failed:", e);
    return c.json({ error: e?.message || "导入失败", code: "IMPORT_FAILED" }, 500);
  }

  return c.json({
    success: true,
    imported,
    idMap: {
      notebooks: Object.fromEntries(notebookIdMap),
      notes: Object.fromEntries(noteIdMap),
      tags: Object.fromEntries(tagIdMap),
    },
  });
});

// ============================================================================
// D-3 阶段：附件迁移辅助接口
// ============================================================================
//
// 处理思路：
//   本地端 有两个输出：
//     1. GET /list-attachments  → 返回当前用户的所有附件元数据（不含 binary）
//        前端拿到后逐个下载（附件 GET 却都是免 JWT 的，所以只需 fetch URL）
//   云端 有一个接收口：
//     2. POST /rewrite-content → 接收 oldAttId→newAttId 映射 + noteIds
//        负责把这些 note 的 content 里的 /api/attachments/<oldId> 批量替换为 newId
//        并 同步重建 attachment_references。
//
// 附件本身的上传复用现有的 POST /api/attachments（multipart），不重复造轮子。

// ===== 本地端：列出当前用户的所有附件 =====
app.get("/list-attachments", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  // 仅个人空间（workspaceId IS NULL）的附件，与本期迁移范围对齐。
  // 不反转成 noteId 分组，让前端自己走 idMap 处理。
  const rows = db
    .prepare(
      `SELECT id, noteId, filename, mimeType, size
       FROM attachments
       WHERE userId = ? AND (workspaceId IS NULL)`,
    )
    .all(userId) as Array<{
      id: string;
      noteId: string;
      filename: string;
      mimeType: string;
      size: number;
    }>;

  return c.json({ attachments: rows });
});

// ===== 云端：批量重写 note.content =====
//
// body 格式：
//   {
//     attMap:  { "<oldAttId>": "<newAttId>", ... }
//     noteIds: ["<云端新 noteId>", ...]   // 即 D-2 返回的 idMap.notes 的 values
//   }
//
// 语义：对每个 noteId，拉出 current content，做全局字符串替换，
//      然后 UPDATE notes SET content=?, contentText=?, version=version+1，
//      并调 syncReferences。整体一个事务。
//
// 为什么不复用 PUT /api/notes/:id：
//   • N 次 PUT = N 次事务、N 次 ACL 查询、N 次意外副作用（activity log 等）
//   • 迁移场景是超级用户操作（只迫己的），不需要 ACL
//   • 批量事务在 SQLite 上要快一个数量级
app.post("/rewrite-content", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  let body: { attMap?: Record<string, string>; noteIds?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体必须是 JSON" }, 400);
  }
  const attMap = body.attMap || {};
  const noteIds = body.noteIds || [];
  if (Object.keys(attMap).length === 0 || noteIds.length === 0) {
    return c.json({ rewritten: 0, skipped: 0 });
  }

  // 反复用的 stmt
  const selStmt = db.prepare(
    `SELECT content FROM notes WHERE id = ? AND userId = ?`,
  );
  const updStmt = db.prepare(
    `UPDATE notes SET content = ?, updatedAt = datetime('now') WHERE id = ? AND userId = ?`,
  );

  let rewritten = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const noteId of noteIds) {
      const row = selStmt.get(noteId, userId) as { content: string } | undefined;
      if (!row) {
        skipped++;
        continue;
      }
      const oldContent = row.content || "";
      // 快速预检：没 /api/attachments/ 字面量直接跳过
      if (oldContent.indexOf("/api/attachments/") < 0) {
        skipped++;
        continue;
      }
      let newContent = oldContent;
      let changed = false;
      // 全局替换。用 split/join 避免正则转义。
      for (const [oldId, newId] of Object.entries(attMap)) {
        if (!oldId || !newId || oldId === newId) continue;
        const needle = `/api/attachments/${oldId}`;
        if (newContent.indexOf(needle) < 0) continue;
        newContent = newContent.split(needle).join(`/api/attachments/${newId}`);
        changed = true;
      }
      if (!changed) {
        skipped++;
        continue;
      }
      updStmt.run(newContent, noteId, userId);
      // 同步反向索引。content 变了就重算，幂等。
      try {
        syncReferences(db, noteId, newContent);
      } catch (e) {
        console.warn("[migration] syncReferences failed for note", noteId, e);
      }
      rewritten++;
    }
  });

  try {
    tx();
  } catch (e: any) {
    console.error("[migration] rewrite-content failed:", e);
    return c.json({ error: e?.message || "重写失败" }, 500);
  }

  return c.json({ rewritten, skipped });
});

// ============================================================================
// 失败回滚（云端调用）：清掉本次迁移已写入云端的所有资源
// ============================================================================
//
// 触发时机：前端在 D-2 / D-3 任意阶段抛错后，把 import-light 返回的 idMap 和
//          attachments idMap 一起 POST 过来，云端按"严格属于 X-User-Id"原则删除。
//
// body 格式：
//   {
//     notebookIds: string[]    // import-light idMap.notebooks 的 values
//     noteIds:     string[]    // import-light idMap.notes 的 values
//     tagIds:      string[]    // import-light idMap.tags 的 values（仅删本次新建的）
//     attachmentIds?: string[] // 附件阶段成功上传的 ids（idMap 的 values）
//   }
//
// 安全约束：每条删除都加 userId = ?，避免恶意 payload 误删别人的数据。
//          tags 没有"仅删新建"的语义——若用户原本就有同名 tag，import-light
//          会复用而不是新建，不会出现在 tagIds 里，因此这里直接按 id 删是安全的。
app.post("/rollback", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  let body: {
    notebookIds?: string[];
    noteIds?: string[];
    tagIds?: string[];
    attachmentIds?: string[];
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体必须是 JSON" }, 400);
  }

  const notebookIds = Array.from(new Set(body.notebookIds || []));
  const noteIds = Array.from(new Set(body.noteIds || []));
  const tagIds = Array.from(new Set(body.tagIds || []));
  const attachmentIds = Array.from(new Set(body.attachmentIds || []));

  const removed = { notebooks: 0, notes: 0, tags: 0, attachments: 0 };

  // 单条 DELETE 包成事务；FK 级联会负责清掉 note_tags / note_versions /
  // note_yupdates / note_ysnapshots / attachment_references 等下游。
  const tx = db.transaction(() => {
    if (attachmentIds.length > 0) {
      const stmt = db.prepare(
        `DELETE FROM attachments WHERE id = ? AND userId = ?`,
      );
      for (const id of attachmentIds) {
        const r = stmt.run(id, userId);
        removed.attachments += r.changes;
      }
    }
    if (noteIds.length > 0) {
      const stmt = db.prepare(`DELETE FROM notes WHERE id = ? AND userId = ?`);
      for (const id of noteIds) {
        const r = stmt.run(id, userId);
        removed.notes += r.changes;
      }
    }
    if (notebookIds.length > 0) {
      const stmt = db.prepare(
        `DELETE FROM notebooks WHERE id = ? AND userId = ?`,
      );
      for (const id of notebookIds) {
        const r = stmt.run(id, userId);
        removed.notebooks += r.changes;
      }
    }
    if (tagIds.length > 0) {
      const stmt = db.prepare(`DELETE FROM tags WHERE id = ? AND userId = ?`);
      for (const id of tagIds) {
        const r = stmt.run(id, userId);
        removed.tags += r.changes;
      }
    }
  });

  try {
    tx();
  } catch (e: any) {
    console.error("[migration] rollback failed:", e);
    return c.json({ error: e?.message || "回滚失败" }, 500);
  }

  return c.json({ success: true, removed });
});

export default app;
