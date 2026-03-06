import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuidv4 } from "uuid";

const app = new Hono();

// 确保 diary_entries 表存在
function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS diary_entries (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_diary_user ON diary_entries(userId);
    CREATE INDEX IF NOT EXISTS idx_diary_created ON diary_entries(createdAt DESC);
  `);
}

ensureTable();

// 获取所有日记（倒序）
app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const rows = db.prepare(
    "SELECT * FROM diary_entries WHERE userId = ? ORDER BY createdAt DESC"
  ).all(userId);
  return c.json(rows);
});

// 发布新日记
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const { content } = await c.req.json();

  if (!content?.trim()) {
    return c.json({ error: "内容不能为空" }, 400);
  }

  const id = uuidv4();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  db.prepare(
    "INSERT INTO diary_entries (id, userId, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
  ).run(id, userId, content.trim(), now, now);

  const entry = db.prepare("SELECT * FROM diary_entries WHERE id = ?").get(id);
  return c.json(entry, 201);
});

// 更新日记
app.put("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");
  const { content } = await c.req.json();

  if (!content?.trim()) {
    return c.json({ error: "内容不能为空" }, 400);
  }

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  db.prepare(
    "UPDATE diary_entries SET content = ?, updatedAt = ? WHERE id = ? AND userId = ?"
  ).run(content.trim(), now, id, userId);

  const entry = db.prepare("SELECT * FROM diary_entries WHERE id = ?").get(id);
  return c.json(entry);
});

// 删除日记
app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");
  db.prepare("DELETE FROM diary_entries WHERE id = ? AND userId = ?").run(id, userId);
  return c.json({ success: true });
});

export default app;
