import { describe, expect, it } from "vitest";

import { planTiptapBlockPatch } from "@/lib/tiptapBlockPatchPlannerRuntime";

function paragraph(blockId: string, text: string) {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function item(blockId: string, text: string, nested?: unknown) {
  return {
    type: "listItem",
    attrs: { blockId },
    content: [
      paragraph(`blk_p_${blockId.slice(4)}`, text),
      ...(nested ? [nested] : []),
    ],
  };
}

function taskItem(blockId: string, text: string, checked: boolean, nested?: unknown) {
  return {
    type: "taskItem",
    attrs: { blockId, checked },
    content: [
      paragraph(`blk_p_${blockId.slice(4)}`, text),
      ...(nested ? [nested] : []),
    ],
  };
}

function list(
  type: "bulletList" | "orderedList" | "taskList",
  content: unknown[],
  attrs?: Record<string, unknown>,
) {
  return { type, ...(attrs ? { attrs } : {}), content };
}

function nestedChain(length: number): unknown {
  let current: unknown = item(`blk_deep_${String(length).padStart(2, "0")}`, `Deep ${length}`);
  for (let index = length - 1; index >= 0; index -= 1) {
    current = item(
      `blk_deep_${String(index).padStart(2, "0")}`,
      `Deep ${index}`,
      list("bulletList", [current]),
    );
  }
  return current;
}

function doc(content: unknown[]) {
  return JSON.stringify({ type: "doc", content });
}

describe("Tiptap controlled list hierarchy planner", () => {
  it("plans one immediate sibling sink", () => {
    const base = doc([list("bulletList", [
      item("blk_item_a0", "A"),
      item("blk_item_b0", "B"),
      item("blk_item_c0", "C"),
    ])]);
    const next = doc([list("bulletList", [
      item("blk_item_a0", "A", list("bulletList", [item("blk_item_b0", "B")])),
      item("blk_item_c0", "C"),
    ])]);

    expect(planTiptapBlockPatch(base, next)).toEqual({
      kind: "list-hierarchy",
      operations: [{
        type: "move",
        scope: "listItem",
        blockId: "blk_item_b0",
        targetBlockId: "blk_item_a0",
        position: "inside",
      }],
      affectedBlockIds: ["blk_item_b0", "blk_item_a0"],
    });
  });

  it("plans sinking an item whose subtree changes more than eight descendant depths", () => {
    const subtree = nestedChain(10);
    const movable = item("blk_item_b0", "B", list("bulletList", [subtree]));
    const base = doc([list("bulletList", [
      item("blk_item_a0", "A"),
      movable,
      item("blk_item_c0", "C"),
    ])]);
    const next = doc([list("bulletList", [
      item("blk_item_a0", "A", list("bulletList", [movable])),
      item("blk_item_c0", "C"),
    ])]);

    expect(planTiptapBlockPatch(base, next)).toMatchObject({
      kind: "list-hierarchy",
      operations: [{
        type: "move",
        scope: "listItem",
        blockId: "blk_item_b0",
        targetBlockId: "blk_item_a0",
        position: "inside",
      }],
    });
  });

  it("plans ordered-list sinking with canonical list attrs", () => {
    const attrs = { start: 1 };
    const base = doc([list("orderedList", [
      item("blk_item_a0", "A"),
      item("blk_item_b0", "B"),
    ], attrs)]);
    const next = doc([list("orderedList", [
      item("blk_item_a0", "A", list("orderedList", [item("blk_item_b0", "B")], attrs)),
    ], attrs)]);

    expect(planTiptapBlockPatch(base, next)).toMatchObject({
      kind: "list-hierarchy",
      operations: [{
        type: "move",
        scope: "listItem",
        blockId: "blk_item_b0",
        targetBlockId: "blk_item_a0",
        position: "inside",
      }],
    });
  });

  it("plans one nested item lift after its direct parent", () => {
    const base = doc([list("bulletList", [
      item("blk_item_a0", "A", list("bulletList", [item("blk_item_b0", "B")])),
      item("blk_item_c0", "C"),
    ])]);
    const next = doc([list("bulletList", [
      item("blk_item_a0", "A"),
      item("blk_item_b0", "B"),
      item("blk_item_c0", "C"),
    ])]);

    expect(planTiptapBlockPatch(base, next)).toMatchObject({
      kind: "list-hierarchy",
      operations: [{
        type: "move",
        scope: "listItem",
        blockId: "blk_item_b0",
        targetBlockId: "blk_item_a0",
        position: "after",
      }],
    });
  });

  it("plans one same-depth move between separate lists", () => {
    const separator = paragraph("blk_separator", "Between");
    const base = doc([
      list("bulletList", [item("blk_item_a0", "A")]),
      separator,
      list("bulletList", [item("blk_item_b0", "B"), item("blk_item_c0", "C")]),
    ]);
    const next = doc([
      separator,
      list("bulletList", [
        item("blk_item_b0", "B"),
        item("blk_item_c0", "C"),
        item("blk_item_a0", "A"),
      ]),
    ]);

    expect(planTiptapBlockPatch(base, next)).toMatchObject({
      kind: "list-hierarchy",
      operations: [{
        type: "move",
        scope: "listItem",
        blockId: "blk_item_a0",
        targetBlockId: "blk_item_c0",
        position: "after",
      }],
    });
  });

  it("chooses one stable equivalent operation for an adjacent swap", () => {
    const base = doc([list("bulletList", [
      item("blk_item_a0", "A"),
      item("blk_item_b0", "B"),
      item("blk_item_c0", "C"),
    ])]);
    const next = doc([list("bulletList", [
      item("blk_item_b0", "B"),
      item("blk_item_a0", "A"),
      item("blk_item_c0", "C"),
    ])]);

    expect(planTiptapBlockPatch(base, next)).toEqual({
      kind: "list-hierarchy",
      operations: [{
        type: "move",
        scope: "listItem",
        blockId: "blk_item_a0",
        targetBlockId: "blk_item_c0",
        position: "before",
      }],
      affectedBlockIds: ["blk_item_a0", "blk_item_c0"],
    });
  });

  it("plans task-list sinking without losing checked state", () => {
    const base = doc([list("taskList", [
      taskItem("blk_task_a0", "A", true),
      taskItem("blk_task_b0", "B", false),
    ])]);
    const next = doc([list("taskList", [
      taskItem(
        "blk_task_a0",
        "A",
        true,
        list("taskList", [taskItem("blk_task_b0", "B", false)]),
      ),
    ])]);

    expect(planTiptapBlockPatch(base, next)).toMatchObject({
      kind: "list-hierarchy",
      operations: [{ position: "inside", blockId: "blk_task_b0" }],
    });
  });

  it("rejects content changes, multiple moves and list-type conversion", () => {
    const base = doc([list("bulletList", [
      item("blk_item_a0", "A"),
      item("blk_item_b0", "B"),
      item("blk_item_c0", "C"),
      item("blk_item_d0", "D"),
    ])]);

    const sinkWithTextChange = doc([list("bulletList", [
      item("blk_item_a0", "A", list("bulletList", [item("blk_item_b0", "B changed")])),
      item("blk_item_c0", "C"),
      item("blk_item_d0", "D"),
    ])]);
    expect(planTiptapBlockPatch(base, sinkWithTextChange)).toBeNull();

    const twoMoves = doc([list("bulletList", [
      item("blk_item_b0", "B"),
      item("blk_item_a0", "A"),
      item("blk_item_d0", "D"),
      item("blk_item_c0", "C"),
    ])]);
    expect(planTiptapBlockPatch(base, twoMoves)).toBeNull();

    const ordered = doc([list("orderedList", [
      item("blk_item_a0", "A"),
      item("blk_item_b0", "B"),
      item("blk_item_c0", "C"),
      item("blk_item_d0", "D"),
    ], { start: 1 })]);
    expect(planTiptapBlockPatch(base, ordered)).toBeNull();
  });
});
