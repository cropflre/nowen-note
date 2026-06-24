import { Hono } from "hono";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole } from "../middleware/acl";
import { buildFtsSearchTerm, hasHanText, splitSearchTerms } from "../lib/searchQuery";

const app = new Hono();

type SearchRow = {
  id: string;
  userId: string;
  notebookId: string;
  workspaceId: string | null;
  title: string;
  updatedAt: string;
  isFavorite: number;
  isPinned: number;
  snippet: string;
  titleHtml: string;
  snippetHtml: string;
  score: number;
  matchedField?: string; // 命中的字段：title, content, title+content
};

function escapeHtml(text: string): string {
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markPlainText(text: string, query: string): string {
  if (!text || !query) return escapeHtml(text || "");
  const escaped = escapeHtml(text);
  const escapedQuery = escapeHtml(query);
  if (!escapedQuery) return escaped;
  return escaped.replaceAll(escapedQuery, `<mark>${escapedQuery}</mark>`);
}

function buildPlainSnippet(title: string, contentText: string, query: string): string {
  // 优先从正文中查找命中片段
  if (contentText) {
    const index = contentText.indexOf(query);
    if (index >= 0) {
      const start = Math.max(0, index - 40);
      const end = Math.min(contentText.length, index + query.length + 80);
      const prefix = start > 0 ? "..." : "";
      const suffix = end < contentText.length ? "..." : "";
      return `${prefix}${markPlainText(contentText.slice(start, end), query)}${suffix}`;
    }
  }

  // 如果正文没有命中，从标题中查找
  if (title) {
    const index = title.indexOf(query);
    if (index >= 0) {
      return markPlainText(title, query);
    }
  }

  // 如果都没有命中，返回正文前120个字符
  const source = contentText || title || "";
  return markPlainText(source.slice(0, 120), query);
}

app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const q = (c.req.query("q") || "").trim();
  const workspaceId = c.req.query("workspaceId");
  if (!q) return c.json([]);

  const scopeParams: any[] = [];
  const scopeSql =
    workspaceId && workspaceId !== "personal"
      ? (() => {
          const role = getUserWorkspaceRole(workspaceId, userId);
          if (!role) return null;
          scopeParams.push(workspaceId);
          return "n.workspaceId = ?";
        })()
      : (() => {
          scopeParams.push(userId, userId, userId);
          return `((n.userId = ? AND n.workspaceId IS NULL)
            OR EXISTS (
              SELECT 1
              FROM notebook_members nm
              JOIN notebooks nb ON nb.id = nm.notebookId
              WHERE nm.notebookId = n.notebookId
                AND nm.userId = ?
                AND nm.status = 'active'
                AND nb.userId <> ?
                AND nb.isDeleted = 0
            ))`;
        })();

  if (!scopeSql) return c.json({ error: "无权访问该工作区" }, 403);

  const rows = new Map<string, SearchRow>();
  const searchTerm = buildFtsSearchTerm(q);

  if (searchTerm) {
    const ftsRows = db.prepare(`
      SELECT n.id, n.userId, n.notebookId, n.workspaceId, n.title, n.updatedAt,
        CASE WHEN EXISTS(SELECT 1 FROM favorites f WHERE f.noteId = n.id AND f.userId = ?) THEN 1 ELSE 0 END AS isFavorite,
        n.isPinned,
        snippet(notes_fts, 1, '<mark>', '</mark>', '...', 60) AS snippet,
        highlight(notes_fts, 0, '<mark>', '</mark>') AS titleHtml,
        snippet(notes_fts, 1, '<mark>', '</mark>', '...', 60) AS snippetHtml,
        rank AS score
      FROM notes_fts
      JOIN notes n ON notes_fts.rowid = n.rowid
      WHERE notes_fts MATCH ? AND ${scopeSql} AND n.isTrashed = 0
      ORDER BY rank
      LIMIT 100
    `).all(userId, searchTerm, ...scopeParams) as SearchRow[];

    for (const row of ftsRows) {
      // FTS 搜索默认命中标题和内容
      rows.set(row.id, { ...row, matchedField: "title+content" });
    }
  }

  if (hasHanText(q)) {
    // 拆分搜索词，使用 AND 逻辑确保所有词都必须出现
    const terms = splitSearchTerms(q).filter(Boolean);
    if (terms.length > 0) {
      // 构建 AND 条件：每个词都必须在标题或正文中出现
      const andConditions = terms.map(() => `(n.title LIKE '%' || ? || '%' OR n.contentText LIKE '%' || ? || '%')`).join(' AND ');
      const likeParams = terms.flatMap(t => [t, t]);

      const likeRows = db.prepare(`
        SELECT n.id, n.userId, n.notebookId, n.workspaceId, n.title, n.contentText, n.updatedAt,
          CASE WHEN EXISTS(SELECT 1 FROM favorites f WHERE f.noteId = n.id AND f.userId = ?) THEN 1 ELSE 0 END AS isFavorite,
          n.isPinned
        FROM notes n
        WHERE ${scopeSql} AND n.isTrashed = 0
          AND (${andConditions})
        ORDER BY n.updatedAt DESC
        LIMIT 100
      `).all(userId, ...scopeParams, ...likeParams) as Array<SearchRow & { contentText: string }>;

      for (const row of likeRows) {
        if (rows.has(row.id)) continue;
        const snippetHtml = buildPlainSnippet(row.title, row.contentText || "", q);

        // 确定命中字段
        let matchedField = "title+content";
        const titleMatch = terms.some(t => row.title?.includes(t));
        const contentMatch = terms.some(t => row.contentText?.includes(t));
        if (titleMatch && !contentMatch) matchedField = "title";
        else if (!titleMatch && contentMatch) matchedField = "content";

        rows.set(row.id, {
          id: row.id,
          userId: row.userId,
          notebookId: row.notebookId,
          workspaceId: row.workspaceId,
          title: row.title,
          updatedAt: row.updatedAt,
          isFavorite: row.isFavorite,
          isPinned: row.isPinned,
          snippet: snippetHtml,
          titleHtml: markPlainText(row.title, q),
          snippetHtml,
          score: 10,
          matchedField,
        });
      }
    }
  }

  return c.json(
    Array.from(rows.values())
      .sort((a, b) => a.score - b.score || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100)
      .map(({ score, ...row }) => ({
        ...row,
        // 确保 matchedField 字段被返回
        matchedField: row.matchedField || "title+content"
      })),
  );
});

export default app;
