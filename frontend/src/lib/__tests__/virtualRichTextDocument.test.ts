import { describe, expect, it } from "vitest";
import {
  VIRTUAL_RICH_TEXT_MAX_BYTES,
  VIRTUAL_SECTION_MAX_BLOCKS,
  buildPrefixOffsets,
  buildSectionsFromBlocks,
  computeVirtualWindow,
  findMatchingBlockIndices,
  findSectionForBlock,
  parseVirtualRichTextDocument,
  spliceEditedSection,
  splitPlainTextLines,
  toggleTaskItemInBlock,
  type VirtualTiptapNode,
} from "../virtualRichTextDocument";

function makeStressRichTextDoc(paragraphCount: number, headingEvery = 50): string {
  const content: VirtualTiptapNode[] = [];
  for (let i = 0; i < paragraphCount; i++) {
    if (i % headingEvery === 0) {
      content.push({
        type: "heading",
        attrs: { level: 2, blockId: `h-${i}` },
        content: [{ type: "text", text: `第 ${Math.floor(i / headingEvery) + 1} 章 性能压测` }],
      });
    }
    content.push({
      type: "paragraph",
      attrs: { blockId: `p-${i}` },
      content: [
        { type: "text", text: `段落 ${i}：` },
        { type: "text", text: "加粗关键字", marks: [{ type: "bold" }] },
        { type: "text", text: " 与普通正文内容。" },
      ],
    });
  }
  return JSON.stringify({ type: "doc", content });
}

describe("virtualRichTextDocument", () => {
  it("parses a 15,000-paragraph TipTap JSON document into blocks, headings, and bounded sections", () => {
    const raw = makeStressRichTextDoc(15_000, 50);
    const parsed = parseVirtualRichTextDocument(raw, "tiptap-json");

    expect(parsed).not.toBeNull();
    expect(parsed!.blocks.length).toBe(15_300);
    expect(parsed!.headings.length).toBe(300);
    expect(parsed!.headings[0]).toEqual({
      id: "h-0",
      level: 2,
      text: "第 1 章 性能压测",
      pos: 0,
    });
    expect(parsed!.estimatedHeights.length).toBe(parsed!.blocks.length);

    // Every section stays bounded so click-to-edit TipTap stays instant
    expect(parsed!.sections.length).toBeGreaterThan(100);
    for (const section of parsed!.sections) {
      expect(section.endBlock - section.startBlock).toBeLessThanOrEqual(VIRTUAL_SECTION_MAX_BLOCKS);
      expect(section.endBlock).toBeGreaterThan(section.startBlock);
    }

    // Lookup maps any block index back to its enclosing section in O(log S)
    const targetSection = findSectionForBlock(parsed!.sections, 7_520);
    expect(targetSection).not.toBeNull();
    expect(7_520).toBeGreaterThanOrEqual(targetSection!.startBlock);
    expect(7_520).toBeLessThan(targetSection!.endBlock);
  });

  it("caps giant monolithic documents without headings at VIRTUAL_SECTION_MAX_BLOCKS per section", () => {
    const blocks: VirtualTiptapNode[] = Array.from({ length: 300 }, (_, i) => ({
      type: "paragraph",
      content: [{ type: "text", text: `line ${i}` }],
    }));
    const sections = buildSectionsFromBlocks(blocks);
    expect(sections.map((s) => s.endBlock - s.startBlock)).toEqual([120, 120, 60]);
  });

  it("falls back to null (Tier 3 virtual plain-text fuse) for >20MB, HTML, plaintext, or malformed JSON", () => {
    const validDoc = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "ok" }] }],
    });
    expect(parseVirtualRichTextDocument(validDoc, "html")).toBeNull();
    expect(parseVirtualRichTextDocument(validDoc, "plaintext")).toBeNull();
    expect(parseVirtualRichTextDocument("<p>legacy html</p>", "tiptap-json")).toBeNull();
    expect(parseVirtualRichTextDocument("{ broken json", "tiptap-json")).toBeNull();
    expect(parseVirtualRichTextDocument(JSON.stringify({ type: "other" }), "tiptap-json")).toBeNull();

    const oversized = " ".repeat(VIRTUAL_RICH_TEXT_MAX_BYTES + 16);
    expect(parseVirtualRichTextDocument(oversized, "tiptap-json")).toBeNull();
  });

  it("computes O(log N) virtual windows keeping rendered block count bounded across 15,000+ blocks", () => {
    const heights = new Array<number>(15_000).fill(40);
    const offsets = buildPrefixOffsets(heights);

    const topWin = computeVirtualWindow(offsets, heights.length, 0, 720, 600);
    expect(topWin.startIndex).toBe(0);
    expect(topWin.endIndex - topWin.startIndex).toBeLessThan(60);
    expect(topWin.totalHeight).toBe(600_000);

    const midWin = computeVirtualWindow(offsets, heights.length, 300_000, 720, 600);
    expect(midWin.startIndex).toBeGreaterThan(7_400);
    expect(midWin.endIndex).toBeLessThan(7_600);
    expect(midWin.endIndex - midWin.startIndex).toBeLessThan(60);
    expect(midWin.offsetTop).toBe(offsets[midWin.startIndex]);

    const bottomWin = computeVirtualWindow(offsets, heights.length, 599_500, 720, 600);
    expect(bottomWin.endIndex).toBe(15_000);
    expect(bottomWin.endIndex - bottomWin.startIndex).toBeLessThan(60);
  });

  it("splices an edited section back into the master document without mutating any outside blocks", () => {
    const blocks: VirtualTiptapNode[] = [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "第一章" }] },
      { type: "paragraph", content: [{ type: "text", text: "原始第一段" }] },
      { type: "paragraph", content: [{ type: "text", text: "原始第二段" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "第二章" }] },
      { type: "paragraph", content: [{ type: "text", text: "受保护的尾部内容" }] },
    ];
    const section = { id: "section-0", index: 0, startBlock: 0, endBlock: 3, title: "第一章" };
    const editedDoc = JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "第一章（已修订）" }] },
        { type: "paragraph", content: [{ type: "text", text: "修改后的正文" }] },
      ],
    });

    const spliced = spliceEditedSection(blocks, section, editedDoc);
    expect(spliced).not.toBeNull();
    expect(spliced!.nextBlocks).toHaveLength(4);
    expect(spliced!.nextBlocks[2]).toEqual(blocks[3]);
    expect(spliced!.nextBlocks[3]).toEqual(blocks[4]);
    expect(JSON.parse(spliced!.nextContent).content).toHaveLength(4);
    expect(spliced!.nextContentText).toContain("第一章（已修订）");
    expect(spliced!.nextContentText).toContain("受保护的尾部内容");

    // Rejects invalid JSON safely
    expect(spliceEditedSection(blocks, section, "{invalid")).toBeNull();
  });

  it("toggles taskList item checked state immutably and supports search & line splitting", () => {
    const taskBlock: VirtualTiptapNode = {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "待办 A" }] }] },
        { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "待办 B" }] }] },
      ],
    };

    const toggled = toggleTaskItemInBlock(taskBlock, 0);
    expect(toggled.content?.[0].attrs?.checked).toBe(true);
    expect(toggled.content?.[1].attrs?.checked).toBe(true);
    expect(taskBlock.content?.[0].attrs?.checked).toBe(false); // original unchanged

    const matches = findMatchingBlockIndices(
      [
        { type: "paragraph", content: [{ type: "text", text: "Alpha beta" }] },
        { type: "paragraph", content: [{ type: "text", text: "Gamma delta" }] },
        { type: "paragraph", content: [{ type: "text", text: "BETA gamma" }] },
      ],
      "beta",
    );
    expect(matches).toEqual([0, 2]);
    expect(splitPlainTextLines("a\nb\r\nc")).toEqual(["a", "b", "c"]);
  });
});
