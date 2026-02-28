import { Hono } from "hono";
import { getDb } from "../db/schema";

const app = new Hono();

// 获取所有笔记（含完整内容）+ 笔记本信息，用于前端打包导出
app.get("/notes", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  const notes = db.prepare(`
    SELECT n.id, n.title, n.content, n.contentText, n.createdAt, n.updatedAt,
           nb.name as notebookName
    FROM notes n
    LEFT JOIN notebooks nb ON n.notebookId = nb.id
    WHERE n.userId = ? AND n.isTrashed = 0
    ORDER BY nb.name, n.title
  `).all(userId);

  return c.json(notes);
});

// 导入笔记（批量）
app.post("/import", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const body = await c.req.json();
  const { notes, notebookId } = body as {
    notes: { title: string; content: string; contentText: string; createdAt?: string; updatedAt?: string }[];
    notebookId?: string;
  };

  if (!notes || !Array.isArray(notes) || notes.length === 0) {
    return c.json({ error: "No notes provided" }, 400);
  }

  // 如果没指定 notebookId，找或创建一个"导入的笔记"笔记本
  let targetNotebookId = notebookId;
  if (!targetNotebookId) {
    const existing = db.prepare(
      "SELECT id FROM notebooks WHERE userId = ? AND name = '导入的笔记'"
    ).get(userId) as { id: string } | undefined;

    if (existing) {
      targetNotebookId = existing.id;
    } else {
      const { v4: uuid } = require("uuid");
      targetNotebookId = uuid();
      db.prepare(
        "INSERT INTO notebooks (id, userId, name, icon) VALUES (?, ?, '导入的笔记', '📥')"
      ).run(targetNotebookId, userId);
    }
  }

  const insertWithDates = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDefault = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const { v4: uuid } = require("uuid");
  const imported: any[] = [];

  const tx = db.transaction(() => {
    for (const note of notes) {
      const id = uuid();
      if (note.createdAt || note.updatedAt) {
        const createdAt = note.createdAt || new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
        const updatedAt = note.updatedAt || createdAt;
        insertWithDates.run(id, userId, targetNotebookId, note.title, note.content, note.contentText, createdAt, updatedAt);
      } else {
        insertDefault.run(id, userId, targetNotebookId, note.title, note.content, note.contentText);
      }
      imported.push({ id, title: note.title });
    }
  });
  tx();

  return c.json({
    success: true,
    count: imported.length,
    notebookId: targetNotebookId,
    notes: imported,
  }, 201);
});

export default app;
