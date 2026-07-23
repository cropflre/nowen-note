import { describe, expect, it } from "vitest";

import { planTiptapBlockPatch } from "@/lib/tiptapBlockPatchPlannerRuntime";

function paragraph(blockId: string, text: string, marks?: unknown[]) {
  return {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null },
    content: text ? [{ type: "text", text, ...(marks ? { marks } : {}) }] : [],
  };
}

function item(blockId: string, paragraphId: string, text: string, nested?: unknown) {
  return {
    type: "listItem",
    attrs: { blockId },
    content: [paragraph(paragraphId, text), ...(nested ? [nested] : [])],
  };
}

function taskItem(blockId: string, paragraphId: string, text: string, checked: boolean) {
  return {
    type: "taskItem",
    attrs: { blockId, checked },
    content: [paragraph(paragraphId, text)],
  };
}

function list(type: "bulletList" | "orderedList" | "taskList", content: unknown[]) {
  return { type, content };
}

function doc(content: unknown[]) {
  return JSON.stringify({ type: "doc", content });
}

describe("Tiptap controlled list item structure planner", () => {
  it("plans one rich item insertion after an existing sibling", () => {
    const base = doc([list("bulletList", [
      item("blk_item_a0", "blk_para_a0", "A"),
      item("blk_item_c0", "blk_para_c0", "C"),
    ])]);
    const newItem = {
      type: "listItem",
      attrs: { blockId: "blk_item_b0" },
      content: [paragraph("blk_para_b0", "B", [{ type: "bold" }])],
    };
    const next = doc([list("bulletList", [
      item("blk_item_a0", "blk_para_a0", "A"),
      newItem,
      item("blk_item_c0", "blk_para_c0", "C"),
    ])]);

    expect(planTiptapBlockPatch(base, next)).toEqual({
      kind: "list-structure",
      operations: [{
        type: "create",
        scope: "listItem",
        clientId: "blk_item_b0",
        blockId: "blk_item_b0",
        targetBlockId: "blk_item_a0",
        position: "after",
        node: newItem,
      }],
      affectedBlockIds: ["blk_item_b0", "blk_para_b0", "blk_item_a0"],
    });
  });

  it("plans insertion before the first sibling and preserves task checked state", () => {
    const base = doc([list("taskList", [
      taskItem("blk_task_b0", "blk_task_pb", "B", false),
    ])]);
    const newItem = taskItem("blk_task_a0", "blk_task_pa", "A", true);
    const next = doc([list("taskList", [
      newItem,
      taskItem("blk_task_b0", "blk_task_pb", "B", false),
    ])]);

    expect(planTiptapBlockPatch(base, next)).toMatchObject({
      kind: "list-structure",
      operations: [{
        type: "create",
        scope: "listItem",
        blockId: "blk_task_a0",
        targetBlockId: "blk_task_b0",
        position: "before",
        node: newItem,
      }],
    });
  });

  it("plans deletion of one leaf item", () => {
    const base = doc([list("bulletList", [
      item("blk_item_a0", "blk_para_a0", "A"),
      item("blk_item_b0", "blk_para_b0", "B"),
      item("blk_item_c0", "blk_para_c0", "C"),
    ])]);
    const next = doc([list("bulletList", [
      item("blk_item_a0", "blk_para_a0", "A"),
      item("blk_item_c0", "blk_para_c0", "C"),
    ])]);

    expect(planTiptapBlockPatch(base, next)).toEqual({
      kind: "list-structure",
      operations: [{ type: "delete", scope: "listItem", blockId: "blk_item_b0" }],
      affectedBlockIds: ["blk_item_b0"],
    });
  });

  it("rejects item splitting, nested item creation and final-item deletion", () => {
    const splitBase = doc([list("bulletList", [
      item("blk_item_a0", "blk_para_a0", "Alpha Beta"),
    ])]);
    const splitNext = doc([list("bulletList", [
      item("blk_item_a0", "blk_para_a0", "Alpha"),
      item("blk_item_b0", "blk_para_b0", "Beta"),
    ])]);
    expect(planTiptapBlockPatch(splitBase, splitNext)).toBeNull();

    const nestedBase = doc([list("bulletList", [
      item("blk_item_a0", "blk_para_a0", "A"),
    ])]);
    const nestedNext = doc([list("bulletList", [
      item("blk_item_a0", "blk_para_a0", "A"),
      item(
        "blk_item_b0",
        "blk_para_b0",
        "B",
        list("bulletList", [item("blk_item_c0", "blk_para_c0", "C")]),
      ),
    ])]);
    expect(planTiptapBlockPatch(nestedBase, nestedNext)).toBeNull();

    const finalNext = doc([paragraph("blk_empty000", "")]);
    expect(planTiptapBlockPatch(splitBase, finalNext)).toBeNull();
  });
});
