import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import type Database from "better-sqlite3";

export const SUPPORTED_NOTE_BLOCK_TYPES = [
  "heading",
  "paragraph",
  "listItem",
  "taskItem",
  "blockquote",
  "codeBlock",
  "table",
  "video",
  "blockEmbed",
  "mathBlock",
] as const;

export type NoteBlockType = typeof SUPPORTED_NOTE_BLOCK_TYPES[number];

export interface NoteBlockIndexRow {
  noteId: string;
  blockId: string;
  blockType: NoteBlockType;
  parentBlockId: string | null;
  blockOrder: number;
  plainText: string;
  contentHash: string;
  path: string;
  startOffset: number | null;
  endOffset: number | null;
  createdAt?: string;
  updatedAt?: string;
}

interface BlockCandidate extends Omit<NoteBlockIndexRow, "blockId"> {
  blockId: string | null;
  explicitBlockId: boolean;
  markerInsertOffset?: number;
  markerStyle?: "inline" | "standalone";
}

const SUPPORTED = new Set<string>(SUPPORTED_NOTE_BLOCK_TYPES);
const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const MARKDOWN_BLOCK_ID_RE = /(?:\s+|^)(\^blk_[A-Za-z0-9_-]{6,})\s*$/;

function makeBlockId(): string {
  return `blk_${uuid()}`;
}

function hashText(type: string, text: string): string {
  return createHash("sha256")
    .update(type)
    .update("\0")
    .update(text.replace(/\s+/g, " ").trim())
    .digest("hex");
}

function collectNodeText(node: any): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return String(node.text || "");
  if (node.type === "hardBreak") return "\n";
  if (!Array.isArray(node.content)) return "";
  return node.content.map(collectNodeText).join("");
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
}

function parseTiptap(noteId: string, content: string): {
  normalizedContent: string;
  candidates: BlockCandidate[];
  changed: boolean;
} {
  let doc: any;
  try {
    doc = JSON.parse(content || "{}");
  } catch {
    return { normalizedContent: content, candidates: [], changed: false };
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.content)) {
    return { normalizedContent: content, candidates: [], changed: false };
  }

  const seen = new Set<string>();
  const candidates: BlockCandidate[] = [];
  let order = 0;
  let changed = false;

  const visit = (nodes: any[], parentBlockId: string | null, path: number[]) => {
    nodes.forEach((node, index) => {
      if (!node || typeof node !== "object") return;
      const currentPath = [...path, index];
      let nextParent = parentBlockId;

      if (SUPPORTED.has(node.type)) {
        const attrs = node.attrs && typeof node.attrs === "object" ? { ...node.attrs } : {};
        let blockId = validBlockId(attrs.blockId) ? attrs.blockId : null;
        if (!blockId || seen.has(blockId)) {
          blockId = makeBlockId();
          attrs.blockId = blockId;
          node.attrs = attrs;
          changed = true;
        }
        seen.add(blockId);
        const plainText = collectNodeText(node).replace(/\u0000/g, "").trim();
        candidates.push({
          noteId,
          blockId,
          explicitBlockId: true,
          blockType: node.type as NoteBlockType,
          parentBlockId,
          blockOrder: order++,
          plainText,
          contentHash: hashText(node.type, plainText),
          path: currentPath.join("."),
          startOffset: null,
          endOffset: null,
        });
        nextParent = blockId;
      }

      if (Array.isArray(node.content)) visit(node.content, nextParent, currentPath);
    });
  };

  visit(doc.content, null, []);
  return {
    normalizedContent: changed ? JSON.stringify(doc) : content,
    candidates,
    changed,
  };
}

function lineOffsets(content: string): Array<{ text: string; start: number; end: number; endWithNewline: number }> {
  const lines: Array<{ text: string; start: number; end: number; endWithNewline: number }> = [];
  let cursor = 0;
  const raw = content.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i];
    const start = cursor;
    const end = start + text.length;
    const endWithNewline = end + (i < raw.length - 1 ? 1 : 0);
    lines.push({ text, start, end, endWithNewline });
    cursor = endWithNewline;
  }
  return lines;
}

function stripMarkdownMarker(raw: string): { text: string; blockId: string | null } {
  const match = raw.match(MARKDOWN_BLOCK_ID_RE);
  if (!match) return { text: raw, blockId: null };
  const blockId = match[1].slice(1);
  return { text: raw.slice(0, match.index).replace(/\s+$/, ""), blockId };
}

function classifyMarkdownLine(line: string): NoteBlockType | null {
  if (/^\s{0,3}#{1,6}\s+/.test(line)) return "heading";
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) return "taskItem";
  if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) return "listItem";
  if (/^\s{0,3}>\s?/.test(line)) return "blockquote";
  return line.trim() ? "paragraph" : null;
}

function cleanMarkdownText(type: NoteBlockType, value: string): string {
  let text = value.trim();
  if (type === "heading") text = text.replace(/^#{1,6}\s+/, "");
  else if (type === "taskItem") text = text.replace(/^[-*+]\s+\[[ xX]\]\s+/, "");
  else if (type === "listItem") text = text.replace(/^(?:[-*+]|\d+\.)\s+/, "");
  else if (type === "blockquote") text = text.replace(/^>\s?/, "");
  return text.replace(/\s+\^blk_[A-Za-z0-9_-]{6,}\s*$/, "").trim();
}

function parseMarkdown(noteId: string, content: string): {
  normalizedContent: string;
  candidates: BlockCandidate[];
  changed: boolean;
} {
  const lines = lineOffsets(content);
  const candidates: BlockCandidate[] = [];
  let order = 0;

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.text.trim()) {
      i++;
      continue;
    }

    const fence = line.text.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const fenceToken = fence[1];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s*${fenceToken[0]}{${fenceToken.length},}\\s*$`).test(lines[j].text)) j++;
      if (j < lines.length) j++;
      let markerLine = j;
      let explicitBlockId: string | null = null;
      if (markerLine < lines.length) {
        const marker = lines[markerLine].text.trim().match(/^\^(blk_[A-Za-z0-9_-]{6,})$/);
        if (marker) {
          explicitBlockId = marker[1];
          j++;
        }
      }
      const start = line.start;
      const end = (j > i ? lines[j - 1].endWithNewline : line.endWithNewline);
      const raw = content.slice(start, end);
      const plainText = raw
        .replace(/^\s*(```+|~~~+)[^\n]*\n?/, "")
        .replace(/\n?\s*(```+|~~~+)\s*(?:\n\^blk_[A-Za-z0-9_-]+)?\s*$/, "")
        .trim();
      candidates.push({
        noteId,
        blockId: explicitBlockId,
        explicitBlockId: Boolean(explicitBlockId),
        blockType: "codeBlock",
        parentBlockId: null,
        blockOrder: order++,
        plainText,
        contentHash: hashText("codeBlock", plainText),
        path: String(order - 1),
        startOffset: start,
        endOffset: end,
        markerInsertOffset: (j > i ? lines[j - 1].end : line.end),
        markerStyle: "standalone",
      });
      i = Math.max(j, i + 1);
      continue;
    }

    const type = classifyMarkdownLine(line.text);
    if (!type) {
      i++;
      continue;
    }

    let j = i + 1;
    if (type === "paragraph") {
      while (j < lines.length && lines[j].text.trim() && classifyMarkdownLine(lines[j].text) === "paragraph" && !/^\s*(```+|~~~+)/.test(lines[j].text)) {
        j++;
      }
    }
    const start = line.start;
    const end = lines[j - 1].endWithNewline;
    const raw = content.slice(start, end).replace(/\n$/, "");
    const stripped = stripMarkdownMarker(raw);
    const plainText = cleanMarkdownText(type, stripped.text.replace(/\n/g, " "));
    candidates.push({
      noteId,
      blockId: stripped.blockId,
      explicitBlockId: Boolean(stripped.blockId),
      blockType: type,
      parentBlockId: null,
      blockOrder: order++,
      plainText,
      contentHash: hashText(type, plainText),
      path: String(order - 1),
      startOffset: start,
      endOffset: end,
      markerInsertOffset: lines[j - 1].end,
      markerStyle: "inline",
    });
    i = j;
  }

  return { normalizedContent: content, candidates, changed: false };
}

export function ensureNoteBlockTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_blocks_index (
      noteId TEXT NOT NULL,
      blockId TEXT NOT NULL,
      blockType TEXT NOT NULL,
      parentBlockId TEXT,
      blockOrder INTEGER NOT NULL DEFAULT 0,
      plainText TEXT NOT NULL DEFAULT '',
      contentHash TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      startOffset INTEGER,
      endOffset INTEGER,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (noteId, blockId),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_note_blocks_block_id ON note_blocks_index(blockId);
    CREATE INDEX IF NOT EXISTS idx_note_blocks_note_order ON note_blocks_index(noteId, blockOrder);
    CREATE INDEX IF NOT EXISTS idx_note_blocks_hash ON note_blocks_index(noteId, blockType, contentHash);

    CREATE TABLE IF NOT EXISTS block_operations (
      userId TEXT NOT NULL,
      operationId TEXT NOT NULL,
      noteId TEXT NOT NULL,
      resultJson TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (userId, operationId),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_block_operations_note ON block_operations(noteId, createdAt DESC);
  `);
}

function assignCandidateIds(
  db: Database.Database,
  noteId: string,
  candidates: BlockCandidate[],
): void {
  const previous = db.prepare(`
    SELECT blockId, blockType, contentHash, blockOrder
    FROM note_blocks_index
    WHERE noteId = ?
    ORDER BY blockOrder ASC
  `).all(noteId) as Array<{ blockId: string; blockType: string; contentHash: string; blockOrder: number }>;

  const reusable = new Map<string, string[]>();
  for (const row of previous) {
    const key = `${row.blockType}:${row.contentHash}`;
    const list = reusable.get(key) || [];
    list.push(row.blockId);
    reusable.set(key, list);
  }

  const used = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.blockId && !used.has(candidate.blockId)) {
      used.add(candidate.blockId);
      continue;
    }
    const key = `${candidate.blockType}:${candidate.contentHash}`;
    const list = reusable.get(key) || [];
    let reused: string | undefined;
    while (list.length > 0 && !reused) {
      const value = list.shift();
      if (value && !used.has(value)) reused = value;
    }
    candidate.blockId = reused || makeBlockId();
    used.add(candidate.blockId);
  }
}

function applyMarkdownIds(content: string, candidates: BlockCandidate[]): string {
  const inserts = candidates
    .filter((candidate) => !candidate.explicitBlockId && candidate.markerInsertOffset != null && candidate.blockId)
    .map((candidate) => ({
      offset: candidate.markerInsertOffset as number,
      text: candidate.markerStyle === "standalone" ? `\n^${candidate.blockId}` : ` ^${candidate.blockId}`,
    }))
    .sort((a, b) => b.offset - a.offset);
  let out = content;
  for (const insert of inserts) out = out.slice(0, insert.offset) + insert.text + out.slice(insert.offset);
  return out;
}

function materializeRows(candidates: BlockCandidate[]): NoteBlockIndexRow[] {
  return candidates.map((candidate) => ({
    noteId: candidate.noteId,
    blockId: candidate.blockId as string,
    blockType: candidate.blockType,
    parentBlockId: candidate.parentBlockId,
    blockOrder: candidate.blockOrder,
    plainText: candidate.plainText,
    contentHash: candidate.contentHash,
    path: candidate.path,
    startOffset: candidate.startOffset,
    endOffset: candidate.endOffset,
  }));
}

export function syncNoteBlocks(
  db: Database.Database,
  noteId: string,
  content: string,
  contentFormat: string,
): { content: string; contentText: string; blocks: NoteBlockIndexRow[]; changed: boolean } {
  ensureNoteBlockTables(db);
  if (contentFormat === "html") {
    db.prepare("DELETE FROM note_blocks_index WHERE noteId = ?").run(noteId);
    return {
      content,
      contentText: content.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      blocks: [],
      changed: false,
    };
  }
  const parsed = contentFormat === "tiptap-json"
    ? parseTiptap(noteId, content)
    : parseMarkdown(noteId, content);
  assignCandidateIds(db, noteId, parsed.candidates);

  let normalizedContent = parsed.normalizedContent;
  if (contentFormat === "markdown") normalizedContent = applyMarkdownIds(normalizedContent, parsed.candidates);
  const changed = normalizedContent !== content;

  // Reparse Markdown after marker insertion so offsets stored in the index match the persisted text.
  let candidates = parsed.candidates;
  if (contentFormat === "markdown" && changed) {
    const reparsed = parseMarkdown(noteId, normalizedContent);
    const byOrder = new Map(parsed.candidates.map((candidate) => [candidate.blockOrder, candidate.blockId]));
    reparsed.candidates.forEach((candidate) => {
      candidate.blockId = candidate.blockId || byOrder.get(candidate.blockOrder) || makeBlockId();
      candidate.explicitBlockId = true;
    });
    candidates = reparsed.candidates;
  }

  const rows = materializeRows(candidates);
  const contentText = rows.map((row) => row.plainText).filter(Boolean).join("\n\n");
  const insert = db.prepare(`
    INSERT INTO note_blocks_index (
      noteId, blockId, blockType, parentBlockId, blockOrder, plainText,
      contentHash, path, startOffset, endOffset, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM note_blocks_index WHERE noteId = ?").run(noteId);
    for (const row of rows) {
      insert.run(
        row.noteId,
        row.blockId,
        row.blockType,
        row.parentBlockId,
        row.blockOrder,
        row.plainText,
        row.contentHash,
        row.path,
        row.startOffset,
        row.endOffset,
      );
    }
    if (changed) {
      db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
        .run(normalizedContent, contentText, noteId);
    }
  });
  tx();
  return { content: normalizedContent, contentText, blocks: rows, changed };
}

export function ensureNoteIndexed(db: Database.Database, noteId: string): NoteBlockIndexRow[] {
  ensureNoteBlockTables(db);
  const note = db.prepare("SELECT content, contentFormat FROM notes WHERE id = ?").get(noteId) as
    | { content: string; contentFormat: string }
    | undefined;
  if (!note) return [];
  return syncNoteBlocks(db, noteId, note.content || "", note.contentFormat || "tiptap-json").blocks;
}

export function getNoteBlocks(db: Database.Database, noteId: string, limit = 500): NoteBlockIndexRow[] {
  ensureNoteBlockTables(db);
  return db.prepare(`
    SELECT noteId, blockId, blockType, parentBlockId, blockOrder, plainText,
           contentHash, path, startOffset, endOffset, createdAt, updatedAt
    FROM note_blocks_index
    WHERE noteId = ?
    ORDER BY blockOrder ASC
    LIMIT ?
  `).all(noteId, limit) as NoteBlockIndexRow[];
}

export function getNoteBlock(
  db: Database.Database,
  noteId: string,
  blockId: string,
): NoteBlockIndexRow | null {
  ensureNoteBlockTables(db);
  return (db.prepare(`
    SELECT noteId, blockId, blockType, parentBlockId, blockOrder, plainText,
           contentHash, path, startOffset, endOffset, createdAt, updatedAt
    FROM note_blocks_index
    WHERE noteId = ? AND blockId = ?
  `).get(noteId, blockId) as NoteBlockIndexRow | undefined) || null;
}

export function searchNoteBlocks(
  db: Database.Database,
  query: string,
  options: { notebookId?: string; allowedNotebookIds?: string[]; limit?: number } = {},
): Array<NoteBlockIndexRow & { title: string; notebookId: string; updatedAt: string }> {
  ensureNoteBlockTables(db);
  const limit = Math.min(Math.max(options.limit || 50, 1), 200);
  const clauses = ["n.isTrashed = 0", "b.plainText LIKE ?"];
  const params: unknown[] = [`%${query.replace(/[\\%_]/g, "\\$&")}%`];
  if (options.notebookId) {
    clauses.push("n.notebookId = ?");
    params.push(options.notebookId);
  }
  if (options.allowedNotebookIds) {
    if (options.allowedNotebookIds.length === 0) return [];
    clauses.push(`n.notebookId IN (${options.allowedNotebookIds.map(() => "?").join(",")})`);
    params.push(...options.allowedNotebookIds);
  }
  params.push(limit);
  return db.prepare(`
    SELECT b.noteId, b.blockId, b.blockType, b.parentBlockId, b.blockOrder,
           b.plainText, b.contentHash, b.path, b.startOffset, b.endOffset,
           b.createdAt, b.updatedAt, n.title, n.notebookId, n.updatedAt AS updatedAt
    FROM note_blocks_index b
    JOIN notes n ON n.id = b.noteId
    WHERE ${clauses.join(" AND ")}
    ORDER BY n.updatedAt DESC, b.blockOrder ASC
    LIMIT ?
  `).all(...params) as Array<NoteBlockIndexRow & { title: string; notebookId: string; updatedAt: string }>;
}

export function plainTextFromNoteContent(content: string, contentFormat: string): string {
  if (contentFormat === "html") {
    return content.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  const parsed = contentFormat === "tiptap-json"
    ? parseTiptap("", content).candidates
    : parseMarkdown("", content).candidates;
  return parsed.map((block) => block.plainText).filter(Boolean).join("\n\n");
}
