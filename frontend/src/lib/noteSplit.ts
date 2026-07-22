export type NoteSplitHeadingLevel = 1 | 2;

export interface MarkdownSplitPreviewSection {
  index: number;
  title: string;
  content: string;
  sourceStart: number;
  sourceEnd: number;
  sourceCharacters: number;
}

export interface MarkdownSplitPreview {
  headingLevel: NoteSplitHeadingLevel;
  preamble: string;
  sections: MarkdownSplitPreviewSection[];
  sourceCharacters: number;
}

interface Boundary {
  title: string;
  headingStart: number;
  bodyStart: number;
}

function cleanTitle(raw: string, index: number): string {
  const title = raw
    .replace(/\s+\^blk_[A-Za-z0-9_-]{6,}\s*$/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (title || `第 ${index + 1} 节`).slice(0, 200);
}

function closesFence(line: string, marker: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed[0] !== marker[0]) return false;
  let length = 0;
  while (trimmed[length] === marker[0]) length += 1;
  return length >= marker.length && trimmed.slice(length).trim() === "";
}

export function buildMarkdownSplitPreview(
  markdown: string,
  headingLevel: NoteSplitHeadingLevel,
): MarkdownSplitPreview {
  const boundaries: Boundary[] = [];
  let lineStart = 0;
  let fenceMarker: string | null = null;

  for (let index = 0; index <= markdown.length; index += 1) {
    if (index < markdown.length && markdown.charCodeAt(index) !== 10) continue;
    const line = markdown.slice(lineStart, index).replace(/\r$/, "");
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMarker) {
      if (closesFence(line, fenceMarker)) fenceMarker = null;
    } else if (fence) {
      fenceMarker = fence[1];
    } else {
      const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (heading && heading[1].length === headingLevel) {
        boundaries.push({
          title: cleanTitle(heading[2], boundaries.length),
          headingStart: lineStart,
          bodyStart: index < markdown.length ? index + 1 : index,
        });
      }
    }
    lineStart = index + 1;
  }

  return {
    headingLevel,
    preamble: boundaries.length ? markdown.slice(0, boundaries[0].headingStart).trimEnd() : markdown,
    sourceCharacters: markdown.length,
    sections: boundaries.map((boundary, index) => {
      const sourceEnd = boundaries[index + 1]?.headingStart ?? markdown.length;
      return {
        index,
        title: boundary.title,
        content: markdown.slice(boundary.bodyStart, sourceEnd).replace(/^\s*\n/, "").trimEnd(),
        sourceStart: boundary.headingStart,
        sourceEnd,
        sourceCharacters: sourceEnd - boundary.headingStart,
      };
    }),
  };
}

/**
 * Scan only until two usable headings are found. This is used by the runtime shell to decide
 * whether the split action should be shown without building a complete preview on every save.
 */
export function findPreferredMarkdownSplitLevel(markdown: string): NoteSplitHeadingLevel | null {
  const counts: Record<NoteSplitHeadingLevel, number> = { 1: 0, 2: 0 };
  let lineStart = 0;
  let fenceMarker: string | null = null;

  for (let index = 0; index <= markdown.length; index += 1) {
    if (index < markdown.length && markdown.charCodeAt(index) !== 10) continue;
    const line = markdown.slice(lineStart, index).replace(/\r$/, "");
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMarker) {
      if (closesFence(line, fenceMarker)) fenceMarker = null;
    } else if (fence) {
      fenceMarker = fence[1];
    } else {
      const heading = /^\s{0,3}(#{1,2})\s+\S/.exec(line);
      if (heading) {
        const level = heading[1].length as NoteSplitHeadingLevel;
        counts[level] += 1;
        if (counts[1] >= 2) return 1;
        if (counts[2] >= 2) return 2;
      }
    }
    lineStart = index + 1;
  }
  return counts[1] >= 2 ? 1 : counts[2] >= 2 ? 2 : null;
}
