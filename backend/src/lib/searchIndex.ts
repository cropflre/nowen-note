import type Database from "better-sqlite3";
import { plainTextFromNoteContent } from "./noteBlocks";
import { normalizeSearchText } from "./searchQuery";

const SEARCH_REBUILT_AT_KEY = "search_index_last_rebuilt_at";

type SearchSourceRow = {
  id: string;
  content: string | null;
  contentText: string | null;
  contentFormat: string | null;
};

export type SearchContentDiagnostics = {
  noteCount: number;
  indexedNoteCount: number;
  emptyContentTextCount: number;
  staleContentTextCount: number;
};

export type SearchContentRepairResult = SearchContentDiagnostics & {
  repairedCount: number;
};

function normalizeContentFormat(value: string | null | undefined): string {
  if (value === "markdown" || value === "html" || value === "tiptap-json") return value;
  return "tiptap-json";
}

function collectFallbackJsonText(value: unknown, output: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectFallbackJsonText(item, output);
    return;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") output.push(record.text);
  if (record.type === "hardBreak") output.push("\n");
  if (Array.isArray(record.content)) collectFallbackJsonText(record.content, output);
}

/**
 * The server is the source of truth for text used by literal search and FTS.
 * Client-provided contentText is treated only as transport compatibility data.
 */
export function extractSearchableText(
  content: unknown,
  contentFormat: unknown,
): string {
  const source = typeof content === "string" ? content : "";
  const format = normalizeContentFormat(
    typeof contentFormat === "string" ? contentFormat : undefined,
  );

  const extracted = plainTextFromNoteContent(source, format)
    .replace(/\u0000/g, "")
    .trim();
  if (extracted || !source.trim() || format !== "tiptap-json") return extracted;

  // Historical/third-party Tiptap JSON may contain node types unknown to the block
  // index. A generic text-node traversal keeps those notes searchable instead of
  // silently producing an empty contentText.
  try {
    const parsed = JSON.parse(source);
    const output: string[] = [];
    collectFallbackJsonText(parsed, output);
    return output.join("").replace(/\u0000/g, "").trim();
  } catch {
    return "";
  }
}

function listSearchSourceRows(db: Database.Database): SearchSourceRow[] {
  return db.prepare(`
    SELECT id, COALESCE(content, '') AS content,
           COALESCE(contentText, '') AS contentText,
           COALESCE(contentFormat, 'tiptap-json') AS contentFormat
    FROM notes
  `).all() as SearchSourceRow[];
}

function isSearchTextStale(row: SearchSourceRow, extracted: string): boolean {
  return normalizeSearchText(row.contentText || "") !== normalizeSearchText(extracted);
}

export function inspectSearchContentText(db: Database.Database): SearchContentDiagnostics {
  const rows = listSearchSourceRows(db);
  let indexedNoteCount = 0;
  let emptyContentTextCount = 0;
  let staleContentTextCount = 0;

  for (const row of rows) {
    const stored = normalizeSearchText(row.contentText || "");
    const extracted = extractSearchableText(row.content || "", row.contentFormat || "tiptap-json");
    const expected = normalizeSearchText(extracted);
    if (stored) indexedNoteCount += 1;
    if (!stored && expected) emptyContentTextCount += 1;
    if (stored !== expected) staleContentTextCount += 1;
  }

  return {
    noteCount: rows.length,
    indexedNoteCount,
    emptyContentTextCount,
    staleContentTextCount,
  };
}

/**
 * Re-extract all note bodies without changing updatedAt/version. The surrounding
 * migration or rebuild endpoint already runs inside a transaction.
 */
export function repairSearchContentText(db: Database.Database): SearchContentRepairResult {
  const rows = listSearchSourceRows(db);
  const update = db.prepare("UPDATE notes SET contentText = ? WHERE id = ?");
  let repairedCount = 0;
  let indexedNoteCount = 0;

  for (const row of rows) {
    const extracted = extractSearchableText(row.content || "", row.contentFormat || "tiptap-json");
    if (isSearchTextStale(row, extracted)) {
      update.run(extracted, row.id);
      repairedCount += 1;
    }
    if (normalizeSearchText(extracted)) indexedNoteCount += 1;
  }

  return {
    noteCount: rows.length,
    indexedNoteCount,
    emptyContentTextCount: 0,
    staleContentTextCount: 0,
    repairedCount,
  };
}

export function markSearchIndexRebuilt(
  db: Database.Database,
  rebuiltAt = new Date().toISOString(),
): void {
  db.prepare(`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updatedAt = datetime('now')
  `).run(SEARCH_REBUILT_AT_KEY, rebuiltAt);
}

export function getSearchIndexRebuiltAt(db: Database.Database): string | null {
  const row = db.prepare("SELECT value FROM system_settings WHERE key = ?")
    .get(SEARCH_REBUILT_AT_KEY) as { value?: string } | undefined;
  return row?.value || null;
}
