import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTiptapBlockPatch,
  TiptapBlockPatchError,
  validateTiptapBlockPatchOperations,
} from "../src/lib/tiptapBlockPatch";

function paragraph(blockId: string, text: string) {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function listItem(blockId: string, text: string, nested?: unknown) {
  return {
    type: "listItem",
    attrs: { blockId },
    content: [
      paragraph(`blk_p_${blockId.slice(4)}`, text),
      ...(nested ? [nested] : []),
    ],
  };
}

function taskItem(blockId: string, text: string, checked = false, nested?: unknown) {
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
  items: unknown[],
  attrs?: Record<string, unknown>,
) {
  return { type, ...(attrs ? { attrs } : {}), content: items };
}

function doc(content: unknown[]): string {
  return JSON.stringify({ type: "doc", content });
}

function patch(source: string, operation: unknown) {
  return JSON.parse(applyTiptapBlockPatch(
    source,
    validateTiptapBlockPatchOperations([operation]),
  ).content);
}

test("sinks one list item under its immediate previous sibling", () => {
  const source = doc([list("bulletList", [
    listItem("blk_item_a0", "A"),
    listItem("blk_item_b0", "B"),
    listItem("blk_item_c0", "C"),
  ])]);

  const result = patch(source, {
    type: "move",
    scope: "listItem",
    blockId: "blk_item_b0",
    targetBlockId: "blk_item_a0",
    position: "inside",
  });

  const outer = result.content[0];
  assert.deepEqual(outer.content.map((item: any) => item.attrs.blockId), ["blk_item_a0", "blk_item_c0"]);
  const nested = outer.content[0].content[1];
  assert.equal(nested.type, "bulletList");
  assert.deepEqual(nested.content.map((item: any) => item.attrs.blockId), ["blk_item_b0"]);
  assert.equal(nested.content[0].content[0].content[0].text, "B");
});

test("copies ordered-list attrs when a nested list is created", () => {
  const source = doc([list("orderedList", [
    listItem("blk_item_a0", "A"),
    listItem("blk_item_b0", "B"),
  ], { start: 1 })]);

  const result = patch(source, {
    type: "move",
    scope: "listItem",
    blockId: "blk_item_b0",
    targetBlockId: "blk_item_a0",
    position: "inside",
  });

  const outer = result.content[0];
  assert.deepEqual(outer.attrs, { start: 1 });
  assert.deepEqual(outer.content[0].content[1].attrs, { start: 1 });
  assert.equal(outer.content[0].content[1].type, "orderedList");
});

test("lifts one nested list item directly after its parent and removes an empty nested list", () => {
  const nested = list("bulletList", [listItem("blk_item_b0", "B")]);
  const source = doc([list("bulletList", [
    listItem("blk_item_a0", "A", nested),
    listItem("blk_item_c0", "C"),
  ])]);

  const result = patch(source, {
    type: "move",
    scope: "listItem",
    blockId: "blk_item_b0",
    targetBlockId: "blk_item_a0",
    position: "after",
  });

  const outer = result.content[0];
  assert.deepEqual(outer.content.map((item: any) => item.attrs.blockId), [
    "blk_item_a0",
    "blk_item_b0",
    "blk_item_c0",
  ]);
  assert.equal(outer.content[0].content.some((node: any) => node.type === "bulletList"), false);
});

test("moves an item between same-depth lists and removes the empty source wrapper", () => {
  const source = doc([
    list("bulletList", [listItem("blk_item_a0", "A")]),
    paragraph("blk_separator", "Between"),
    list("bulletList", [
      listItem("blk_item_b0", "B"),
      listItem("blk_item_c0", "C"),
    ]),
  ]);

  const result = patch(source, {
    type: "move",
    scope: "listItem",
    blockId: "blk_item_a0",
    targetBlockId: "blk_item_c0",
    position: "after",
  });

  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].attrs.blockId, "blk_separator");
  assert.deepEqual(result.content[1].content.map((item: any) => item.attrs.blockId), [
    "blk_item_b0",
    "blk_item_c0",
    "blk_item_a0",
  ]);
});

test("supports task-list sinking while preserving checked state", () => {
  const source = doc([list("taskList", [
    taskItem("blk_task_a0", "A", true),
    taskItem("blk_task_b0", "B", false),
  ])]);

  const result = patch(source, {
    type: "move",
    scope: "listItem",
    blockId: "blk_task_b0",
    targetBlockId: "blk_task_a0",
    position: "inside",
  });

  const parent = result.content[0].content[0];
  assert.equal(parent.attrs.checked, true);
  assert.equal(parent.content[1].type, "taskList");
  assert.equal(parent.content[1].content[0].attrs.checked, false);
});

test("rejects non-adjacent sinking and list-type changes", () => {
  const nonAdjacent = doc([list("bulletList", [
    listItem("blk_item_a0", "A"),
    listItem("blk_item_b0", "B"),
    listItem("blk_item_c0", "C"),
  ])]);
  assert.throws(
    () => patch(nonAdjacent, {
      type: "move",
      scope: "listItem",
      blockId: "blk_item_c0",
      targetBlockId: "blk_item_a0",
      position: "inside",
    }),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "LIST_MOVE_INVALID",
  );

  const mixed = doc([
    list("bulletList", [listItem("blk_item_a0", "A")]),
    list("orderedList", [listItem("blk_item_b0", "B")], { start: 1 }),
  ]);
  assert.throws(
    () => patch(mixed, {
      type: "move",
      scope: "listItem",
      blockId: "blk_item_a0",
      targetBlockId: "blk_item_b0",
      position: "after",
    }),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "LIST_MOVE_INVALID",
  );
});

test("keeps legacy top-level move position optional but requires list scope positions", () => {
  assert.doesNotThrow(() => validateTiptapBlockPatchOperations([{
    type: "move",
    blockId: "blk_alpha00",
    targetBlockId: "blk_beta000",
  }]));
  assert.throws(
    () => validateTiptapBlockPatchOperations([{
      type: "move",
      scope: "listItem",
      blockId: "blk_item_a0",
      targetBlockId: "blk_item_b0",
    }]),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_PATCH",
  );
});
