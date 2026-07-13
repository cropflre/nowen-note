import { Hono } from "hono";
import type Database from "better-sqlite3";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole } from "../middleware/acl";
import {
  buildFtsSearchTerm,
  countSearchTermOccurrences,
  normalizeSearchText,
  splitSearchTerms,
} from "../lib/searchQuery";

const app = new Hono();
const registeredSearchDatabases = new WeakSet<object>();

type MatchField = "title" | "content" | "tag" | "attachment";

type SearchRow = {
  id: string;
  userId: string;
  notebookId: string;
  workspaceId: string | null;
  title: string;
  contentText: string;
  updatedAt: string;
  isFavorite: number;
  isPinned: number;
  contentFormat?: string;
  notebookName?: string | null;
  tagText: string;
  attachmentNames: string;
  attachmentText: string;
};

type SearchScope = {
  sql: string;
  params: unknown[];
};

type MatchSource = {
  field: MatchField;
  label: string;
  text: string;
  priority: number;
};

type SearchResultWithScore = Omit<SearchRow, "contentText" | "tagText" | "attachmentNames" | "attachmentText"> & {
  snippet: string;
  titleHtml: string;
  snippetHtml: string;
  matchedField: "title" | "content" | "title+content";
  matchedFields: MatchField[];
  matchReason: MatchField;
  matchCount: number;
  score: number;
};

function escapeHtml(text: string): string {
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeWithSourceMap(source: string): {
  normalized: string;
  starts: number[];
  ends: number[];
} {
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let sourceOffset = 0;

  for (const char of source || "") {
    const normalizedChar = char
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .toLocaleLowerCase();
    for (let i = 0; i < normalizedChar.length; i += 1) {
      normalized += normalizedChar[i];
      starts.push(sourceOffset);
      ends.push(sourceOffset + char.length);
    }
    sourceOffset += char.length;
  }

  return { normalized, starts, ends };
}

function findMatchRanges(source: string, terms: string[]): Array<{ start: number; end: number }> {
  if (!source || terms.length === 0) return [];
  const mapped = normalizeWithSourceMap(source);
  const ranges: Array<{ start: number; end: number }> = [];

  for (const rawTerm of terms) {
    const term = normalizeSearchText(rawTerm);
    if (!term) continue;
    let from = 0;
    while (from < mapped.normalized.length) {
      const index = mapped.normalized.indexOf(term, from);
      if (index < 0) break;
      const endIndex = index + term.length - 1;
      const start = mapped.starts[index];
      const end = mapped.ends[endIndex];
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
      from = index + Math.max(term.length, 1);
    }
  }

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

function markPlainText(text: string, terms: string[]): string {
  if (!text) return "";
  const ranges = findMatchRanges(text, terms);
  if (ranges.length === 0) return escapeHtml(text);

  let output = "";
  let cursor = 0;
  for (const range of ranges) {
    output += escapeHtml(text.slice(cursor, range.start));
    output += `<mark>${escapeHtml(text.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  output += escapeHtml(text.slice(cursor));
  return output;
}

function findFirstMatch(source: string, terms: string[]): { index: number; length: number } | null {
  const ranges = findMatchRanges(source, terms);
  const first = ranges[0];
  return first ? { index: first.start, length: first.end - first.start } : null;
}

function buildPlainSnippet(source: string, terms: string[], label?: string): string {
  const match = findFirstMatch(source, terms);
  if (!match) return label ? `${escapeHtml(label)}：${escapeHtml(source.slice(0, 220))}` : escapeHtml(source.slice(0, 220));

  const start = Math.max(0, match.index - 70);
  const end = Math.min(source.length, match.index + match.length + 150);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < source.length ? "..." : "";
  const marked = markPlainText(source.slice(start, end), terms);
  return `${label ? `${escapeHtml(label)}：` : ""}${prefix}${marked}${suffix}`;
}

function ensureSearchSqlFunctions(db: Database.Database): void {
  if (registeredSearchDatabases.has(db as object)) return;
  db.function(
    "nowen_search_normalize",
    { deterministic: true },
    (value: unknown) => normalizeSearchText(value === null || value === undefined ? "" : String(value)),
  );
  registeredSearchDatabases.add(db as object);
}

function buildSearchScope(workspaceId: string | undefined, userId: string): SearchScope | null {
  if (workspaceId && workspaceId !== "personal") {
    const role = getUserWorkspaceRole(workspaceId, userId);
    if (!role) return null;
    return { sql: "n.workspaceId = ?", params: [workspaceId] };
  }

  return {
    sql: `((n.userId = ? AND n.workspaceId IS NULL)
      OR EXISTS (
        SELECT 1
        FROM notebook_members nm
        JOIN notebooks shared_nb ON shared_nb.id = nm.notebookId
        WHERE nm.notebookId = n.notebookId
          AND nm.userId = ?
          AND nm.status = 'active'
          AND shared_nb.userId <> ?
          AND shared_nb.isDeleted = 0
      ))`,
    params: [userId, userId, userId],
  };
}

function getUserRole(db: Database.Database, userId: string): string | null {
  const row = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role?: string } | undefined;
  return row?.role || null;
}

function checkFtsIntegrity(db: Database.Database): { healthy: boolean; detail: string } {
  try {
    // rank=1 asks FTS5 to compare the external-content index with the notes table.
    db.prepare("INSERT INTO notes_fts(notes_fts, rank) VALUES('integrity-check', 1)").run();
    return { healthy: true, detail: "ok" };
  } catch (error) {
    return {
      healthy: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function fetchFtsScores(
  db: Database.Database,
  searchTerm: string,
  scope: SearchScope,
): { scores: Map<string, number>; degraded: boolean } {
  const scores = new Map<string, number>();
  if (!searchTerm) return { scores, degraded: false };

  try {
    const rows = db.prepare(`
      SELECT n.id, bm25(notes_fts, 8.0, 1.0) AS score
      FROM notes_fts
      JOIN notes n ON notes_fts.rowid = n.rowid
      JOIN notebooks nb ON nb.id = n.notebookId
      WHERE notes_fts MATCH ?
        AND ${scope.sql}
        AND n.isTrashed = 0
        AND nb.isDeleted = 0
      ORDER BY score
      LIMIT 500
    `).all(searchTerm, ...scope.params) as Array<{ id: string; score: number }>;
    for (const row of rows) scores.set(row.id, Number(row.score) || 0);
    return { scores, degraded: false };
  } catch (error) {
    console.warn("[search] FTS ranking unavailable; using verified literal results:", error);
    return { scores, degraded: true };
  }
}

function buildSearchResult(
  row: SearchRow,
  terms: string[],
  normalizedQuery: string,
  ftsScore: number | undefined,
): SearchResultWithScore | null {
  const sources: MatchSource[] = [
    { field: "title", label: "标题", text: row.title || "", priority: 0 },
    { field: "content", label: "正文", text: row.contentText || "", priority: 1 },
    { field: "tag", label: "标签", text: row.tagText || "", priority: 2 },
    {
      field: "attachment",
      label: "附件",
      text: [row.attachmentNames, row.attachmentText].filter(Boolean).join("\n"),
      priority: 3,
    },
  ];

  // Every literal query term must have a visible source. FTS is never allowed to
  // admit a row by itself, which eliminates stale/tokenizer-only ghost results.
  const allTermsExplained = terms.every((term) =>
    sources.some((source) => countSearchTermOccurrences(source.text, term) > 0),
  );
  if (!allTermsExplained) return null;

  const matchedSources = sources
    .map((source) => ({
      ...source,
      matchCount: terms.reduce(
        (sum, term) => sum + countSearchTermOccurrences(source.text, term),
        0,
      ),
      coverage: terms.filter((term) => countSearchTermOccurrences(source.text, term) > 0).length,
      exactQuery: normalizedQuery ? normalizeSearchText(source.text).includes(normalizedQuery) : false,
    }))
    .filter((source) => source.matchCount > 0)
    .sort((a, b) =>
      Number(b.exactQuery) - Number(a.exactQuery)
      || b.coverage - a.coverage
      || a.priority - b.priority,
    );

  const primary = matchedSources[0];
  if (!primary) return null;

  const matchedFields = matchedSources.map((source) => source.field);
  const matchCount = matchedSources.reduce((sum, source) => sum + source.matchCount, 0);
  const hasTitle = matchedFields.includes("title");
  const hasContent = matchedFields.includes("content");
  const matchedField = hasTitle && hasContent ? "title+content" : hasTitle ? "title" : "content";
  const snippetHtml = buildPlainSnippet(
    primary.text,
    terms,
    primary.field === "title" || primary.field === "content" ? undefined : primary.label,
  );

  const manualScore = primary.priority * 10
    - (primary.exactQuery ? 5 : 0)
    - Math.min(matchCount, 20) / 100;

  return {
    id: row.id,
    userId: row.userId,
    notebookId: row.notebookId,
    workspaceId: row.workspaceId,
    title: row.title,
    updatedAt: row.updatedAt,
    isFavorite: row.isFavorite,
    isPinned: row.isPinned,
    contentFormat: row.contentFormat,
    notebookName: row.notebookName,
    snippet: snippetHtml,
    titleHtml: markPlainText(row.title, terms),
    snippetHtml,
    matchedField,
    matchedFields,
    matchReason: primary.field,
    matchCount,
    score: ftsScore ?? manualScore,
  };
}

app.get("/health", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const integrity = checkFtsIntegrity(db);
  return c.json({
    ...integrity,
    canRebuild: getUserRole(db, userId) === "admin",
    checkedAt: new Date().toISOString(),
  });
});

app.post("/rebuild", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  if (getUserRole(db, userId) !== "admin") {
    return c.json({ error: "仅管理员可以重建全文搜索索引" }, 403);
  }

  try {
    const rebuild = db.transaction(() => {
      db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
    });
    rebuild();
    const integrity = checkFtsIntegrity(db);
    console.info(`[search] notes_fts rebuilt by user ${userId}; healthy=${integrity.healthy}`);
    return c.json({
      success: integrity.healthy,
      ...integrity,
      rebuiltAt: new Date().toISOString(),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[search] notes_fts rebuild failed:", error);
    return c.json({ success: false, healthy: false, detail }, 500);
  }
});

app.get("/", (c) => {
  const db = getDb();
  ensureSearchSqlFunctions(db);

  const userId = c.req.header("X-User-Id") || "demo";
  const q = (c.req.query("q") || "").trim().slice(0, 200);
  const workspaceId = c.req.query("workspaceId");
  if (!q) return c.json([]);

  const scope = buildSearchScope(workspaceId, userId);
  if (!scope) return c.json({ error: "无权访问该工作区" }, 403);

  const terms = splitSearchTerms(q);
  if (terms.length === 0) return c.json([]);
  const normalizedQuery = normalizeSearchText(q);

  const perTermCondition = `(
    instr(nowen_search_normalize(COALESCE(n.title, '')), ?) > 0
    OR instr(nowen_search_normalize(COALESCE(n.contentText, '')), ?) > 0
    OR EXISTS (
      SELECT 1
      FROM note_tags nt
      JOIN tags t ON t.id = nt.tagId
      WHERE nt.noteId = n.id
        AND instr(nowen_search_normalize(COALESCE(t.name, '')), ?) > 0
    )
    OR EXISTS (
      SELECT 1
      FROM attachments a
      LEFT JOIN attachment_chunks ac ON ac.attachmentId = a.id
      WHERE a.noteId = n.id
        AND (
          instr(nowen_search_normalize(COALESCE(a.filename, '')), ?) > 0
          OR instr(nowen_search_normalize(COALESCE(ac.chunkText, '')), ?) > 0
        )
    )
  )`;
  const termSql = terms.map(() => perTermCondition).join(" AND ");
  const termParams = terms.flatMap((term) => [term, term, term, term, term]);

  const rows = db.prepare(`
    SELECT
      n.id,
      n.userId,
      n.notebookId,
      n.workspaceId,
      n.title,
      COALESCE(n.contentText, '') AS contentText,
      n.updatedAt,
      CASE WHEN EXISTS(
        SELECT 1 FROM favorites f WHERE f.noteId = n.id AND f.userId = ?
      ) THEN 1 ELSE 0 END AS isFavorite,
      n.isPinned,
      n.contentFormat,
      nb.name AS notebookName,
      COALESCE((
        SELECT group_concat(t.name, char(10))
        FROM note_tags nt
        JOIN tags t ON t.id = nt.tagId
        WHERE nt.noteId = n.id
      ), '') AS tagText,
      COALESCE((
        SELECT group_concat(a.filename, char(10))
        FROM attachments a
        WHERE a.noteId = n.id
      ), '') AS attachmentNames,
      COALESCE((
        SELECT group_concat(ac.chunkText, char(10))
        FROM attachments a
        JOIN attachment_chunks ac ON ac.attachmentId = a.id
        WHERE a.noteId = n.id
      ), '') AS attachmentText
    FROM notes n
    JOIN notebooks nb ON nb.id = n.notebookId
    WHERE ${scope.sql}
      AND n.isTrashed = 0
      AND nb.isDeleted = 0
      AND (${termSql})
    ORDER BY
      CASE
        WHEN instr(nowen_search_normalize(COALESCE(n.title, '')), ?) > 0 THEN 0
        WHEN instr(nowen_search_normalize(COALESCE(n.contentText, '')), ?) > 0 THEN 1
        ELSE 2
      END,
      n.updatedAt DESC
    LIMIT 300
  `).all(
    userId,
    ...scope.params,
    ...termParams,
    normalizedQuery,
    normalizedQuery,
  ) as SearchRow[];

  const fts = fetchFtsScores(db, buildFtsSearchTerm(q), scope);
  c.header("X-Search-Index-Status", fts.degraded ? "degraded" : "ok");

  return c.json(
    rows
      .map((row) => buildSearchResult(row, terms, normalizedQuery, fts.scores.get(row.id)))
      .filter((row): row is SearchResultWithScore => Boolean(row))
      .sort((a, b) => a.score - b.score || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100)
      .map(({ score: _score, ...row }) => row),
  );
});

export default app;
