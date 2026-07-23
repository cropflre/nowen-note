import { describe, expect, it } from "vitest";

import { planTiptapBlockPatch } from "@/lib/tiptapBlockPatchPlanner";

function paragraph(
  blockId: string,
  text: string,
  marks?: unknown[],
  attrs: Record<string, unknown> = {},
) {
  return {
    type: "paragraph",
    attrs: { blockId, ...attrs },
    content: text ? [{ type: "text", text, ...(marks ? { marks } : {}) }] : [],
  };
}

function heading(
  blockId: string,
  text: string,
  level = 2,
  attrs: Record<string, unknown> = {},
) {
  return {
    type: "heading",
    attrs: { level, blockId, ...attrs },
    content: text ? [{ type: "text", text }] : [],
  };
}

function codeBlock(blockId: string, text: string, language: string | null = null, indent = 0) {
  return {
    type: "codeBlock",
    attrs: { language, indent, blockId },
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

  it("plans inline marks and safe paragraph attributes as one rich node replacement", () => {
    const next = paragraph(
      "blk_rich0000",
      "Rich text",
      [
        { type: "bold" },
        { type: "highlight", attrs: { color: "#fef9c3" } },
        { type: "textStyle", attrs: { color: "#3b82f6", fontSize: "20px" } },
        {
          type: "link",
          attrs: {
            href: "https://example.com/docs",
            target: "_blank",
            rel: "noopener noreferrer",
          },
        },
      ],
      { textAlign: "center", lineHeight: "1.6" },
    );
    const plan = planTiptapBlockPatch(
      doc([paragraph("blk_rich0000", "Rich text")]),
      doc([next]),
    );

    expect(plan).toEqual({
      kind: "node-replace",
      operations: [{ type: "replace", blockId: "blk_rich0000", node: next }],
      affectedBlockIds: ["blk_rich0000"],
    });
  });

  it("plans heading level and code language changes without whole-document save", () => {
    const headingPlan = planTiptapBlockPatch(
      doc([heading("blk_heading0", "Title", 2)]),
      doc([heading("blk_heading0", "Title", 4, { textAlign: "right", lineHeight: "1.8" })]),
    );
    expect(headingPlan).toMatchObject({
      kind: "node-replace",
      operations: [{
        type: "replace",
        blockId: "blk_heading0",
        node: { type: "heading", attrs: { level: 4, blockId: "blk_heading0" } },
      }],
    });

    const codePlan = planTiptapBlockPatch(
      doc([codeBlock("blk_code0000", "const x = 1")]),
      doc([codeBlock("blk_code0000", "const x = 1", "typescript", 2)]),
    );
    expect(codePlan).toMatchObject({
      kind: "node-replace",
      operations: [{
        type: "replace",
        blockId: "blk_code0000",
        node: { type: "codeBlock", attrs: { language: "typescript", indent: 2 } },
      }],
    });
  });

  it("allows a marked nested paragraph but rejects a nested paragraph-to-heading conversion", () => {
    const list = (child: unknown) => ({
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { blockId: "blk_item000" },
        content: [child],
      }],
    });

    const marked = planTiptapBlockPatch(
      doc([list(paragraph("blk_nested0", "Before"))]),
      doc([list(paragraph("blk_nested0", "Before", [{ type: "italic" }]))]),
    );
    expect(marked).toMatchObject({
      kind: "node-replace",
      operations: [{ type: "replace", blockId: "blk_nested0" }],
    });

    expect(planTiptapBlockPatch(
      doc([list(paragraph("blk_nested0", "Before"))]),
      doc([list(heading("blk_nested0", "Before"))]),
    )).toBeNull();
  });

  it("keeps unsafe or structurally ambiguous changes on whole-document save", () => {
    expect(planTiptapBlockPatch(
      doc([paragraph("blk_alpha00", "Alpha")]),
      doc([paragraph("blk_alpha00", "Alpha", [{
        type: "link",
        attrs: { href: "javascript:alert(1)" },
      }])]),
    )).toBeNull();

    expect(planTiptapBlockPatch(
      doc([paragraph("blk_alpha00", "Alpha")]),
      doc([paragraph("blk_alpha00", "Alpha", [{ type: "unknownMark" }])]),
    )).toBeNull();

    expect(planTiptapBlockPatch(
      doc([
        paragraph("blk_alpha00", "Alpha"),
        paragraph("blk_beta000", "Beta"),
      ]),
      doc([
        paragraph("blk_beta000", "Beta", [{ type: "bold" }]),
        paragraph("blk_alpha00", "Alpha"),
      ]),
    )).toBeNull();
  });

  it("keeps delete-all on the whole-document path until empty Block IDs can reconcile", () => {
    expect(planTiptapBlockPatch(
      doc([paragraph("blk_only000", "Only")]),
      doc([]),
    )).toBeNull();
  });

  it("rejects non-default created headings and unstable IDs", () => {
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
