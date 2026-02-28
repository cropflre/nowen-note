import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuidv4 } from "uuid";

const app = new Hono();

// 确保 mindmaps 表存在
function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mindmaps (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '无标题导图',
      data TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mindmaps_user ON mindmaps(userId);
    CREATE INDEX IF NOT EXISTS idx_mindmaps_updated ON mindmaps(updatedAt DESC);
  `);
}

// 初始化表
ensureTable();

// 获取所有思维导图列表
app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const rows = db.prepare(
    "SELECT id, userId, title, createdAt, updatedAt FROM mindmaps WHERE userId = ? ORDER BY updatedAt DESC"
  ).all(userId);
  return c.json(rows);
});

// 获取单个思维导图
app.get("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");
  const row = db.prepare(
    "SELECT * FROM mindmaps WHERE id = ? AND userId = ?"
  ).get(id, userId);
  if (!row) return c.json({ error: "思维导图不存在" }, 404);
  return c.json(row);
});

// 创建思维导图
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const body = await c.req.json();
  const id = uuidv4();
  const title = body.title || "无标题导图";

  // 默认初始数据：一个根节点
  const defaultData = JSON.stringify({
    root: {
      id: "root",
      text: title,
      children: [],
    },
  });
  const data = body.data || defaultData;

  db.prepare(
    "INSERT INTO mindmaps (id, userId, title, data) VALUES (?, ?, ?, ?)"
  ).run(id, userId, title, typeof data === "string" ? data : JSON.stringify(data));

  const row = db.prepare("SELECT * FROM mindmaps WHERE id = ?").get(id);
  return c.json(row, 201);
});

// 更新思维导图
app.put("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = db.prepare(
    "SELECT id FROM mindmaps WHERE id = ? AND userId = ?"
  ).get(id, userId);
  if (!existing) return c.json({ error: "思维导图不存在" }, 404);

  const updates: string[] = [];
  const values: any[] = [];

  if (body.title !== undefined) {
    updates.push("title = ?");
    values.push(body.title);
  }
  if (body.data !== undefined) {
    updates.push("data = ?");
    values.push(typeof body.data === "string" ? body.data : JSON.stringify(body.data));
  }

  if (updates.length > 0) {
    updates.push("updatedAt = datetime('now')");
    values.push(id, userId);
    db.prepare(
      `UPDATE mindmaps SET ${updates.join(", ")} WHERE id = ? AND userId = ?`
    ).run(...values);
  }

  const row = db.prepare("SELECT * FROM mindmaps WHERE id = ?").get(id);
  return c.json(row);
});

// 删除思维导图
app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const id = c.req.param("id");

  const existing = db.prepare(
    "SELECT id FROM mindmaps WHERE id = ? AND userId = ?"
  ).get(id, userId);
  if (!existing) return c.json({ error: "思维导图不存在" }, 404);

  db.prepare("DELETE FROM mindmaps WHERE id = ? AND userId = ?").run(id, userId);
  return c.json({ success: true });
});

export default app;
