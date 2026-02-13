import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";

const app = new Hono();

app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const tags = db.prepare(`
    SELECT t.*, COUNT(nt.noteId) as noteCount
    FROM tags t LEFT JOIN note_tags nt ON t.id = nt.tagId
    WHERE t.userId = ? GROUP BY t.id ORDER BY t.name ASC
  `).all(userId);
  return c.json(tags);
});

app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const body = await c.req.json();
  const id = uuid();
  db.prepare(`INSERT INTO tags (id, userId, name, color) VALUES (?, ?, ?, ?)`).run(id, userId, body.name, body.color || "#58a6ff");
  const tag = db.prepare("SELECT * FROM tags WHERE id = ?").get(id);
  return c.json(tag, 201);
});

app.delete("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  db.prepare("DELETE FROM tags WHERE id = ?").run(id);
  return c.json({ success: true });
});

// 给笔记添加标签
app.post("/note/:noteId/tag/:tagId", (c) => {
  const db = getDb();
  const { noteId, tagId } = c.req.param();
  db.prepare(`INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)`).run(noteId, tagId);
  return c.json({ success: true });
});

// 移除笔记标签
app.delete("/note/:noteId/tag/:tagId", (c) => {
  const db = getDb();
  const { noteId, tagId } = c.req.param();
  db.prepare("DELETE FROM note_tags WHERE noteId = ? AND tagId = ?").run(noteId, tagId);
  return c.json({ success: true });
});

export default app;
