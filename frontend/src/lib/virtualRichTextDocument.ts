import type { NoteEditorHeading } from "@/components/editors/types";

export interface VirtualTiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface VirtualTiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  marks?: VirtualTiptapMark[];
  content?: VirtualTiptapNode[];
}

export interface VirtualRichTextSection {
  id: string;
  index: number;
  startBlock: number;
  endBlock: number; // exclusive
  title: string;
}

export interface ParsedVirtualRichTextDocument {
  blocks: VirtualTiptapNode[];
  headings: NoteEditorHeading[];
  sections: VirtualRichTextSection[];
  estimatedHeights: number[];
  totalChars: number;
}

export interface VirtualWindowRange {
  startIndex: number;
  endIndex: number; // exclusive
  totalHeight: number;
  offsetTop: number;
}

/**
 * Hard ceiling for parsing JSON into the virtualized rich-text engine.
 * Above 20 MB we keep the true virtualized plain-text fuse active so the browser never OOMs.
 */
export const VIRTUAL_RICH_TEXT_MAX_BYTES = 20 * 1024 * 1024;
export const VIRTUAL_SECTION_MAX_BLOCKS = 120;

export function extractNodePlainText(node: VirtualTiptapNode | null | undefined): string {
  if (!node) return "";
  const parts: string[] = [];
  const walk = (current: VirtualTiptapNode) => {
    if (typeof current.text === "string") {
      parts.push(current.text);
    } else if (current.type === "hardBreak") {
      parts.push("\n");
    }
    if (Array.isArray(current.content)) {
      for (const child of current.content) walk(child);
    }
    if (
      current.type === "paragraph"
      || current.type === "heading"
      || current.type === "listItem"
      || current.type === "taskItem"
      || current.type === "blockquote"
      || current.type === "codeBlock"
      || current.type === "tableRow"
    ) {
      parts.push("\n");
    } else if (current.type === "tableCell" || current.type === "tableHeader") {
      parts.push("\t");
    }
  };
  walk(node);
  return parts.join("").replace(/\t\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function serializeBlocksToPlainText(blocks: VirtualTiptapNode[]): string {
  const chunks: string[] = [];
  for (const block of blocks) {
    const text = extractNodePlainText(block);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n");
}

export function estimateBlockHeight(block: VirtualTiptapNode): number {
  switch (block.type) {
    case "heading": {
      const level = Number(block.attrs?.level ?? 2);
      if (level <= 1) return 56;
      if (level === 2) return 48;
      return 40;
    }
    case "horizontalRule":
      return 28;
    case "image":
    case "resizableImage":
    case "video":
      return 260;
    case "codeBlock": {
      const text = extractNodePlainText(block);
      const lineCount = Math.max(1, text.split("\n").length);
      return Math.min(900, 48 + lineCount * 20);
    }
    case "table": {
      const rowCount = Array.isArray(block.content) ? block.content.length : 2;
      return Math.min(1200, 24 + rowCount * 38);
    }
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const itemCount = Array.isArray(block.content) ? block.content.length : 1;
      return Math.min(2400, 16 + itemCount * 30);
    }
    case "blockquote": {
      const len = extractNodePlainText(block).length;
      const lines = Math.max(1, Math.ceil(len / 44));
      return Math.min(600, 26 + lines * 26);
    }
    case "paragraph":
    default: {
      const len = extractNodePlainText(block).length;
      if (len === 0) return 26;
      const lines = Math.max(1, Math.ceil(len / 48));
      return Math.min(640, 14 + lines * 26);
    }
  }
}

export function buildSectionsFromBlocks(
  blocks: VirtualTiptapNode[],
  maxBlocksPerSection = VIRTUAL_SECTION_MAX_BLOCKS,
): VirtualRichTextSection[] {
  if (blocks.length === 0) {
    return [{ id: "section-0", index: 0, startBlock: 0, endBlock: 0, title: "" }];
  }

  const sections: VirtualRichTextSection[] = [];
  let start = 0;
  let currentTitle = "";

  const pushSection = (from: number, to: number, title: string) => {
    const index = sections.length;
    sections.push({
      id: `section-${index}`,
      index,
      startBlock: from,
      endBlock: to,
      title: title || `第 ${index + 1} 节`,
    });
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const isHeading = block.type === "heading";
    const blockCount = i - start;

    if (i > start && ((isHeading && blockCount >= 8) || blockCount >= maxBlocksPerSection)) {
      pushSection(start, i, currentTitle);
      start = i;
      currentTitle = isHeading ? extractNodePlainText(block).slice(0, 60) : "";
    } else if (i === start && isHeading) {
      currentTitle = extractNodePlainText(block).slice(0, 60);
    }
  }

  if (start < blocks.length) {
    pushSection(start, blocks.length, currentTitle);
  }
  return sections;
}

export function parseVirtualRichTextDocument(
  rawContent: string | null | undefined,
  originalFormat?: string | null,
): ParsedVirtualRichTextDocument | null {
  if (!rawContent || typeof rawContent !== "string") return null;
  const format = (originalFormat || "tiptap-json").trim().toLowerCase();
  if (format === "html" || format === "htm" || format === "plaintext") return null;
  if (rawContent.length > VIRTUAL_RICH_TEXT_MAX_BYTES) return null;

  const trimmed = rawContent.trimStart();
  if (!trimmed.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(rawContent) as VirtualTiptapNode;
    if (!parsed || parsed.type !== "doc" || !Array.isArray(parsed.content)) {
      return null;
    }

    const blocks = parsed.content;
    const headings: NoteEditorHeading[] = [];
    const estimatedHeights = new Array<number>(blocks.length);
    let totalChars = 0;

    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      const text = extractNodePlainText(block);
      totalChars += text.length;
      estimatedHeights[index] = estimateBlockHeight(block);

      if (block.type === "heading") {
        const level = Math.min(6, Math.max(1, Number(block.attrs?.level ?? 2)));
        const headingText = text.trim();
        if (headingText) {
          headings.push({
            id: typeof block.attrs?.blockId === "string"
              ? block.attrs.blockId
              : `virtual-heading-${index}`,
            level,
            text: headingText,
            pos: index,
          });
        }
      }
    }

    const sections = buildSectionsFromBlocks(blocks);
    return {
      blocks,
      headings,
      sections,
      estimatedHeights,
      totalChars,
    };
  } catch {
    return null;
  }
}

export function findSectionForBlock(
  sections: VirtualRichTextSection[],
  blockIndex: number,
): VirtualRichTextSection | null {
  let lo = 0;
  let hi = sections.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const section = sections[mid];
    if (blockIndex < section.startBlock) hi = mid - 1;
    else if (blockIndex >= section.endBlock) lo = mid + 1;
    else return section;
  }
  return sections[0] ?? null;
}

export function spliceEditedSection(
  blocks: VirtualTiptapNode[],
  section: VirtualRichTextSection,
  editedSectionDocJson: string,
): {
  nextBlocks: VirtualTiptapNode[];
  nextContent: string;
  nextContentText: string;
} | null {
  try {
    const parsed = JSON.parse(editedSectionDocJson) as VirtualTiptapNode;
    if (!parsed || parsed.type !== "doc" || !Array.isArray(parsed.content)) {
      return null;
    }
    const nextBlocks = [
      ...blocks.slice(0, section.startBlock),
      ...parsed.content,
      ...blocks.slice(section.endBlock),
    ];
    return {
      nextBlocks,
      nextContent: JSON.stringify({ type: "doc", content: nextBlocks }),
      nextContentText: serializeBlocksToPlainText(nextBlocks),
    };
  } catch {
    return null;
  }
}

export function toggleTaskItemInBlock(
  block: VirtualTiptapNode,
  itemIndex: number,
): VirtualTiptapNode {
  if (block.type !== "taskList" || !Array.isArray(block.content)) return block;
  return {
    ...block,
    content: block.content.map((item, idx) => {
      if (idx !== itemIndex || item.type !== "taskItem") return item;
      const checked = Boolean(item.attrs?.checked);
      return {
        ...item,
        attrs: {
          ...(item.attrs || {}),
          checked: !checked,
        },
      };
    }),
  };
}

export function findMatchingBlockIndices(
  blocks: VirtualTiptapNode[],
  query: string,
  maxMatches = 2000,
): number[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const text = extractNodePlainText(blocks[i]).toLocaleLowerCase();
    if (text.includes(needle)) {
      matches.push(i);
      if (matches.length >= maxMatches) break;
    }
  }
  return matches;
}

export function buildPrefixOffsets(heights: number[]): Float64Array {
  const offsets = new Float64Array(heights.length + 1);
  let sum = 0;
  for (let i = 0; i < heights.length; i++) {
    offsets[i] = sum;
    sum += heights[i];
  }
  offsets[heights.length] = sum;
  return offsets;
}

export function computeVirtualWindow(
  offsets: Float64Array,
  count: number,
  scrollTop: number,
  viewportHeight: number,
  overscanPx = 900,
): VirtualWindowRange {
  if (count <= 0) {
    return { startIndex: 0, endIndex: 0, totalHeight: 0, offsetTop: 0 };
  }
  const totalHeight = offsets[count];
  const minOffset = Math.max(0, scrollTop - overscanPx);
  const maxOffset = Math.min(totalHeight, scrollTop + Math.max(400, viewportHeight) + overscanPx);

  // Binary search first index whose bottom > minOffset
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid + 1] <= minOffset) lo = mid + 1;
    else hi = mid;
  }
  const startIndex = lo;

  // Binary search first index whose top >= maxOffset
  lo = startIndex;
  hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid] < maxOffset) lo = mid + 1;
    else hi = mid;
  }
  const endIndex = Math.max(startIndex + 1, Math.min(count, lo));

  return {
    startIndex,
    endIndex,
    totalHeight,
    offsetTop: offsets[startIndex],
  };
}

export function splitPlainTextLines(text: string): string[] {
  if (!text) return [];
  return text.split(/\r?\n/);
}
