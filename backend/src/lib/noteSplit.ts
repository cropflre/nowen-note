export type NoteSplitHeadingLevel = 1 | 2;

export interface MarkdownSplitSection {
  index: number;
  title: string;
  headingLevel: NoteSplitHeadingLevel;
  content: string;
  sourceStart: number;
  sourceEnd: number;
  sourceCharacters: number;
}

export interface MarkdownSplitPlan {
  headingLevel: NoteSplitHeadingLevel;
  preamble: string;
  sections: MarkdownSplitSection[];
  sourceCharacters: number;
}

interface HeadingBoundary {
  title: string;
  headingStart: number;
  bodyStart: number;
}

function cleanHeadingTitle(raw: string, fallbackIndex: number): string {
  const cleaned = raw
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || `第 ${fallbackIndex + 1} 节`).slice(0, 200);
}

function isFenceClosing(line: string, marker: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith(marker[0])) return false;
  let length = 0;
  while (trimmed[length] === marker[0]) length += 1;
  return length >= marker.length && trimmed.slice(length).trim() === "";
}

/**
 * Build a deterministic Markdown split plan without invoking a full Markdown parser.
 *
 * Only ATX headings outside fenced code blocks are considered. The requested heading level is
 * exact: splitting by H2 keeps H1 headings inside the preamble/section body instead of silently
 * changing document hierarchy.
 */
export function planMarkdownNoteSplit(
  markdown: string,
  headingLevel: NoteSplitHeadingLevel,
): MarkdownSplitPlan {
  const boundaries: HeadingBoundary[] = [];
  let lineStart = 0;
  let fenceMarker: string | null = null;

  for (let index = 0; index <= markdown.length; index += 1) {
    if (index < markdown.length && markdown.charCodeAt(index) !== 10) continue;

    const rawLineWithCr = markdown.slice(lineStart, index);
    const rawLine = rawLineWithCr.replace(/\r$/, "");
    const fenceOpen = /^\s{0,3}(`{3,}|~{3,})/.exec(rawLine);

    if (fenceMarker) {
      if (isFenceClosing(rawLine, fenceMarker)) fenceMarker = null;
    } else if (fenceOpen) {
      fenceMarker = fenceOpen[1];
    } else {
      const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(rawLine);
      if (heading && heading[1].length === headingLevel) {
        boundaries.push({
          title: cleanHeadingTitle(heading[2], boundaries.length),
          headingStart: lineStart,
          bodyStart: index < markdown.length ? index + 1 : index,
        });
      }
    }

    lineStart = index + 1;
  }

  const sections = boundaries.map((boundary, index) => {
    const sourceEnd = boundaries[index + 1]?.headingStart ?? markdown.length;
    const content = markdown.slice(boundary.bodyStart, sourceEnd).replace(/^\s*\n/, "").trimEnd();
    return {
      index,
      title: boundary.title,
      headingLevel,
      content,
      sourceStart: boundary.headingStart,
      sourceEnd,
      sourceCharacters: sourceEnd - boundary.headingStart,
    } satisfies MarkdownSplitSection;
  });

  return {
    headingLevel,
    preamble: boundaries.length > 0 ? markdown.slice(0, boundaries[0].headingStart).trimEnd() : markdown,
    sections,
    sourceCharacters: markdown.length,
  };
}

function escapeWikiAlias(value: string): string {
  return value.replace(/\|/g, "｜").replace(/\]/g, "］").trim();
}

export function buildMarkdownSplitDirectory(options: {
  sourceTitle: string;
  operationId: string;
  headingLevel: NoteSplitHeadingLevel;
  preamble: string;
  preservePreamble: boolean;
  sections: Array<{ id: string; title: string }>;
}): string {
  const chunks: string[] = [];
  if (options.preservePreamble && options.preamble.trim()) chunks.push(options.preamble.trim());
  chunks.push(`<!-- nowen-note-split:${options.operationId} -->`);
  chunks.push(
    `> 已按 H${options.headingLevel} 拆分为 ${options.sections.length} 篇章节笔记。原始正文已保存在版本历史中，可在本次拆分未被继续编辑前撤销。`,
  );
  chunks.push("## 目录");
  chunks.push(
    options.sections
      .map((section, index) => `${index + 1}. [[${section.id}|${escapeWikiAlias(section.title)}]]`)
      .join("\n"),
  );
  return `${chunks.filter(Boolean).join("\n\n").trim()}\n`;
}

export function validateMarkdownSplitPlan(plan: MarkdownSplitPlan): string | null {
  if (plan.sections.length < 2) return "至少需要两个同级标题才能拆分";
  if (plan.sections.length > 200) return "单次最多拆分 200 个章节";
  if (plan.sections.some((section) => !section.title.trim())) return "章节标题不能为空";
  return null;
}
