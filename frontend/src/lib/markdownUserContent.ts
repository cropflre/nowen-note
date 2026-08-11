export type InternalMarkdownMarkerKind = "inline" | "line";

export interface InternalMarkdownMarkerRange {
  from: number;
  to: number;
  kind: InternalMarkdownMarkerKind;
  blockId: string;
}

// 系统生成的块 ID 偶尔会在隐藏标记边界被误删尾部字符；仍按内部标记处理，
// 但保留严格的 UUID 结构，避免隐藏用户主动输入的 ^blk_example_text。
const GENERATED_BLOCK_ID = String.raw`blk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8,12}`;
// v1.4.5 及更早版本、部分 Markdown 导入器使用过无下划线的 32 位块 ID。
const LEGACY_COMPACT_BLOCK_ID = String.raw`blk[0-9a-f]{32}`;
const INTERNAL_BLOCK_ID = String.raw`(?:${GENERATED_BLOCK_ID}|${LEGACY_COMPACT_BLOCK_ID})`;
const INLINE_MARKER_RE = new RegExp(String.raw`[ \t]*\^(${INTERNAL_BLOCK_ID})[ \t]*$`, "i");
const LINE_MARKER_RE = new RegExp(String.raw`^[ \t]*\^(${INTERNAL_BLOCK_ID})[ \t]*$`, "i");
const LEGACY_PREFIX_MARKER_RE = new RegExp(String.raw`^[ \t]*\^(${LEGACY_COMPACT_BLOCK_ID})[ \t]+`, "i");
const PASTED_MARKER_RE = new RegExp(
  String.raw`(^|[ \t]+)\^(${INTERNAL_BLOCK_ID})($|[ \t]+)`,
  "ig",
);
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Locate Nowen's reserved Markdown block markers while respecting fenced code blocks.
 * The returned offsets refer to the original internal Markdown string.
 */
export function findInternalMarkdownMarkerRanges(markdown: string): InternalMarkdownMarkerRange[] {
  if (!markdown || !markdown.includes("^blk")) return [];
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
          } else {
            const legacyPrefix = line.match(LEGACY_PREFIX_MARKER_RE);
            if (legacyPrefix) {
              ranges.push({
                from: offset,
                to: offset + legacyPrefix[0].length,
                kind: "inline",
                blockId: legacyPrefix[1],
              });
            }
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

interface MarkdownReplacementAnchor {
  pos: number;
  separateLine: boolean;
}

function findMarkdownReplacementAnchors(markdown: string): MarkdownReplacementAnchor[] {
  const anchors: MarkdownReplacementAnchor[] = [];
  let offset = 0;
  let fenceChar = "";
  let fenceLength = 0;

  while (offset <= markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const lineEnd = newline < 0 ? markdown.length : newline;
    const rawLine = markdown.slice(offset, lineEnd);
    const line = rawLine.replace(/\r$/, "");
    const contentEnd = rawLine.endsWith("\r") ? lineEnd - 1 : lineEnd;

    if (fenceChar) {
      const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLength},}[ \\t]*$`);
      if (closeRe.test(line)) {
        fenceChar = "";
        fenceLength = 0;
        anchors.push({ pos: contentEnd, separateLine: true });
      }
    } else {
      const opener = line.match(FENCE_OPEN_RE);
      if (opener) {
        fenceChar = opener[1][0];
        fenceLength = opener[1].length;
      } else if (line.trim()) {
        anchors.push({ pos: contentEnd, separateLine: false });
      }
    }

    if (newline < 0) break;
    offset = newline + 1;
  }

  if (fenceChar && markdown.length > 0) {
    anchors.push({ pos: markdown.length, separateLine: true });
  }
  return anchors;
}

/**
 * Put the original internal block identity back after AI rewrites user-visible
 * Markdown. Markers never leave the client, but replacing a selection still
 * keeps its existing block references stable.
 */
export function restoreInternalMarkdownMarkers(
  originalMarkdown: string,
  replacementMarkdown: string,
): string {
  const markers = findInternalMarkdownMarkerRanges(originalMarkdown);
  const visibleReplacement = projectMarkdownForUser(replacementMarkdown);
  if (markers.length === 0) return visibleReplacement;

  const anchors = findMarkdownReplacementAnchors(visibleReplacement);
  if (anchors.length === 0) {
    return markers.map((marker) => `^${marker.blockId}`).join("\n");
  }

  const attachedCount = Math.min(markers.length, anchors.length);
  let restored = visibleReplacement;
  for (let index = attachedCount - 1; index >= 0; index -= 1) {
    const marker = markers[index];
    const anchorIndex = attachedCount === 1
      ? anchors.length - 1
      : Math.round(index * (anchors.length - 1) / (attachedCount - 1));
    const anchor = anchors[anchorIndex];
    const insertion = marker.kind === "line" || anchor.separateLine
      ? `\n^${marker.blockId}`
      : ` ^${marker.blockId}`;
    restored = restored.slice(0, anchor.pos) + insertion + restored.slice(anchor.pos);
  }

  if (markers.length > attachedCount) {
    const remaining = markers
      .slice(attachedCount)
      .map((marker) => `^${marker.blockId}`)
      .join("\n\n");
    const separator = restored.endsWith("\n\n") ? "" : restored.endsWith("\n") ? "\n" : "\n\n";
    restored = `${restored}${separator}${remaining}`;
  }

  return restored;
}

/**
 * Remove reserved block identity from pasted text, including markers that were
 * moved into the middle of a line by a previous paste. Fenced code is preserved
 * verbatim so documentation and code samples can still contain marker-like text.
 */
export function sanitizeMarkdownClipboardText(markdown: string): string {
  if (!markdown || !markdown.includes("^blk")) return markdown;
  const lines = markdown.split("\n");
  let fenceChar = "";
  let fenceLength = 0;

  return lines.map((line) => {
    if (fenceChar) {
      const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLength},}[ \\t]*$`);
      if (closeRe.test(line)) {
        fenceChar = "";
        fenceLength = 0;
      }
      return line;
    }

    const opener = line.match(FENCE_OPEN_RE);
    if (opener) {
      fenceChar = opener[1][0];
      fenceLength = opener[1].length;
      return line;
    }

    PASTED_MARKER_RE.lastIndex = 0;
    return line.replace(PASTED_MARKER_RE, (_match, left: string, _blockId: string, right: string) =>
      left && right ? " " : "",
    );
  }).join("\n");
}
