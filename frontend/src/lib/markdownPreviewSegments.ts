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
  const cuts = [0];
  let segmentStart = 0;
  let lineStart = 0;
  let previousBlank = true;
  let fenceMarker: "`" | "~" | null = null;

  for (let index = 0; index <= markdown.length; index += 1) {
    if (index < markdown.length && markdown.charCodeAt(index) !== 10) continue;
    const line = markdown.slice(lineStart, index).replace(/\r$/, "");
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const marker = fence?.[1][0] as "`" | "~" | undefined;
    const atxHeading = /^\s{0,3}#{1,6}\s+/.test(line);
    const length = lineStart - segmentStart;

    if (
      !fenceMarker
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
