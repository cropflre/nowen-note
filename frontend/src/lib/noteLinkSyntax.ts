export type NoteTitleMode = "auto" | "alias";

export interface ParsedNoteLinkQuery {
  searchText: string;
  alias: string;
}

export interface ParsedInternalNoteHref {
  noteId: string;
  blockId: string | null;
}

const INTERNAL_HREF_RE = /^note:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:#blk:([A-Za-z0-9_-]+))?$/i;
const WIKI_LINK_RE = /(!?)\[\[(note:[0-9a-f-]{36}(?:#blk:[A-Za-z0-9_-]+)?)(?:\|((?:\\\]|[^\]])*))?\]\]/gi;

export function parseNoteLinkQuery(query: string): ParsedNoteLinkQuery {
  const pipe = query.indexOf("|");
  if (pipe < 0) return { searchText: query.trim(), alias: "" };
  return {
    searchText: query.slice(0, pipe).trim(),
    alias: query.slice(pipe + 1).trim(),
  };
}

export function parseInternalNoteHref(href: string): ParsedInternalNoteHref | null {
  const match = href.match(INTERNAL_HREF_RE);
  return match ? { noteId: match[1].toLowerCase(), blockId: match[2] || null } : null;
}

export function buildInternalNoteHref(noteId: string, blockId?: string | null): string {
  return blockId ? `note:${noteId}#blk:${blockId}` : `note:${noteId}`;
}

export function buildWikiNoteLink(
  noteId: string,
  blockId?: string | null,
  alias?: string | null,
): string {
  const href = buildInternalNoteHref(noteId, blockId);
  const escapedAlias = String(alias || "").replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
  return escapedAlias ? `[[${href}|${escapedAlias}]]` : `[[${href}]]`;
}

export function titleModeFromAlias(alias?: string | null): NoteTitleMode {
  return alias && alias.trim() ? "alias" : "auto";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Convert internal wiki links to sanitized HTML placeholders for preview/Tiptap parsing. */
export function preprocessInternalNoteLinks(markdown: string): string {
  const fenced: string[] = [];
  let source = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (match) => {
    const index = fenced.push(match) - 1;
    return `\u0000NOWEN_NOTE_CODE_${index}\u0000`;
  });
  source = source.replace(WIKI_LINK_RE, (_match, embedPrefix, href, rawAlias) => {
    const alias = String(rawAlias || "").replace(/\\\]/g, "]");
    if (embedPrefix) {
      return `<div data-nowen-block-embed="${escapeHtml(href)}"></div>`;
    }
    const mode = titleModeFromAlias(alias);
    const label = alias || "关联笔记";
    return `<a href="${escapeHtml(href)}" data-nowen-title-mode="${mode}" rel="noopener noreferrer nofollow nowen-title-${mode}">${escapeHtml(label)}</a>`;
  });
  return source.replace(/\u0000NOWEN_NOTE_CODE_(\d+)\u0000/g, (_match, index) => fenced[Number(index)] || "");
}

export function detectActiveWikiNoteQuery(
  lineTextBeforeCursor: string,
  absoluteCursor: number,
  lineStart: number,
): { query: string; from: number; to: number } | null {
  const trigger = lineTextBeforeCursor.lastIndexOf("[[");
  if (trigger < 0) return null;
  const tail = lineTextBeforeCursor.slice(trigger + 2);
  if (tail.includes("]]")) return null;
  return {
    query: tail,
    from: lineStart + trigger,
    to: absoluteCursor,
  };
}
