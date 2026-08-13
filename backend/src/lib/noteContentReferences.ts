import type { NoteLinkEntry } from "../repositories/types";

const ATTACHMENT_ID_RE =
  /\/api\/attachments\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;
const NOTE_LINK_RE = /\[\[note:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:#blk:([a-zA-Z0-9_-]+))?(?:\|([^\]]*))?\]\]/g;
const NOTE_HREF_RE = /note:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:#blk:([a-zA-Z0-9_-]+))?/g;
const SOURCE_BLOCK_TYPES = new Set(["heading", "paragraph", "listItem", "taskItem", "blockquote", "codeBlock"]);
const MARKDOWN_BLOCK_ID_RE = /(?:\s+|^)\^(blk_[A-Za-z0-9_-]{6,})\s*$/;

export function extractAttachmentIdsFromContent(
  content: string | null | undefined,
): Set<string> {
  const output = new Set<string>();
  if (!content || typeof content !== "string") return output;
  if (!content.includes("/api/attachments/")) return output;

  const pattern = new RegExp(ATTACHMENT_ID_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    output.add(match[1].toLowerCase());
  }
  return output;
}

function addEntry(entries: NoteLinkEntry[], seen: Set<string>, entry: NoteLinkEntry): void {
  const key = `${entry.sourceBlockId || ""}:${entry.targetNoteId}:${entry.targetBlockId || ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  entries.push(entry);
}

function entriesFromText(
  text: string,
  sourceBlockId: string | null,
  entries: NoteLinkEntry[],
  seen: Set<string>,
): void {
  const excerpt = text.replace(MARKDOWN_BLOCK_ID_RE, "").replace(/\s+/g, " ").trim().slice(0, 240) || null;
  for (const match of text.matchAll(NOTE_LINK_RE)) {
    const targetNoteId = match[1].toLowerCase();
    const targetBlockId = match[2] || null;
    const displayText = match[3] || null;
    addEntry(entries, seen, {
      targetNoteId,
      targetBlockId,
      sourceBlockId,
      linkType: targetBlockId ? "block" : "note",
      linkText: displayText,
      excerpt: excerpt || displayText,
    });
  }
  for (const match of text.matchAll(NOTE_HREF_RE)) {
    const targetNoteId = match[1].toLowerCase();
    const targetBlockId = match[2] || null;
    addEntry(entries, seen, {
      targetNoteId,
      targetBlockId,
      sourceBlockId,
      linkType: targetBlockId ? "block" : "note",
      linkText: null,
      excerpt,
    });
  }
}

function isMarkdownStandaloneBlock(line: string): boolean {
  return (
    /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)
    || /^\s*(?:[-*+]|\d+\.)\s+/.test(line)
    || /^\s{0,3}>\s?/.test(line)
    || /^\s*(```+|~~~+)/.test(line)
  );
}

function extractMarkdownLinks(content: string, entries: NoteLinkEntry[], seen: Set<string>): void {
  const lines = content.split("\n");
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const start = index;
    const fence = lines[index].match(/^\s*(```+|~~~+)/);
    if (fence) {
      const marker = fence[1];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) {
        index += 1;
      }
      if (index < lines.length) index += 1;
      if (index < lines.length && /^\s*\^blk_[A-Za-z0-9_-]{6,}\s*$/.test(lines[index])) index += 1;
    } else if (isMarkdownStandaloneBlock(lines[index])) {
      index += 1;
    } else {
      index += 1;
      while (
        index < lines.length
        && lines[index].trim()
        && !isMarkdownStandaloneBlock(lines[index])
      ) {
        index += 1;
      }
    }

    const blockText = lines.slice(start, index).join("\n");
    const idMatch = blockText.match(MARKDOWN_BLOCK_ID_RE);
    entriesFromText(blockText, idMatch?.[1] || null, entries, seen);
  }
}

export function extractNoteLinksFromContent(content: string): NoteLinkEntry[] {
  const entries: NoteLinkEntry[] = [];
  const seen = new Set<string>();
  try {
    const doc = JSON.parse(content);
    if (doc && typeof doc === "object" && Array.isArray(doc.content)) {
      const visit = (nodes: unknown[], parentBlockId: string | null) => {
        for (const candidate of nodes) {
          if (!candidate || typeof candidate !== "object") continue;
          const node = candidate as {
            type?: string;
            text?: unknown;
            attrs?: { blockId?: unknown };
            marks?: Array<{ type?: string; attrs?: { href?: unknown } }>;
            content?: unknown[];
          };
          const ownBlockId = SOURCE_BLOCK_TYPES.has(node.type || "") && typeof node.attrs?.blockId === "string"
            ? node.attrs.blockId
            : parentBlockId;
          if (node.type === "text") {
            const text = String(node.text || "");
            entriesFromText(text, ownBlockId, entries, seen);
            for (const mark of Array.isArray(node.marks) ? node.marks : []) {
              const href = mark?.attrs?.href;
              if (mark?.type === "link" && typeof href === "string" && href.startsWith("note:")) {
                entriesFromText(href, ownBlockId, entries, seen);
              }
            }
          }
          if (Array.isArray(node.content)) visit(node.content, ownBlockId);
        }
      };
      visit(doc.content, null);
      return entries;
    }
  } catch {
    // Markdown / HTML fallback below.
  }

  if (/^\s*(?:<!doctype\s+html|<html\b|<[a-z][^>]*>)/i.test(content)) {
    entriesFromText(content, null, entries, seen);
  } else {
    extractMarkdownLinks(content, entries, seen);
  }
  return entries;
}
