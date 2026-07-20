import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole } from "../middleware/acl";
import {
  buildFtsSearchTerm,
  hasHanText,
  normalizeSearchText,
  splitSearchTerms,
} from "../lib/searchQuery";
import {
  getSearchIndexRebuiltAt,
  inspectSearchContentText,
  markSearchIndexRebuilt,
  repairSearchContentText,
} from "../lib/searchIndex";

const app = new Hono();
const registeredSearchDatabases = new WeakSet<object>();
const MAX_TERM_CANDIDATES = 1000;
const MAX_FETCH_CANDIDATES = 500;

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

type CandidateCollection = {
  ids: Set<string>;
  degraded: boolean;
  literalFallback: boolean;
  ftsDurationMs: number;
  metadataDurationMs: number;
  fallbackDurationMs: number;
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
  if (!match) {
    return label
      ? `${escapeHtml(label)}：${escapeHtml(source.slice(0, 220))}`
      : escapeHtml(source.slice(0, 220));
  }

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
    db.prepare("INSERT INTO notes_fts(notes_fts, rank) VALUES('integrity-check', 1)").run();
    return { healthy: true, detail: "ok" };
  } catch (error) {
    return {
      healthy: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function getFtsRowCount(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM notes_fts").get() as { count?: number } | undefined;
    return Number(row?.count) || 0;
  } catch {
    return 0;
  }
}

function fetchFtsTermCandidates(
  db: Database.Database,
  term: string,
  scope: SearchScope,
): { ids: Set<string>; degraded: boolean } {
  const ids = new Set<string>();
  const searchTerm = buildFtsSearchTerm(term);
  if (!searchTerm) return { ids, degraded: false };

  try {
    const rows = db.prepare(`
      SELECT n.id
      FROM notes_fts
      JOIN notes n ON notes_fts.rowid = n.rowid
      JOIN notebooks nb ON nb.id = n.notebookId
      WHERE notes_fts MATCH ?
        AND ${scope.sql}
        AND n.isTrashed = 0
        AND nb.isDeleted = 0
      ORDER BY bm25(notes_fts, 8.0, 1.0)
      LIMIT ${MAX_TERM_CANDIDATES}
    `).all(searchTerm, ...scope.params) as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
    return { ids, degraded: false };
  } catch (error) {
    console.warn("[search] FTS candidate lookup unavailable; enabling bounded literal fallback:", error);
    return { ids, degraded: true };
  }
}

function fetchMetadataTermCandidates(
  db: Database.Database,
  term: string,
  scope: SearchScope,
): Set<string> {
  const rows = db.prepare(`
    SELECT id FROM (
      SELECT n.id AS id
      FROM note_tags nt
      JOIN tags t ON t.id = nt.tagId
      JOIN notes n ON n.id = nt.noteId
      JOIN notebooks nb ON nb.id = n.notebookId
      WHERE ${scope.sql}
        AND n.isTrashed = 0
        AND nb.isDeleted = 0
        AND instr(nowen_search_normalize(COALESCE(t.name, '')), ?) > 0

      UNION

      SELECT n.id AS id
      FROM attachments a
      LEFT JOIN attachment_chunks ac ON ac.attachmentId = a.id
      JOIN notes n ON n.id = a.noteId
      JOIN notebooks nb ON nb.id = n.notebookId
      WHERE ${scope.sql}
        AND n.isTrashed = 0
        AND nb.isDeleted = 0
        AND (
          instr(nowen_search_normalize(COALESCE(a.filename, '')), ?) > 0
          OR instr(nowen_search_normalize(COALESCE(ac.chunkText, '')), ?) > 0
        )
    )
    LIMIT ${MAX_TERM_CANDIDATES}
  `).all(
    ...scope.params,
    term,
    ...scope.params,
    term,
    term,
  ) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function fetchLiteralTermCandidates(
  db: Database.Database,
  term: string,
  scope: SearchScope,
): Set<string> {
  const rows = db.prepare(`
    SELECT n.id
    FROM notes n
    JOIN notebooks nb ON nb.id = n.notebookId
    WHERE ${scope.sql}
      AND n.isTrashed = 0
      AND nb.isDeleted = 0
      AND (
        instr(nowen_search_normalize(COALESCE(n.title, '')), ?) > 0
        OR instr(nowen_search_normalize(COALESCE(n.contentText, '')), ?) > 0
      )
    ORDER BY n.updatedAt DESC
    LIMIT ${MAX_TERM_CANDIDATES}
  `).all(...scope.params, term, term) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function shouldUseLiteralFallback(
  term: string,
  ftsCandidateCount: number,
  degraded: boolean,
): boolean {
  if (degraded || ftsCandidateCount === 0) return true;
  const normalized = normalizeSearchText(term);
  const tokens = normalized.match(/[\p{L}\p{N}_]+/gu) || [];
  const tokenizerPreservesTerm = tokens.length === 1 && tokens[0] === normalized;
  return normalized.length < 3 || hasHanText(normalized) || !tokenizerPreservesTerm;
}

function intersectCandidateSets(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  const result = new Set(sets[0]);
  for (let i = 1; i < sets.length; i += 1) {
    for (const id of result) {
      if (!sets[i].has(id)) result.delete(id);
    }
  }
  return result;
}

function collectCandidates(
  db: Database.Database,
  terms: string[],
  scope: SearchScope,
): CandidateCollection {
  const termSets: Set<string>[] = [];
  let degraded = false;
  let literalFallback = false;
  let ftsDurationMs = 0;
  let metadataDurationMs = 0;
  let fallbackDurationMs = 0;

  for (const term of terms) {
    const ftsStarted = performance.now();
    const fts = fetchFtsTermCandidates(db, term, scope);
    ftsDurationMs += performance.now() - ftsStarted;
    degraded ||= fts.degraded;

    const metadataStarted = performance.now();
    const metadata = fetchMetadataTermCandidates(db, term, scope);
    metadataDurationMs += performance.now() - metadataStarted;

    const ids = new Set<string>([...fts.ids, ...metadata]);
    if (shouldUseLiteralFallback(term, fts.ids.size, fts.degraded)) {
      literalFallback = true;
      const fallbackStarted = performance.now();
      for (const id of fetchLiteralTermCandidates(db, term, scope)) ids.add(id);
      fallbackDurationMs += performance.now() - fallbackStarted;
    }
    termSets.push(ids);
  }

  return {
    ids: intersectCandidateSets(termSets),
    degraded,
    literalFallback,
    ftsDurationMs,
    metadataDurationMs,
    fallbackDurationMs,
  };
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
      LIMIT ${MAX_TERM_CANDIDATES}
    `).all(searchTerm, ...scope.params) as Array<{ id: string; score: number }>;
    for (const row of rows) scores.set(row.id, Number(row.score) || 0);
    return { scores, degraded: false };
  } catch (error) {
    console.warn("[search] FTS ranking unavailable; using verified literal ranking:", error);
    return { scores, degraded: true };
  }
}

function fetchCandidateRows(
  db: Database.Database,
  candidateIds: Set<string>,
  userId: string,
  scope: SearchScope,
): SearchRow[] {
  const ids = Array.from(candidateIds).slice(0, MAX_FETCH_CANDIDATES);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");

  return db.prepare(`
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
    WHERE n.id IN (${placeholders})
      AND ${scope.sql}
      AND n.isTrashed = 0
      AND nb.isDeleted = 0
    ORDER BY n.updatedAt DESC
  `).all(userId, ...ids, ...scope.params) as SearchRow[];
}

function countNormalizedOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  let count = 0;
  let from = 0;
  while (from < haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    count += 1;
    from = index + Math.max(needle.length, 1);
  }
  return count;
}

function buildSearchResult(
  row: SearchRow,
  terms: string[],
  normalizedQuery: string,
  ftsScore: number | undefined,
): SearchResultWithScore | null {
  const normalizedTerms = terms.map(normalizeSearchText).filter(Boolean);
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

  const evaluated = sources.map((source) => {
    const normalized = normalizeSearchText(source.text);
    const termCounts = normalizedTerms.map((term) => countNormalizedOccurrences(normalized, term));
    return {
      ...source,
      normalized,
      termCounts,
      matchCount: termCounts.reduce((sum, count) => sum + count, 0),
      coverage: termCounts.filter((count) => count > 0).length,
      exactQuery: normalizedQuery ? normalized.includes(normalizedQuery) : false,
    };
  });

  const allTermsExplained = normalizedTerms.every((_, termIndex) =>
    evaluated.some((source) => source.termCounts[termIndex] > 0),
  );
  if (!allTermsExplained) return null;

  const matchedSources = evaluated
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

function setSearchTimingHeaders(
  c: Parameters<Parameters<typeof app.get>[1]>[0],
  timings: {
    candidate: CandidateCollection;
    candidateDurationMs: number;
    fetchDurationMs: number;
    rankDurationMs: number;
    renderDurationMs: number;
    totalDurationMs: number;
  },
): void {
  const { candidate } = timings;
  c.header("X-Search-Index-Status", candidate.degraded ? "degraded" : "ok");
  c.header("X-Search-Candidate-Count", String(candidate.ids.size));
  c.header("X-Search-Literal-Fallback", candidate.literalFallback ? "1" : "0");
  c.header(
    "Server-Timing",
    [
      `candidate;dur=${timings.candidateDurationMs.toFixed(1)}`,
      `fts;dur=${candidate.ftsDurationMs.toFixed(1)}`,
      `metadata;dur=${candidate.metadataDurationMs.toFixed(1)}`,
      `fallback;dur=${candidate.fallbackDurationMs.toFixed(1)}`,
      `fetch;dur=${timings.fetchDurationMs.toFixed(1)}`,
      `rank;dur=${timings.rankDurationMs.toFixed(1)}`,
      `render;dur=${timings.renderDurationMs.toFixed(1)}`,
      `total;dur=${timings.totalDurationMs.toFixed(1)}`,
    ].join(", "),
  );
}

app.get("/health", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const integrity = checkFtsIntegrity(db);
  const diagnostics = inspectSearchContentText(db);
  return c.json({
    ...integrity,
    ...diagnostics,
    ftsRowCount: getFtsRowCount(db),
    lastRebuiltAt: getSearchIndexRebuiltAt(db),
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
    const rebuiltAt = new Date().toISOString();
    const repair = db.transaction(() => {
      const result = repairSearchContentText(db);
      db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
      markSearchIndexRebuilt(db, rebuiltAt);
      return result;
    })();
    const integrity = checkFtsIntegrity(db);
    const diagnostics = inspectSearchContentText(db);
    console.info(
      `[search] index rebuilt by user ${userId}; repaired=${repair.repairedCount}; healthy=${integrity.healthy}`,
    );
    return c.json({
      success: integrity.healthy && diagnostics.staleContentTextCount === 0,
      ...integrity,
      ...diagnostics,
      repairedCount: repair.repairedCount,
      ftsRowCount: getFtsRowCount(db),
      rebuiltAt,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[search] notes_fts rebuild failed:", error);
    return c.json({ success: false, healthy: false, detail }, 500);
  }
});

app.get("/", (c) => {
  const totalStarted = performance.now();
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

  const candidateStarted = performance.now();
  const candidate = collectCandidates(db, terms, scope);
  const candidateDurationMs = performance.now() - candidateStarted;

  if (candidate.ids.size === 0) {
    setSearchTimingHeaders(c, {
      candidate,
      candidateDurationMs,
      fetchDurationMs: 0,
      rankDurationMs: 0,
      renderDurationMs: 0,
      totalDurationMs: performance.now() - totalStarted,
    });
    return c.json([]);
  }

  const fetchStarted = performance.now();
  const rows = fetchCandidateRows(db, candidate.ids, userId, scope);
  const fetchDurationMs = performance.now() - fetchStarted;

  const rankStarted = performance.now();
  const fts = fetchFtsScores(db, buildFtsSearchTerm(q), scope);
  candidate.degraded ||= fts.degraded;
  const rankDurationMs = performance.now() - rankStarted;

  const renderStarted = performance.now();
  const results = rows
    .map((row) => buildSearchResult(row, terms, normalizedQuery, fts.scores.get(row.id)))
    .filter((row): row is SearchResultWithScore => Boolean(row))
    .sort((a, b) => a.score - b.score || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 100)
    .map(({ score: _score, ...row }) => row);
  const renderDurationMs = performance.now() - renderStarted;

  setSearchTimingHeaders(c, {
    candidate,
    candidateDurationMs,
    fetchDurationMs,
    rankDurationMs,
    renderDurationMs,
    totalDurationMs: performance.now() - totalStarted,
  });
  return c.json(results);
});

export default app;
