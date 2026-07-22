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

interface SplitDirectorySection {
  id: string;
  title: string;
}

interface SelectedSplitDirectorySection extends SplitDirectorySection {
  index: number;
}

function cleanHeadingTitle(raw: string, fallbackIndex: number): string {
  const cleaned = raw
    .replace(/\s+\^blk_[A-Za-z0-9_-]{6,}\s*$/, "")
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

function buildDirectoryList(sections: SplitDirectorySection[]): string {
  return sections
    .map((section, index) => `${index + 1}. [[note:${section.id}|${escapeWikiAlias(section.title)}]]`)
    .join("\n");
}

function directoryHeading(headingLevel: NoteSplitHeadingLevel): string {
  // Keep the generated directory below the split level. Otherwise H2 splitting would create a
  // synthetic peer H2 named “目录”, and the next preview could treat it as user content.
  return `${"#".repeat(Math.min(6, headingLevel + 1))} 目录`;
}

export function buildMarkdownSplitDirectory(options: {
  sourceTitle: string;
  operationId: string;
  headingLevel: NoteSplitHeadingLevel;
  preamble: string;
  preservePreamble: boolean;
  sections: SplitDirectorySection[];
}): string {
  const chunks: string[] = [];
  if (options.preservePreamble && options.preamble.trim()) chunks.push(options.preamble.trim());
  chunks.push(`<!-- nowen-note-split:${options.operationId} -->`);
  chunks.push(
    `> 已按 H${options.headingLevel} 拆分为 ${options.sections.length} 篇章节笔记。原始正文已保存在版本历史中，可在本次拆分未被继续编辑前撤销。`,
  );
  chunks.push(directoryHeading(options.headingLevel));
  chunks.push(buildDirectoryList(options.sections));
  return `${chunks.filter(Boolean).join("\n\n").trim()}\n`;
}

/**
 * Build the source note after only a subset of peer headings is extracted.
 *
 * Selected sections are replaced with wiki links. Unselected sections are copied from their exact
 * source ranges, including their original heading lines, whitespace and nested content. This keeps
 * partial splitting deterministic and prevents the server from reconstructing or reformatting the
 * remaining document from a lossy preview payload.
 */
export function buildMarkdownPartialSplitSource(options: {
  sourceMarkdown: string;
  sourceTitle: string;
  operationId: string;
  plan: MarkdownSplitPlan;
  preservePreamble: boolean;
  sections: SelectedSplitDirectorySection[];
}): string {
  const selectedIndexes = new Set(options.sections.map((section) => section.index));
  const retainedSections = options.plan.sections.filter((section) => !selectedIndexes.has(section.index));
  if (retainedSections.length === 0) {
    return buildMarkdownSplitDirectory({
      sourceTitle: options.sourceTitle,
      operationId: options.operationId,
      headingLevel: options.plan.headingLevel,
      preamble: options.plan.preamble,
      preservePreamble: options.preservePreamble,
      sections: options.sections,
    });
  }

  const chunks: string[] = [];
  if (options.preservePreamble && options.plan.preamble.trim()) chunks.push(options.plan.preamble.trim());
  chunks.push(`<!-- nowen-note-split:${options.operationId} -->`);
  chunks.push(
    `> 已将 ${options.sections.length}/${options.plan.sections.length} 个 H${options.plan.headingLevel} 章节拆分为独立笔记；未选择的 ${retainedSections.length} 个章节继续保留在当前笔记中。原始正文已保存在版本历史中。`,
  );
  chunks.push(directoryHeading(options.plan.headingLevel));
  chunks.push(buildDirectoryList(options.sections));
  chunks.push(
    `> 以下 ${retainedSections.length} 个章节未拆分，仍可在当前笔记中继续编辑。`,
  );
  chunks.push(
    retainedSections
      .map((section) => options.sourceMarkdown.slice(section.sourceStart, section.sourceEnd).trimEnd())
      .filter(Boolean)
      .join("\n\n"),
  );
  return `${chunks.filter(Boolean).join("\n\n").trim()}\n`;
}

export function validateMarkdownSplitPlan(plan: MarkdownSplitPlan): string | null {
  if (plan.sections.length < 2) return "至少需要两个同级标题才能拆分";
  if (plan.sections.length > 200) return "单次最多拆分 200 个章节";
  if (plan.sections.some((section) => !section.title.trim())) return "章节标题不能为空";
  return null;
}
