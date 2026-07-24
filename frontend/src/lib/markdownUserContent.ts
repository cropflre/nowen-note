export type InternalMarkdownMarkerKind = "inline" | "line";

export interface InternalMarkdownMarkerRange {
  from: number;
  to: number;
  kind: InternalMarkdownMarkerKind;
  blockId: string;
}

const INLINE_MARKER_RE = /[ \t]+\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$/;
const LINE_MARKER_RE = /^[ \t]*\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$/;
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Locate Nowen's reserved Markdown block markers while respecting fenced code blocks.
 * The returned offsets refer to the original internal Markdown string.
 */
export function findInternalMarkdownMarkerRanges(markdown: string): InternalMarkdownMarkerRange[] {
  if (!markdown || !markdown.includes("^blk_")) return [];
  const ranges: InternalMarkdownMarkerRange[] = [];
  let offset = 0;
  let fenceChar = "";
  let fenceLength = 0;

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
        if (standalone) {
          ranges.push({
            from: offset,
            to: lineEndWithNewline,
            kind: "line",
            blockId: standalone[1],
          });
        } else {
          const inline = line.match(INLINE_MARKER_RE);
          if (inline && inline.index != null) {
            ranges.push({
              from: offset + inline.index,
              to: lineEnd,
              kind: "inline",
              blockId: inline[1],
            });
          }
        }
      }
    }

    if (newline < 0) break;
    offset = lineEndWithNewline;
  }

  return ranges;
}

/** Project internal Markdown into user-visible Markdown without changing persisted block identity. */
export function projectMarkdownForUser(markdown: string): string {
  const ranges = findInternalMarkdownMarkerRanges(markdown);
  if (ranges.length === 0) return markdown;
  let output = markdown;
  for (const range of [...ranges].sort((a, b) => b.from - a.from)) {
    output = output.slice(0, range.from) + output.slice(range.to);
  }
  return output;
}
