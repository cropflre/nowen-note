import { describe, expect, it } from "vitest";

import { planTiptapBlockPatch } from "@/lib/tiptapBlockPatchPlanner";

function paragraph(blockId: string, text: string, marks?: unknown[]) {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text, ...(marks ? { marks } : {}) }] : [],
  };
}

function heading(blockId: string, text: string, level = 2) {
  return {
    type: "heading",
    attrs: { level, blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function doc(content: unknown[]) {
  return JSON.stringify({ type: "doc", content });
}

describe("Tiptap Block Patch planner", () => {
  it("plans a pure paragraph text update", () => {
    const plan = planTiptapBlockPatch(
      doc([paragraph("blk_alpha00", "Alpha")]),
      doc([paragraph("blk_alpha00", "Alpha updated")]),
    );

    expect(plan).toMatchObject({
      kind: "top-level-structural",
      operations: [{ type: "update", blockId: "blk_alpha00", text: "Alpha updated" }],
    });
  });

  it("plans create, delete and stable left-to-right reordering", () => {
    const plan = planTiptapBlockPatch(
      doc([
        paragraph("blk_alpha00", "Alpha"),
        paragraph("blk_beta000", "Beta"),
        paragraph("blk_old0000", "Old"),
      ]),
      doc([
        paragraph("blk_beta000", "Beta"),
        heading("blk_new0000", "New"),
        paragraph("blk_alpha00", "Alpha"),
      ]),
    );

    expect(plan?.kind).toBe("top-level-structural");
    expect(plan?.operations).toEqual([
      { type: "delete", blockId: "blk_old0000" },
      {
        type: "create",
        clientId: "blk_new0000",
        blockId: "blk_new0000",
        blockType: "heading",
        text: "New",
      },
      {
        type: "move",
        blockId: "blk_beta000",
        targetBlockId: "blk_alpha00",
        position: "before",
      },
      {
        type: "move",
        blockId: "blk_new0000",
        targetBlockId: "blk_alpha00",
        position: "before",
      },
    ]);
  });

  it("uses text-only updates for paragraphs nested inside an unchanged list", () => {
    const list = (text: string) => ({
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { blockId: "blk_item000" },
        content: [paragraph("blk_nested0", text)],
      }],
    });

    const plan = planTiptapBlockPatch(doc([list("Before")]), doc([list("After")]));
    expect(plan).toEqual({
      kind: "text-only",
      operations: [{ type: "update", blockId: "blk_nested0", text: "After" }],
      affectedBlockIds: ["blk_nested0"],
    });
  });

  it("rejects mark changes, non-default created headings and unstable IDs", () => {
    expect(planTiptapBlockPatch(
      doc([paragraph("blk_alpha00", "Alpha")]),
      doc([paragraph("blk_alpha00", "Alpha", [{ type: "bold" }])]),
    )).toBeNull();

    expect(planTiptapBlockPatch(
      doc([paragraph("blk_alpha00", "Alpha")]),
      doc([paragraph("blk_alpha00", "Alpha"), heading("blk_new0000", "H1", 1)]),
    )).toBeNull();

    expect(planTiptapBlockPatch(
      doc([paragraph("blk_alpha00", "Alpha")]),
      doc([{ type: "paragraph", content: [{ type: "text", text: "No ID" }] }]),
    )).toBeNull();
  });
});
