import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTiptapListItemStructure,
  normalizeTiptapListItemPatchNode,
  TiptapListItemStructureError,
} from "../src/lib/tiptapListItemStructure";

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

function doc(content: unknown[]) {
  return { type: "doc", content } as any;
}

test("creates a rich leaf list item beside an existing sibling", () => {
  const document = doc([{
    type: "bulletList",
    content: [item("blk_item_a0", "blk_para_a0", "A")],
  }]);
  const node = {
    type: "listItem",
    attrs: { blockId: "blk_item_b0" },
    content: [paragraph("blk_para_b0", "Linked", [{
      type: "link",
      attrs: {
        href: "note:11111111-1111-4111-8111-111111111111",
        target: null,
        rel: "noopener noreferrer nofollow",
        class: null,
      },
    }])],
  };

  const result = applyTiptapListItemStructure(document, {
    type: "create",
    scope: "listItem",
    clientId: "blk_item_b0",
    blockId: "blk_item_b0",
    targetBlockId: "blk_item_a0",
    position: "after",
    node: normalizeTiptapListItemPatchNode(node, "blk_item_b0"),
  });

  assert.deepEqual(document.content[0].content.map((entry: any) => entry.attrs.blockId), [
    "blk_item_a0",
    "blk_item_b0",
  ]);
  assert.equal(document.content[0].content[1].content[0].attrs.blockId, "blk_para_b0");
  assert.equal(document.content[0].content[1].content[0].content[0].marks[0].type, "link");
  assert.deepEqual(result.createdBlockIds.sort(), ["blk_item_b0", "blk_para_b0"].sort());
  assert.deepEqual(result.deletedBlockIds, []);
});

test("creates task items only inside task lists and preserves checked", () => {
  const document = doc([{
    type: "taskList",
    content: [taskItem("blk_task_a0", "blk_task_pa", "A", false)],
  }]);
  const node = taskItem("blk_task_b0", "blk_task_pb", "B", true);

  applyTiptapListItemStructure(document, {
    type: "create",
    scope: "listItem",
    blockId: "blk_task_b0",
    targetBlockId: "blk_task_a0",
    position: "before",
    node: normalizeTiptapListItemPatchNode(node, "blk_task_b0"),
  });

  assert.equal(document.content[0].content[0].attrs.blockId, "blk_task_b0");
  assert.equal(document.content[0].content[0].attrs.checked, true);

  assert.throws(
    () => applyTiptapListItemStructure(document, {
      type: "create",
      scope: "listItem",
      blockId: "blk_wrong00",
      targetBlockId: "blk_task_a0",
      position: "after",
      node: normalizeTiptapListItemPatchNode(
        item("blk_wrong00", "blk_wrong_p0", "wrong"),
        "blk_wrong00",
      ),
    }),
    (error: unknown) => error instanceof TiptapListItemStructureError
      && error.code === "LIST_STRUCTURE_INVALID",
  );
});

test("deletes one leaf item and removes an empty nested list wrapper", () => {
  const document = doc([{
    type: "bulletList",
    content: [item(
      "blk_parent00",
      "blk_parent_p",
      "Parent",
      {
        type: "bulletList",
        content: [item("blk_child000", "blk_child_p0", "Child")],
      },
    )],
  }]);

  const result = applyTiptapListItemStructure(document, {
    type: "delete",
    scope: "listItem",
    blockId: "blk_child000",
  });

  assert.equal(document.content[0].content[0].content.length, 1);
  assert.equal(document.content[0].content[0].content[0].type, "paragraph");
  assert.deepEqual(result.deletedBlockIds.sort(), ["blk_child000", "blk_child_p0"].sort());
  assert.ok(result.affectedBlockIds.includes("blk_parent00"));
});

test("rejects nested creation, duplicate IDs and deleting a parent subtree", () => {
  assert.throws(
    () => normalizeTiptapListItemPatchNode({
      type: "listItem",
      attrs: { blockId: "blk_new0000" },
      content: [
        paragraph("blk_new_p00", "New"),
        { type: "bulletList", content: [] },
      ],
    }, "blk_new0000"),
    (error: unknown) => error instanceof TiptapListItemStructureError
      && error.code === "INVALID_BLOCK_NODE",
  );

  const document = doc([{
    type: "bulletList",
    content: [item(
      "blk_parent00",
      "blk_parent_p",
      "Parent",
      { type: "bulletList", content: [item("blk_child000", "blk_child_p0", "Child")] },
    )],
  }]);

  assert.throws(
    () => applyTiptapListItemStructure(document, {
      type: "delete",
      scope: "listItem",
      blockId: "blk_parent00",
    }),
    (error: unknown) => error instanceof TiptapListItemStructureError
      && error.code === "LIST_STRUCTURE_INVALID",
  );

  assert.throws(
    () => applyTiptapListItemStructure(document, {
      type: "create",
      scope: "listItem",
      blockId: "blk_child000",
      targetBlockId: "blk_parent00",
      position: "after",
      node: normalizeTiptapListItemPatchNode(
        item("blk_child000", "blk_unique00", "Duplicate"),
        "blk_child000",
      ),
    }),
    (error: unknown) => error instanceof TiptapListItemStructureError
      && error.code === "BLOCK_ID_CONFLICT",
  );
});
