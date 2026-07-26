import type Database from "better-sqlite3";

export interface MarkdownNoteForProjection {
  id: string;
  content: string;
  contentFormat: string;
  [key: string]: unknown;
}

const INLINE_MARKER_RE = /[ \t]+\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$/;
const LINE_MARKER_RE = /^[ \t]*\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$/;
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Remove reserved block markers from a user-facing Markdown projection.
 * When knownBlockIds is supplied, only markers owned by the note index are removed.
 */
export function projectMarkdownForUser(
  markdown: string,
  knownBlockIds?: ReadonlySet<string>,
): string {
  if (!markdown || !markdown.includes("^blk_")) return markdown;
  const removals: Array<{ from: number; to: number }> = [];
  let offset = 0;
  let fenceChar = "";
  let fenceLength = 0;

  const owned = (blockId: string) => !knownBlockIds || knownBlockIds.has(blockId);

  while (offset <= markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const lineEnd = newline < 0 ? markdown.length : newline;
    const lineEndWithNewline = newline < 0 ? markdown.length : newline + 1;
    const line = markdown.slice(offset, lineEnd);

    if (fenceChar) {
      const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLength},}[ \\t]*$`);
      if (closeRe.test(line)) {
        fenceChar = "";
        fenceLength = 0;
      }
    } else {
      const opener = line.match(FENCE_OPEN_RE);
      if (opener) {
        fenceChar = opener[1][0];
        fenceLength = opener[1].length;
      } else {
        const standalone = line.match(LINE_MARKER_RE);
        if (standalone && owned(standalone[1])) {
          removals.push({ from: offset, to: lineEndWithNewline });
        } else {
          const inline = line.match(INLINE_MARKER_RE);
          if (inline && inline.index != null && owned(inline[1])) {
            removals.push({ from: offset + inline.index, to: lineEnd });
          }
        }
      }
    }

    if (newline < 0) break;
    offset = lineEndWithNewline;
  }

  let output = markdown;
  for (const removal of removals.sort((a, b) => b.from - a.from)) {
    output = output.slice(0, removal.from) + output.slice(removal.to);
  }
  return output;
}

export function projectMarkdownNoteForUser<T extends MarkdownNoteForProjection>(
  db: Database.Database,
  note: T,
): T {
  if (!note || note.contentFormat !== "markdown" || typeof note.content !== "string") return note;
  try {
    const rows = db.prepare(
      "SELECT blockId FROM note_blocks_index WHERE noteId = ?",
    ).all(note.id) as Array<{ blockId: string }>;
    if (rows.length === 0) return note;
    const known = new Set(rows.map((row) => row.blockId));
    return { ...note, content: projectMarkdownForUser(note.content, known) };
  } catch {
    return note;
  }
}
