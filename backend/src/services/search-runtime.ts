import { performance } from "node:perf_hooks";

import type { DatabaseAdapter } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";
import {
  normalizeSearchText,
  splitSearchTerms,
} from "../lib/searchQuery";

const MAX_QUERY_LENGTH = 200;
const MAX_TERMS = 20;
const MAX_CANDIDATES = 500;
const MAX_RESULTS = 100;

type MatchField = "title" | "content" | "tag" | "attachment";

type SearchCandidateRow = {
  id: string;
  userId: string;
  notebookId: string;
  workspaceId: string | null;
  title: string;
  contentText: string;
  updatedAt: string | Date;
  isFavorite: boolean | number;
  isPinned: boolean | number;
  contentFormat?: string;
  notebookName?: string | null;
  tagText: string;
  attachmentNames: string;
  attachmentText: string;
  ftsRank: number | string | null;
};

type MatchSource = {
  field: MatchField;
  label: string;
  text: string;
  priority: number;
};

export type SearchRuntimeResult = {
  id: string;
  userId: string;
  notebookId: string;
  workspaceId: string | null;
  title: string;
  updatedAt: string;
  isFavorite: number;
  isPinned: number;
  contentFormat?: string;
  notebookName?: string | null;
  snippet: string;
  titleHtml: string;
  snippetHtml: string;
  matchedField: "title" | "content" | "title+content";
  matchedFields: MatchField[];
  matchReason: MatchField;
  matchCount: number;
};

type RankedSearchRuntimeResult = SearchRuntimeResult & { score: number };

export type SearchRuntimeResponse = {
  results: SearchRuntimeResult[];
  diagnostics: {
    candidateCount: number;
    literalFallback: boolean;
    indexStatus: "ok" | "degraded";
    queryDurationMs: number;
    renderDurationMs: number;
    totalDurationMs: number;
  };
};

export class SearchRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 | 500 | 503,
  ) {
    super(message);
    this.name = "SearchRuntimeError";
  }
}

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

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
    for (let index = 0; index < normalizedChar.length; index += 1) {
      normalized += normalizedChar[index];
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

  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) merged.push({ ...range });
    else previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

export function markSearchText(text: string, terms: string[]): string {
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
  return output + escapeHtml(text.slice(cursor));
}

function buildSnippet(source: string, terms: string[], label?: string): string {
  const first = findMatchRanges(source, terms)[0];
  if (!first) {
    const preview = escapeHtml(source.slice(0, 220));
    return label ? `${escapeHtml(label)}：${preview}` : preview;
  }

  const start = Math.max(0, first.start - 70);
  const end = Math.min(source.length, first.end + 150);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < source.length ? "..." : "";
  const marked = markSearchText(source.slice(start, end), terms);
  return `${label ? `${escapeHtml(label)}：` : ""}${prefix}${marked}${suffix}`;
}

function countOccurrences(source: string, term: string): number {
  if (!source || !term) return 0;
  let count = 0;
  let from = 0;
  while (from < source.length) {
    const index = source.indexOf(term, from);
    if (index < 0) break;
    count += 1;
    from = index + Math.max(term.length, 1);
  }
  return count;
}

function asTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value || "");
}

function asNumberBoolean(value: boolean | number): number {
  return value === true || value === 1 ? 1 : 0;
}

export function buildSearchRuntimeResult(
  row: SearchCandidateRow,
  terms: string[],
  normalizedQuery: string,
): RankedSearchRuntimeResult | null {
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
    const termCounts = normalizedTerms.map((term) => countOccurrences(normalized, term));
    return {
      ...source,
      termCounts,
      matchCount: termCounts.reduce((sum, count) => sum + count, 0),
      coverage: termCounts.filter((count) => count > 0).length,
      exactQuery: Boolean(normalizedQuery && normalized.includes(normalizedQuery)),
    };
  });

  const explainsAllTerms = normalizedTerms.every((_, termIndex) =>
    evaluated.some((source) => source.termCounts[termIndex] > 0),
  );
  if (!explainsAllTerms) return null;

  const matchedSources = evaluated
    .filter((source) => source.matchCount > 0)
    .sort((left, right) =>
      Number(right.exactQuery) - Number(left.exactQuery)
      || right.coverage - left.coverage
      || left.priority - right.priority,
    );
  const primary = matchedSources[0];
  if (!primary) return null;

  const matchedFields = matchedSources.map((source) => source.field);
  const matchCount = matchedSources.reduce((sum, source) => sum + source.matchCount, 0);
  const hasTitle = matchedFields.includes("title");
  const hasContent = matchedFields.includes("content");
  const matchedField = hasTitle && hasContent ? "title+content" : hasTitle ? "title" : "content";
  const snippetHtml = buildSnippet(
    primary.text,
    terms,
    primary.field === "title" || primary.field === "content" ? undefined : primary.label,
  );
  const ftsRank = Number(row.ftsRank || 0);
  const score = primary.priority * 10
    - (primary.exactQuery ? 5 : 0)
    - Math.min(matchCount, 20) / 100
    - Math.min(Math.max(ftsRank, 0), 10);

  return {
    id: row.id,
    userId: row.userId,
    notebookId: row.notebookId,
    workspaceId: row.workspaceId,
    title: row.title,
    updatedAt: asTimestamp(row.updatedAt),
    isFavorite: asNumberBoolean(row.isFavorite),
    isPinned: asNumberBoolean(row.isPinned),
    contentFormat: row.contentFormat,
    notebookName: row.notebookName,
    snippet: snippetHtml,
    titleHtml: markSearchText(row.title, terms),
    snippetHtml,
    matchedField,
    matchedFields,
    matchReason: primary.field,
    matchCount,
    score,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function termNeedsLiteralFallback(term: string): boolean {
  const normalized = normalizeSearchText(term);
  const tokens = normalized.match(/[\p{L}\p{N}_]+/gu) || [];
  return normalized.length < 3
    || /\p{Script=Han}/u.test(normalized)
    || tokens.length !== 1
    || tokens[0] !== normalized;
}

function literalFallbackRequired(terms: string[]): boolean {
  return terms.some(termNeedsLiteralFallback);
}

async function assertWorkspaceReadable(
  db: DatabaseAdapter,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const access = await db.queryOne<{ allowed: boolean | number }>(`
    SELECT CASE WHEN EXISTS (
      SELECT 1
      FROM workspaces workspace
      LEFT JOIN workspace_members member
        ON member."workspaceId" = workspace.id
       AND member."userId" = ?
      WHERE workspace.id = ?
        AND (workspace."ownerId" = ? OR member."userId" IS NOT NULL)
    ) THEN 1 ELSE 0 END AS allowed
  `, [userId, workspaceId, userId]);
  if (!(access?.allowed === true || access?.allowed === 1)) {
    throw new SearchRuntimeError("无权访问该工作区", "FORBIDDEN", 403);
  }
}

function searchSql(terms: string[], workspaceId?: string): string {
  const scope = workspaceId && workspaceId !== "personal"
    ? 'n."workspaceId" = ?'
    : `(
        (n."userId" = ? AND n."workspaceId" IS NULL)
        OR EXISTS (
          SELECT 1
          FROM notebook_members shared_member
          JOIN notebooks shared_notebook
            ON shared_notebook.id = shared_member."notebookId"
          WHERE shared_member."notebookId" = n."notebookId"
            AND shared_member."userId" = ?
            AND shared_member.status = 'active'
            AND shared_notebook."userId" <> ?
            AND shared_notebook."isDeleted" = false
        )
      )`;

  const termClauses = terms.map((term) => {
    const indexed = `(
      n."searchVector" @@ plainto_tsquery('simple'::regconfig, ?)
      OR EXISTS (
        SELECT 1
        FROM note_tags indexed_note_tag
        JOIN tags indexed_tag ON indexed_tag.id = indexed_note_tag."tagId"
        WHERE indexed_note_tag."noteId" = n.id
          AND to_tsvector('simple'::regconfig, COALESCE(indexed_tag.name, ''))
              @@ plainto_tsquery('simple'::regconfig, ?)
      )
      OR EXISTS (
        SELECT 1
        FROM attachments indexed_attachment
        WHERE indexed_attachment."noteId" = n.id
          AND to_tsvector('simple'::regconfig, COALESCE(indexed_attachment.filename, ''))
              @@ plainto_tsquery('simple'::regconfig, ?)
      )
      OR EXISTS (
        SELECT 1
        FROM attachments indexed_attachment
        JOIN attachment_chunks indexed_chunk
          ON indexed_chunk."attachmentId" = indexed_attachment.id
        WHERE indexed_attachment."noteId" = n.id
          AND to_tsvector('simple'::regconfig, COALESCE(indexed_chunk."chunkText", ''))
              @@ plainto_tsquery('simple'::regconfig, ?)
      )
    )`;
    if (!termNeedsLiteralFallback(term)) return indexed;
    return `(
      ${indexed}
      OR lower(normalize(COALESCE(n.title, ''), NFKC)) LIKE ? ESCAPE '\\'
      OR lower(normalize(COALESCE(n."contentText", ''), NFKC)) LIKE ? ESCAPE '\\'
      OR lower(normalize(COALESCE(tag_data."tagText", ''), NFKC)) LIKE ? ESCAPE '\\'
      OR lower(normalize(COALESCE(attachment_data."attachmentNames", ''), NFKC)) LIKE ? ESCAPE '\\'
      OR lower(normalize(COALESCE(attachment_data."attachmentText", ''), NFKC)) LIKE ? ESCAPE '\\'
    )`;
  }).join(" AND ");

  return `
    SELECT
      n.id,
      n."userId",
      n."notebookId",
      n."workspaceId",
      n.title,
      COALESCE(n."contentText", '') AS "contentText",
      n."updatedAt",
      CASE WHEN favorite."noteId" IS NULL THEN 0 ELSE 1 END AS "isFavorite",
      n."isPinned",
      n."contentFormat",
      notebook.name AS "notebookName",
      COALESCE(tag_data."tagText", '') AS "tagText",
      COALESCE(attachment_data."attachmentNames", '') AS "attachmentNames",
      COALESCE(attachment_data."attachmentText", '') AS "attachmentText",
      ts_rank_cd(
        n."searchVector",
        websearch_to_tsquery('simple'::regconfig, ?),
        32
      ) AS "ftsRank"
    FROM notes n
    JOIN notebooks notebook ON notebook.id = n."notebookId"
    LEFT JOIN favorites favorite
      ON favorite."noteId" = n.id
     AND favorite."userId" = ?
    LEFT JOIN LATERAL (
      SELECT string_agg(DISTINCT tag.name, E'\\n') AS "tagText"
      FROM note_tags note_tag
      JOIN tags tag ON tag.id = note_tag."tagId"
      WHERE note_tag."noteId" = n.id
    ) tag_data ON true
    LEFT JOIN LATERAL (
      SELECT
        string_agg(DISTINCT attachment.filename, E'\\n') AS "attachmentNames",
        string_agg(DISTINCT chunk."chunkText", E'\\n') AS "attachmentText"
      FROM attachments attachment
      LEFT JOIN attachment_chunks chunk
        ON chunk."attachmentId" = attachment.id
      WHERE attachment."noteId" = n.id
    ) attachment_data ON true
    WHERE ${scope}
      AND n."isTrashed" = false
      AND notebook."isDeleted" = false
      AND ${termClauses}
    ORDER BY "ftsRank" DESC, n."updatedAt" DESC, n.id ASC
    LIMIT ${MAX_CANDIDATES}
  `;
}

function searchParams(
  query: string,
  terms: string[],
  userId: string,
  workspaceId?: string,
): unknown[] {
  const params: unknown[] = [query, userId];
  if (workspaceId && workspaceId !== "personal") params.push(workspaceId);
  else params.push(userId, userId, userId);

  for (const term of terms) {
    const normalized = normalizeSearchText(term);
    params.push(normalized, normalized, normalized, normalized);
    if (termNeedsLiteralFallback(term)) {
      const pattern = `%${escapeLike(normalized)}%`;
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
  }
  return params;
}

export function createSearchRuntime(adapter?: DatabaseAdapter) {
  const db = resolveAdapter(adapter);

  return {
    async health(userId: string) {
      const [health, user] = await Promise.all([
        db.queryOne<{
          columnReady: boolean | number;
          indexReady: boolean | number;
          metadataIndexesReady: boolean | number;
          noteCount: number | string;
          indexedCount: number | string;
        }>(`
          SELECT
            EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'notes'
                AND column_name = 'searchVector'
            ) AS "columnReady",
            EXISTS (
              SELECT 1 FROM pg_indexes
              WHERE schemaname = current_schema()
                AND indexname = 'idx_notes_search_vector'
            ) AS "indexReady",
            (
              SELECT COUNT(*) = 3
              FROM pg_indexes
              WHERE schemaname = current_schema()
                AND indexname IN (
                  'idx_tags_search_vector',
                  'idx_attachments_filename_search_vector',
                  'idx_attachment_chunks_search_vector'
                )
            ) AS "metadataIndexesReady",
            (SELECT COUNT(*) FROM notes) AS "noteCount",
            (SELECT COUNT(*) FROM notes WHERE "searchVector" IS NOT NULL) AS "indexedCount"
        `),
        db.queryOne<{ role: string }>("SELECT role FROM users WHERE id = ?", [userId]),
      ]);
      const columnReady = health?.columnReady === true || health?.columnReady === 1;
      const indexReady = health?.indexReady === true || health?.indexReady === 1;
      const metadataIndexesReady = health?.metadataIndexesReady === true
        || health?.metadataIndexesReady === 1;
      const noteCount = Number(health?.noteCount || 0);
      const indexedCount = Number(health?.indexedCount || 0);
      const healthy = columnReady
        && indexReady
        && metadataIndexesReady
        && indexedCount === noteCount;
      return {
        healthy,
        detail: healthy ? "ok" : "PostgreSQL search schema is incomplete",
        engine: "postgresql-tsvector",
        configuration: "simple",
        columnReady,
        indexReady,
        metadataIndexesReady,
        noteCount,
        indexedCount,
        ftsRowCount: indexedCount,
        lastRebuiltAt: null,
        canRebuild: user?.role === "admin",
        checkedAt: new Date().toISOString(),
      };
    },

    async rebuild(userId: string) {
      const user = await db.queryOne<{ role: string }>("SELECT role FROM users WHERE id = ?", [userId]);
      if (user?.role !== "admin") {
        throw new SearchRuntimeError("仅管理员可以重建全文搜索索引", "FORBIDDEN", 403);
      }
      for (const indexName of [
        "idx_notes_search_vector",
        "idx_tags_search_vector",
        "idx_attachments_filename_search_vector",
        "idx_attachment_chunks_search_vector",
      ]) {
        await db.execute(`REINDEX INDEX ${indexName}`);
      }
      for (const tableName of ["notes", "tags", "attachments", "attachment_chunks"]) {
        await db.execute(`ANALYZE ${tableName}`);
      }
      const health = await this.health(userId);
      return {
        success: health.healthy,
        ...health,
        repairedCount: 0,
        rebuiltAt: new Date().toISOString(),
      };
    },

    async search(input: {
      userId: string;
      query: string;
      workspaceId?: string;
    }): Promise<SearchRuntimeResponse> {
      const totalStarted = performance.now();
      const query = input.query.trim().slice(0, MAX_QUERY_LENGTH);
      if (!query) {
        return {
          results: [],
          diagnostics: {
            candidateCount: 0,
            literalFallback: false,
            indexStatus: "ok",
            queryDurationMs: 0,
            renderDurationMs: 0,
            totalDurationMs: performance.now() - totalStarted,
          },
        };
      }

      const terms = splitSearchTerms(query).slice(0, MAX_TERMS);
      if (terms.length === 0) {
        return {
          results: [],
          diagnostics: {
            candidateCount: 0,
            literalFallback: false,
            indexStatus: "ok",
            queryDurationMs: 0,
            renderDurationMs: 0,
            totalDurationMs: performance.now() - totalStarted,
          },
        };
      }

      if (input.workspaceId && input.workspaceId !== "personal") {
        await assertWorkspaceReadable(db, input.workspaceId, input.userId);
      }

      const queryStarted = performance.now();
      let rows: SearchCandidateRow[];
      try {
        rows = await db.queryMany<SearchCandidateRow>(
          searchSql(terms, input.workspaceId),
          searchParams(query, terms, input.userId, input.workspaceId),
        );
      } catch (error) {
        console.error("[search-runtime] PostgreSQL full-text query failed:", error);
        throw new SearchRuntimeError(
          "PostgreSQL 全文搜索暂不可用",
          "POSTGRES_SEARCH_FAILED",
          503,
        );
      }
      const queryDurationMs = performance.now() - queryStarted;

      const renderStarted = performance.now();
      const normalizedQuery = normalizeSearchText(query);
      const results = rows
        .map((row) => buildSearchRuntimeResult(row, terms, normalizedQuery))
        .filter((row): row is RankedSearchRuntimeResult => Boolean(row))
        .sort((left, right) => left.score - right.score || right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAX_RESULTS)
        .map(({ score: _score, ...row }) => row);
      const renderDurationMs = performance.now() - renderStarted;

      return {
        results,
        diagnostics: {
          candidateCount: rows.length,
          literalFallback: literalFallbackRequired(terms),
          indexStatus: "ok",
          queryDurationMs,
          renderDurationMs,
          totalDurationMs: performance.now() - totalStarted,
        },
      };
    },
  };
}

export type SearchRuntime = ReturnType<typeof createSearchRuntime>;
