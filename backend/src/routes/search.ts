import { Hono } from "hono";
import { getDb } from "../db/schema";
import { buildFtsSearchTerm } from "../lib/searchQuery";

const app = new Hono();

app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const q = c.req.query("q");
  if (!q || q.trim().length === 0) return c.json([]);

  const searchTerm = buildFtsSearchTerm(q);
  if (!searchTerm) return c.json([]);

  // Y1: isFavorite 不再来自 notes 列，按 per-user 动态计算（EXISTS favorites）。
  // 物理列 notes.isFavorite 已停止写入，新数据恒为 0，旧数据也会被前端忽略。
  const results = db.prepare(`
    SELECT n.id, n.title, n.notebookId, n.updatedAt,
      CASE WHEN EXISTS(SELECT 1 FROM favorites f WHERE f.noteId = n.id AND f.userId = ?) THEN 1 ELSE 0 END AS isFavorite,
      n.isPinned,
      snippet(notes_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM notes_fts fts
    JOIN notes n ON fts.rowid = n.rowid
    WHERE notes_fts MATCH ? AND n.userId = ? AND n.isTrashed = 0
    ORDER BY rank LIMIT 50
  `).all(userId, searchTerm, userId);

  return c.json(results);
});

export default app;
