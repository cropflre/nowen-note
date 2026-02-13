import { Hono } from "hono";
import { getDb } from "../db/schema";

const app = new Hono();

app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const q = c.req.query("q");
  if (!q || q.trim().length === 0) return c.json([]);

  const searchTerm = q.split(/\s+/).map((w) => `"${w}"*`).join(" AND ");

  const results = db.prepare(`
    SELECT n.id, n.title, n.notebookId, n.updatedAt, n.isFavorite, n.isPinned,
      snippet(notes_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM notes_fts fts
    JOIN notes n ON fts.rowid = n.rowid
    WHERE notes_fts MATCH ? AND n.userId = ? AND n.isTrashed = 0
    ORDER BY rank LIMIT 50
  `).all(searchTerm, userId);

  return c.json(results);
});

export default app;
