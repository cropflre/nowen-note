import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";

const app = new Hono();

// 获取笔记列表（按笔记本筛选）
app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const notebookId = c.req.query("notebookId");
  const isFavorite = c.req.query("isFavorite");
  const isTrashed = c.req.query("isTrashed");
  const search = c.req.query("search");
  const tagId = c.req.query("tagId");

  let query = `SELECT id, userId, notebookId, title, contentText, isPinned, isFavorite,
    isArchived, isTrashed, version, createdAt, updatedAt FROM notes WHERE userId = ?`;
  const params: any[] = [userId];

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

  query += " ORDER BY isPinned DESC, updatedAt DESC";
  const notes = db.prepare(query).all(...params);
  return c.json(notes);
});

// 获取单个笔记（完整内容）
app.get("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  if (!note) return c.json({ error: "Note not found" }, 404);

  const tags = db.prepare(`
    SELECT t.* FROM tags t
    JOIN note_tags nt ON t.id = nt.tagId
    WHERE nt.noteId = ?
  `).all(id);

  return c.json({ ...note as any, tags });
});

// 创建笔记
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const body = await c.req.json();
  const id = uuid();
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, body.notebookId, body.title || "无标题笔记", body.content || "{}", body.contentText || "");
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  return c.json(note, 201);
});

// 更新笔记
app.put("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const body = await c.req.json();

  // 乐观锁：检查版本号
  if (body.version !== undefined) {
    const current = db.prepare("SELECT version FROM notes WHERE id = ?").get(id) as { version: number } | undefined;
    if (current && current.version !== body.version) {
      return c.json({ error: "Version conflict", currentVersion: current.version }, 409);
    }
  }

  const fields: string[] = [];
  const params: any[] = [];

  if (body.title !== undefined) { fields.push("title = ?"); params.push(body.title); }
  if (body.content !== undefined) { fields.push("content = ?"); params.push(body.content); }
  if (body.contentText !== undefined) { fields.push("contentText = ?"); params.push(body.contentText); }
  if (body.notebookId !== undefined) { fields.push("notebookId = ?"); params.push(body.notebookId); }
  if (body.isPinned !== undefined) { fields.push("isPinned = ?"); params.push(body.isPinned); }
  if (body.isFavorite !== undefined) { fields.push("isFavorite = ?"); params.push(body.isFavorite); }
  if (body.isArchived !== undefined) { fields.push("isArchived = ?"); params.push(body.isArchived); }
  if (body.isTrashed !== undefined) {
    fields.push("isTrashed = ?"); params.push(body.isTrashed);
    if (body.isTrashed) { fields.push("trashedAt = datetime('now')"); }
  }

  fields.push("version = version + 1");
  fields.push("updatedAt = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  return c.json(note);
});

// 删除笔记（永久）
app.delete("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  return c.json({ success: true });
});

export default app;
