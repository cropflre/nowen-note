import { describe, expect, it } from "vitest";

import {
  buildTiptapSplitPreview,
  findPreferredTiptapSplitLevel,
} from "@/lib/tiptapNoteSplit";

function paragraph(blockId: string, text: string) {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: [{ type: "text", text }],
  };
}

function heading(level: 1 | 2, blockId: string, text: string) {
  return {
    type: "heading",
    attrs: { level, blockId },
    content: [{ type: "text", text }],
  };
}

describe("Tiptap note split preview", () => {
  it("uses only root headings and keeps nested headings in the parent section", () => {
    const serialized = JSON.stringify({
      type: "doc",
      content: [
        paragraph("blk_preface", "Preface"),
        heading(1, "blk_alpha_h", "Alpha"),
        paragraph("blk_alpha_p", "Alpha body"),
        {
          type: "blockquote",
          content: [heading(1, "blk_nested_h", "Nested")],
        },
        heading(1, "blk_beta_h", "Beta"),
        paragraph("blk_beta_p", "Beta body"),
      ],
    });
    expect(findPreferredTiptapSplitLevel(serialized)).toBe(1);
    const preview = buildTiptapSplitPreview(serialized, 1);
    expect(preview.sections.map((section) => section.title)).toEqual(["Alpha", "Beta"]);
    const firstBody = JSON.parse(preview.sections[0].content);
    expect(firstBody.content.some((node: any) => node.type === "blockquote")).toBe(true);
  });

  it("prefers H2 when there are not enough root H1 headings", () => {
    const serialized = JSON.stringify({
      type: "doc",
      content: [
        heading(1, "blk_book_h", "Book"),
        heading(2, "blk_a_h", "A"),
        paragraph("blk_a_p", "A body"),
        heading(2, "blk_b_h", "B"),
        paragraph("blk_b_p", "B body"),
      ],
    });
    expect(findPreferredTiptapSplitLevel(serialized)).toBe(2);
    expect(buildTiptapSplitPreview(serialized, 2).sections).toHaveLength(2);
  });

  it("returns an empty preview for invalid historical JSON", () => {
    expect(findPreferredTiptapSplitLevel("{broken")).toBeNull();
    expect(buildTiptapSplitPreview("{broken", 1).sections).toEqual([]);
  });
});
