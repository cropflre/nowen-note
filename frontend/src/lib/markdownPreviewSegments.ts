export const MARKDOWN_SEGMENTED_PREVIEW_THRESHOLD = 120_000;
export const MARKDOWN_PREVIEW_SEGMENT_TARGET = 50_000;
export const MARKDOWN_PREVIEW_SEGMENT_MAX = 75_000;

export interface MarkdownPreviewSegment {
  id: string;
  start: number;
  end: number;
  markdown: string;
  taskOffset: number;
}

function countTasks(markdown: string): number {
  return (markdown.match(/^\s*[-+*]\s+\[[ xX]\]\s+/gm) || []).length;
}

/** Split only at top-level block boundaries, never inside fenced code. */
export function splitMarkdownPreview(markdown: string): MarkdownPreviewSegment[] {
  if (!markdown) return [];
  // 引用定义可被前文任意段落使用；ReactMarkdown 分段渲染时无法跨根节点解析引用。
  // 这类文档宁可保持单段，也不能为了窗口化改变链接语义。
  if (/^ {0,3}\[[^\]]+\]:\s*\S+/m.test(markdown)) {
    return [{ id: "md-segment-0", start: 0, end: markdown.length, markdown, taskOffset: 0 }];
  }
  const cuts = [0];
  let segmentStart = 0;
  let lineStart = 0;
  let previousBlank = true;
  let fenceMarker: "`" | "~" | null = null;
  let mathBlock = false;
  let htmlBlockTag: string | null = null;
  let htmlComment = false;

  for (let index = 0; index <= markdown.length; index += 1) {
    if (index < markdown.length && markdown.charCodeAt(index) !== 10) continue;
    const line = markdown.slice(lineStart, index).replace(/\r$/, "");
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const marker = fence?.[1][0] as "`" | "~" | undefined;
    const atxHeading = /^\s{0,3}#{1,6}\s+/.test(line);
    const length = lineStart - segmentStart;
    const trimmed = line.trim();
    const startsContainer = /^\s{0,3}(?:>|[-+*]\s+|\d+[.)]\s+)/.test(line);
    const startsIndentedCode = /^(?:\t| {4})/.test(line);
    const startsDefinition = /^ {0,3}\[[^\]]+\]:/.test(line);
    const safeTopLevelStart = !startsContainer && !startsIndentedCode && !startsDefinition;

    if (
      !fenceMarker
      && !mathBlock
      && !htmlBlockTag
      && !htmlComment
      && safeTopLevelStart
      && lineStart > segmentStart
      && ((atxHeading && previousBlank && length >= MARKDOWN_PREVIEW_SEGMENT_TARGET)
        || (previousBlank && length >= MARKDOWN_PREVIEW_SEGMENT_MAX))
    ) {
      cuts.push(lineStart);
      segmentStart = lineStart;
    }

    if (marker) {
      if (!fenceMarker) fenceMarker = marker;
      else if (fenceMarker === marker) fenceMarker = null;
    }
    if (!fenceMarker && trimmed === "$$") mathBlock = !mathBlock;
    if (!fenceMarker && !mathBlock) {
      if (!htmlComment && line.includes("<!--") && !line.includes("-->")) htmlComment = true;
      else if (htmlComment && line.includes("-->")) htmlComment = false;
      if (!htmlBlockTag) {
        const open = /^ {0,3}<(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul|pre|script|style)(?:\s|>|\/)/i.exec(line);
        if (open && !new RegExp(`</${open[1]}\\s*>`, "i").test(line)) htmlBlockTag = open[1].toLowerCase();
      } else if (new RegExp(`</${htmlBlockTag}\\s*>`, "i").test(line)) {
        htmlBlockTag = null;
      }
    }
    previousBlank = line.trim().length === 0;
    lineStart = index + 1;
  }
  cuts.push(markdown.length);

  let taskOffset = 0;
  return cuts.slice(0, -1).map((start, index) => {
    const end = cuts[index + 1];
    const source = markdown.slice(start, end);
    const segment = { id: `md-segment-${start}`, start, end, markdown: source, taskOffset };
    taskOffset += countTasks(source);
    return segment;
  });
}
