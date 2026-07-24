import { describe, expect, it } from "vitest";

import { planTiptapBlockPatch } from "@/lib/tiptapBlockPatchPlannerRuntime";

function paragraph(blockId: string, text: string) {
  return {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null },
    content: text ? [{ type: "text", text }] : [],
  };
}

function item(blockId: string, paragraphId: string, text: string) {
  return {
    type: "listItem",
    attrs: { blockId },
    content: [paragraph(paragraphId, text)],
  };
}

function doc(items: unknown[]) {
  return JSON.stringify({ type: "doc", content: [{ type: "bulletList", content: items }] });
}

describe("Tiptap list item batch planner", () => {
  it("plans Enter splitting as one paragraph replacement and one item creation", () => {
    const base = doc([item("blk_item_a0", "blk_para_a0", "Alpha Beta")]);
    const next = doc([
      item("blk_item_a0", "blk_para_a0", "Alpha"),
      item("blk_item_b0", "blk_para_b0", "Beta"),
    ]);

    expect(planTiptapBlockPatch(base, next)).toMatchObject({
      kind: "list-batch",
      operations: [
        { type: "replace", blockId: "blk_para_a0" },
        { type: "create", scope: "listItem", blockId: "blk_item_b0", targetBlockId: "blk_item_a0" },
      ],
    });
  });

  it("plans multi-item paste in one ordered request", () => {
    const base = doc([item("blk_item_a0", "blk_para_a0", "A")]);
    const next = doc([
      item("blk_item_a0", "blk_para_a0", "A"),
      item("blk_item_b0", "blk_para_b0", "B"),
      item("blk_item_c0", "blk_para_c0", "C"),
    ]);

    const plan = planTiptapBlockPatch(base, next);
    expect(plan?.kind).toBe("list-batch");
    expect(plan?.operations).toHaveLength(2);
    expect(plan?.operations.every((operation) => operation.type === "create")).toBe(true);
  });

  it("plans multi-item deletion atomically", () => {
    const base = doc([
      item("blk_item_a0", "blk_para_a0", "A"),
      item("blk_item_b0", "blk_para_b0", "B"),
      item("blk_item_c0", "blk_para_c0", "C"),
    ]);
    const next = doc([item("blk_item_a0", "blk_para_a0", "A")]);

    expect(planTiptapBlockPatch(base, next)).toMatchObject({
      kind: "list-batch",
      operations: [
        { type: "delete", scope: "listItem", blockId: "blk_item_b0" },
        { type: "delete", scope: "listItem", blockId: "blk_item_c0" },
      ],
    });
  });

  it("plans a continuous multi-item reorder", () => {
    const base = doc([
      item("blk_item_a0", "blk_para_a0", "A"),
      item("blk_item_b0", "blk_para_b0", "B"),
      item("blk_item_c0", "blk_para_c0", "C"),
    ]);
    const next = doc([
      item("blk_item_c0", "blk_para_c0", "C"),
      item("blk_item_b0", "blk_para_b0", "B"),
      item("blk_item_a0", "blk_para_a0", "A"),
    ]);

    const plan = planTiptapBlockPatch(base, next);
    expect(plan?.kind).toBe("list-batch");
    expect(plan?.operations).toHaveLength(2);
    expect(plan?.operations.every((operation) => operation.type === "move")).toBe(true);
  });
});
