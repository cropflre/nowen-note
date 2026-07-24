import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";

import type { NoteBlockIndexRow, NoteBlockType } from "./noteBlocks";

const SUPPORTED = new Set<string>([
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
]);
const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const MARKDOWN_BLOCK_ID_RE = /(?:\s+|^)(\^blk_[A-Za-z0-9_-]{6,})\s*$/;

interface BlockCandidate extends Omit<NoteBlockIndexRow, "blockId"> {
  blockId: string | null;
  explicitBlockId: boolean;
  markerInsertOffset?: number;
  markerStyle?: "inline" | "standalone";
}

export interface NoteBlockIndexPlan {
  content: string;
  contentText: string;
  rows: NoteBlockIndexRow[];
  changed: boolean;
}

/** @deprecated use NoteBlockIndexPlan. */
export type TiptapBlockIndexPlan = NoteBlockIndexPlan;

function makeBlockId(): string {
  return `blk_${uuid()}`;
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
}

function collectNodeText(node: any): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return String(node.text || "");
  if (node.type === "hardBreak") return "\n";
  if (!Array.isArray(node.content)) return "";
  return node.content.map(collectNodeText).join("");
}

function hashText(type: string, text: string): string {
  return createHash("sha256")
    .update(type)
    .update("\0")
    .update(text.replace(/\s+/g, " ").trim())
    .digest("hex");
}

function parseTiptap(noteId: string, content: string): {
  normalizedContent: string;
  candidates: BlockCandidate[];
  changed: boolean;
} | null {
  let doc: any;
  try {
    doc = JSON.parse(content || "{}");
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || doc.type !== "doc" || !Array.isArray(doc.content)) {
    return null;
  }

  const candidates: BlockCandidate[] = [];
  const seen = new Set<string>();
  let order = 0;
  let changed = false;

  const visit = (nodes: any[], parentBlockId: string | null, parentPath: number[]) => {
    nodes.forEach((node, index) => {
      if (!node || typeof node !== "object") return;
      const path = [...parentPath, index];
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
          path: path.join("."),
          startOffset: null,
          endOffset: null,
        });
        nextParent = blockId;
      }

      if (Array.isArray(node.content)) visit(node.content, nextParent, path);
    });
  };

  visit(doc.content, null, []);
  return {
    normalizedContent: changed ? JSON.stringify(doc) : content,
    candidates,
    changed,
  };
}

function lineOffsets(content: string): Array<{
  text: string;
  start: number;
  end: number;
  endWithNewline: number;
}> {
  const lines: Array<{ text: string; start: number; end: number; endWithNewline: number }> = [];
  let cursor = 0;
  const raw = content.split("\n");
  for (let index = 0; index < raw.length; index += 1) {
    const text = raw[index];
    const start = cursor;
    const end = start + text.length;
    const endWithNewline = end + (index < raw.length - 1 ? 1 : 0);
    lines.push({ text, start, end, endWithNewline });
    cursor = endWithNewline;
  }
  return lines;
}

function stripMarkdownMarker(raw: string): { text: string; blockId: string | null } {
  const match = raw.match(MARKDOWN_BLOCK_ID_RE);
  if (!match) return { text: raw, blockId: null };
  return {
    text: raw.slice(0, match.index).replace(/\s+$/, ""),
    blockId: match[1].slice(1),
  };
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

function parseMarkdown(noteId: string, content: string): BlockCandidate[] {
  const lines = lineOffsets(content);
  const candidates: BlockCandidate[] = [];
  let order = 0;

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.text.trim()) {
      index += 1;
      continue;
    }

    const fence = line.text.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const fenceToken = fence[1];
      let endIndex = index + 1;
      while (
        endIndex < lines.length
        && !new RegExp(`^\\s*${fenceToken[0]}{${fenceToken.length},}\\s*$`).test(lines[endIndex].text)
      ) {
        endIndex += 1;
      }
      if (endIndex < lines.length) endIndex += 1;
      let explicitBlockId: string | null = null;
      if (endIndex < lines.length) {
        const marker = lines[endIndex].text.trim().match(/^\^(blk_[A-Za-z0-9_-]{6,})$/);
        if (marker) {
          explicitBlockId = marker[1];
          endIndex += 1;
        }
      }
      const start = line.start;
      const end = endIndex > index ? lines[endIndex - 1].endWithNewline : line.endWithNewline;
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
        markerInsertOffset: endIndex > index ? lines[endIndex - 1].end : line.end,
        markerStyle: "standalone",
      });
      index = Math.max(endIndex, index + 1);
      continue;
    }

    const type = classifyMarkdownLine(line.text);
    if (!type) {
      index += 1;
      continue;
    }

    let endIndex = index + 1;
    if (type === "paragraph") {
      while (
        endIndex < lines.length
        && lines[endIndex].text.trim()
        && classifyMarkdownLine(lines[endIndex].text) === "paragraph"
        && !/^\s*(```+|~~~+)/.test(lines[endIndex].text)
      ) {
        endIndex += 1;
      }
    }
    const start = line.start;
    const end = lines[endIndex - 1].endWithNewline;
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
      markerInsertOffset: lines[endIndex - 1].end,
      markerStyle: "inline",
    });
    index = endIndex;
  }

  return candidates;
}

function assignCandidateIds(
  candidates: BlockCandidate[],
  previousRows: ReadonlyArray<Pick<NoteBlockIndexRow, "blockId" | "blockType" | "contentHash" | "blockOrder">>,
): void {
  const reusable = new Map<string, string[]>();
  for (const row of [...previousRows].sort((left, right) => left.blockOrder - right.blockOrder)) {
    const key = `${row.blockType}:${row.contentHash}`;
    const values = reusable.get(key) || [];
    values.push(row.blockId);
    reusable.set(key, values);
  }

  const used = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.blockId && !used.has(candidate.blockId)) {
      used.add(candidate.blockId);
      continue;
    }
    const key = `${candidate.blockType}:${candidate.contentHash}`;
    const values = reusable.get(key) || [];
    let reused: string | undefined;
    while (values.length > 0 && !reused) {
      const value = values.shift();
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
    .sort((left, right) => right.offset - left.offset);
  let output = content;
  for (const insert of inserts) {
    output = output.slice(0, insert.offset) + insert.text + output.slice(insert.offset);
  }
  return output;
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

function htmlText(content: string): string {
  return content
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the authoritative Block index without touching a database.
 *
 * Markdown mirrors the SQLite indexer: stable IDs are reused by block type and
 * content hash, new markers are persisted into the body, then offsets are
 * recalculated against that normalized body. HTML remains a non-block format
 * and therefore only derives searchable plain text.
 */
export function buildNoteBlockIndexPlan(
  noteId: string,
  content: string,
  contentFormat: string,
  previousRows: ReadonlyArray<Pick<NoteBlockIndexRow, "blockId" | "blockType" | "contentHash" | "blockOrder">> = [],
): NoteBlockIndexPlan | null {
  if (contentFormat === "html") {
    return {
      content,
      contentText: htmlText(content),
      rows: [],
      changed: false,
    };
  }

  if (contentFormat === "tiptap-json") {
    const parsed = parseTiptap(noteId, content);
    if (!parsed) return null;
    const rows = materializeRows(parsed.candidates);
    return {
      content: parsed.normalizedContent,
      contentText: rows.map((row) => row.plainText).filter(Boolean).join("\n\n"),
      rows,
      changed: parsed.normalizedContent !== content,
    };
  }

  if (contentFormat !== "markdown") return null;

  const initialCandidates = parseMarkdown(noteId, content);
  assignCandidateIds(initialCandidates, previousRows);
  const normalizedContent = applyMarkdownIds(content, initialCandidates);
  let candidates = initialCandidates;

  if (normalizedContent !== content) {
    const reparsed = parseMarkdown(noteId, normalizedContent);
    const byOrder = new Map(initialCandidates.map((candidate) => [candidate.blockOrder, candidate.blockId]));
    reparsed.forEach((candidate) => {
      candidate.blockId = candidate.blockId || byOrder.get(candidate.blockOrder) || makeBlockId();
      candidate.explicitBlockId = true;
    });
    candidates = reparsed;
  }

  const rows = materializeRows(candidates);
  return {
    content: normalizedContent,
    contentText: rows.map((row) => row.plainText).filter(Boolean).join("\n\n"),
    rows,
    changed: normalizedContent !== content,
  };
}

export function buildTiptapBlockIndexPlan(
  noteId: string,
  content: string,
): TiptapBlockIndexPlan | null {
  return buildNoteBlockIndexPlan(noteId, content, "tiptap-json");
}
