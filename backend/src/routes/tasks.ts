import { Hono } from "hono";
import { getDb } from "../db/schema";
import crypto from "crypto";

const tasks = new Hono();

// 获取所有任务
tasks.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const filter = c.req.query("filter"); // all | today | week | overdue | completed
  const noteId = c.req.query("noteId");

  let sql = `SELECT * FROM tasks WHERE userId = ?`;
  const params: any[] = [userId];

  if (noteId) {
    sql += ` AND noteId = ?`;
    params.push(noteId);
  }

  if (filter === "today") {
    sql += ` AND dueDate IS NOT NULL AND date(dueDate) = date('now')`;
  } else if (filter === "week") {
    sql += ` AND dueDate IS NOT NULL AND date(dueDate) BETWEEN date('now') AND date('now', '+7 days')`;
  } else if (filter === "overdue") {
    sql += ` AND isCompleted = 0 AND dueDate IS NOT NULL AND date(dueDate) < date('now')`;
  } else if (filter === "completed") {
    sql += ` AND isCompleted = 1`;
  }

  sql += ` ORDER BY isCompleted ASC, priority DESC, sortOrder ASC, createdAt DESC`;

  const rows = db.prepare(sql).all(...params);
  return c.json(rows);
});

// 获取任务统计（必须在 /:id 之前注册）
tasks.get("/stats/summary", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  const total = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE userId = ?").get(userId) as any).count;
  const completed = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE userId = ? AND isCompleted = 1").get(userId) as any).count;
  const today = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE userId = ? AND isCompleted = 0 AND dueDate IS NOT NULL AND date(dueDate) = date('now')").get(userId) as any).count;
  const overdue = (db.prepare("SELECT COUNT(*) as count FROM tasks WHERE userId = ? AND isCompleted = 0 AND dueDate IS NOT NULL AND date(dueDate) < date('now')").get(userId) as any).count;

  return c.json({ total, completed, pending: total - completed, today, overdue });
});

// 获取单个任务（含子任务）
tasks.get("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!task) return c.json({ error: "Task not found" }, 404);

  const children = db.prepare(
    "SELECT * FROM tasks WHERE parentId = ? ORDER BY sortOrder ASC, createdAt ASC"
  ).all(id);

  return c.json({ ...task, children });
});

// 创建任务
tasks.post("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  return c.req.json().then((body: any) => {
    const id = crypto.randomUUID();
    const { title, priority = 2, dueDate = null, noteId = null, parentId = null } = body;

    if (!title || !title.trim()) {
      return c.json({ error: "Title is required" }, 400);
    }

    db.prepare(`
      INSERT INTO tasks (id, userId, title, isCompleted, priority, dueDate, noteId, parentId)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?)
    `).run(id, userId, title.trim(), priority, dueDate, noteId, parentId);

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return c.json(task, 201);
  });
});

// 更新任务
tasks.put("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");

  return c.req.json().then((body: any) => {
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!existing) return c.json({ error: "Task not found" }, 404);

    const title = body.title ?? existing.title;
    const isCompleted = body.isCompleted ?? existing.isCompleted;
    const priority = body.priority ?? existing.priority;
    const dueDate = body.dueDate !== undefined ? body.dueDate : existing.dueDate;
    const noteId = body.noteId !== undefined ? body.noteId : existing.noteId;
    const parentId = body.parentId !== undefined ? body.parentId : existing.parentId;
    const sortOrder = body.sortOrder ?? existing.sortOrder;

    db.prepare(`
      UPDATE tasks SET title = ?, isCompleted = ?, priority = ?, dueDate = ?,
        noteId = ?, parentId = ?, sortOrder = ?, updatedAt = datetime('now')
      WHERE id = ?
    `).run(title, isCompleted, priority, dueDate, noteId, parentId, sortOrder, id);

    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return c.json(updated);
  });
});

// 切换完成状态（快捷操作）
tasks.patch("/:id/toggle", (c) => {
  const db = getDb();
  const id = c.req.param("id");

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  if (!task) return c.json({ error: "Task not found" }, 404);

  const newStatus = task.isCompleted ? 0 : 1;
  db.prepare("UPDATE tasks SET isCompleted = ?, updatedAt = datetime('now') WHERE id = ?").run(newStatus, id);

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return c.json(updated);
});

// 删除任务
tasks.delete("/:id", (c) => {
  const db = getDb();
  const id = c.req.param("id");

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!task) return c.json({ error: "Task not found" }, 404);

  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return c.json({ success: true });
});

export default tasks;
