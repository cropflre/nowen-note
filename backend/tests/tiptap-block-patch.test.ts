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

function doc(content: any[]): string {
  return JSON.stringify({ type: "doc", attrs: { source: "test" }, content });
}

test("applies ordered create, update, move and delete operations to one document", () => {
  const operations = validateTiptapBlockPatchOperations([
    { type: "update", blockId: "blk_alpha00", text: "Alpha updated" },
    {
      type: "create",
      clientId: "client-gamma",
      blockId: "blk_gamma00",
      blockType: "paragraph",
      text: "Gamma",
      afterBlockId: "blk_alpha00",
    },
    {
      type: "move",
      blockId: "blk_beta000",
      targetBlockId: "blk_alpha00",
      position: "before",
    },
    { type: "delete", blockId: "blk_alpha00" },
  ]);

  const result = applyTiptapBlockPatch(
    doc([
      paragraph("blk_alpha00", "Alpha"),
      paragraph("blk_beta000", "Beta"),
    ]),
    operations,
  );
  const parsed = JSON.parse(result.content);

  assert.equal(parsed.attrs.source, "test");
  assert.deepEqual(
    parsed.content.map((node: any) => node.attrs.blockId),
    ["blk_beta000", "blk_gamma00"],
  );
  assert.equal(parsed.content[1].content[0].text, "Gamma");
  assert.deepEqual(result.createdBlocks, [{
    operationIndex: 1,
    clientId: "client-gamma",
    blockId: "blk_gamma00",
  }]);
  assert.deepEqual(result.affectedBlockIds, [
    "blk_alpha00",
    "blk_gamma00",
    "blk_beta000",
  ]);
});

test("keeps a valid editable paragraph after deleting the final block", () => {
  const result = applyTiptapBlockPatch(
    doc([paragraph("blk_only000", "Only")]),
    [{ type: "delete", blockId: "blk_only000" }],
    () => "blk_empty000",
  );
  const parsed = JSON.parse(result.content);

  assert.equal(parsed.content.length, 1);
  assert.equal(parsed.content[0].type, "paragraph");
  assert.equal(parsed.content[0].attrs.blockId, "blk_empty000");
  assert.equal(result.createdBlocks[0].operationIndex, 1);
});

test("repairs a list item after deleting its final nested paragraph", () => {
  const result = applyTiptapBlockPatch(
    doc([{
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { blockId: "blk_item000" },
        content: [paragraph("blk_nested00", "Nested")],
      }],
    }]),
    [{ type: "delete", blockId: "blk_nested00" }],
  );
  const parsed = JSON.parse(result.content);

  assert.equal(parsed.content[0].type, "bulletList");
  assert.equal(parsed.content[0].content[0].type, "listItem");
  assert.deepEqual(parsed.content[0].content[0].content, [{
    type: "paragraph",
    content: [],
  }]);
});

test("removes an empty list wrapper after deleting its final item", () => {
  const result = applyTiptapBlockPatch(
    doc([{
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { blockId: "blk_item000" },
        content: [paragraph("blk_nested00", "Nested")],
      }],
    }]),
    [{ type: "delete", blockId: "blk_item000" }],
    () => "blk_empty000",
  );
  const parsed = JSON.parse(result.content);

  assert.equal(parsed.content.length, 1);
  assert.equal(parsed.content[0].type, "paragraph");
  assert.equal(parsed.content[0].attrs.blockId, "blk_empty000");
});

test("rejects duplicate client IDs and invalid block identifiers", () => {
  assert.throws(
    () => validateTiptapBlockPatchOperations([
      { type: "create", clientId: "same", text: "A" },
      { type: "create", clientId: "same", text: "B" },
    ]),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_PATCH",
  );
  assert.throws(
    () => validateTiptapBlockPatchOperations([
      { type: "update", blockId: "bad", text: "A" },
    ]),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_ID",
  );
});

test("rejects moves across different nested parents without mutating source", () => {
  const source = doc([
    {
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { blockId: "blk_item000" },
        content: [paragraph("blk_para000", "Nested")],
      }],
    },
    paragraph("blk_root000", "Root"),
  ]);

  assert.throws(
    () => applyTiptapBlockPatch(source, [{
      type: "move",
      blockId: "blk_item000",
      targetBlockId: "blk_root000",
      position: "after",
    }]),
    (error: unknown) => (
      error instanceof TiptapBlockPatchError
      && error.code === "BLOCK_MOVE_PARENT_MISMATCH"
    ),
  );
  assert.equal(JSON.parse(source).content[1].attrs.blockId, "blk_root000");
});
