import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";

const app = new Hono();

// 获取所有笔记本（树形结构）
app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const notebooks = db.prepare(`
    SELECT * FROM notebooks WHERE userId = ? ORDER BY sortOrder ASC
  `).all(userId);
  return c.json(notebooks);
});

// 创建笔记本
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const body = await c.req.json();
  const id = uuid();
  db.prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, icon, color, sortOrder)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, body.parentId || null, body.name, body.icon || "📒", body.color || null, body.sortOrder || 0);
  const notebook = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(id);
  return c.json(notebook, 201);
});

// 更新笔记本
app.put("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const body = await c.req.json();
  db.prepare(`
    UPDATE notebooks SET name = COALESCE(?, name), icon = COALESCE(?, icon),
    color = COALESCE(?, color), parentId = COALESCE(?, parentId),
    sortOrder = COALESCE(?, sortOrder), isExpanded = COALESCE(?, isExpanded),
    updatedAt = datetime('now')
    WHERE id = ?
  `).run(body.name, body.icon, body.color, body.parentId, body.sortOrder, body.isExpanded, id);
  const notebook = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(id);
  return c.json(notebook);
});

// 删除笔记本
app.delete("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  db.prepare("DELETE FROM notebooks WHERE id = ?").run(id);
  return c.json({ success: true });
});

export default app;
