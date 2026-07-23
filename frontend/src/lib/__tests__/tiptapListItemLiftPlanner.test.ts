import { describe, expect, it } from "vitest";

import { planTiptapBlockPatch } from "@/lib/tiptapBlockPatchPlannerRuntime";

function paragraph(blockId: string, text: string) {
  return {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null },
    content: text ? [{ type: "text", text }] : [],
  };
}

function item(blockId: string, paragraphId: string, text: string, nested?: unknown) {
  return {
    type: "listItem",
    attrs: { blockId },
    content: [paragraph(paragraphId, text), ...(nested ? [nested] : [])],
  };
}

function doc(content: unknown[]) {
  return JSON.stringify({ type: "doc", content });
}

describe("Tiptap top-level list lift planner", () => {
  it("lifts a leaf item after its root list while preserving the paragraph ID", () => {
    const remaining = item("blk_item_a0", "blk_para_a0", "A");
    const lifted = item("blk_item_b0", "blk_para_b0", "B");
    const base = doc([{ type: "bulletList", content: [remaining, lifted] }]);
    const next = doc([
      { type: "bulletList", content: [remaining] },
      paragraph("blk_para_b0", "B"),
    ]);

    expect(planTiptapBlockPatch(base, next)).toEqual({
      kind: "list-lift",
      operations: [{
        type: "lift",
        scope: "listItem",
        blockId: "blk_item_b0",
        position: "after",
      }],
      affectedBlockIds: ["blk_item_b0"],
    });
  });

  it("rejects lifting an item that owns a nested subtree", () => {
    const nested = item("blk_item_b0", "blk_para_b0", "B", {
      type: "bulletList",
      content: [item("blk_item_c0", "blk_para_c0", "C")],
    });
    const base = doc([{ type: "bulletList", content: [nested] }]);
    const next = doc([paragraph("blk_para_b0", "B")]);
    expect(planTiptapBlockPatch(base, next)).toBeNull();
  });
});
