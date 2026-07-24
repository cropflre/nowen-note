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

test("applies a list split and multi-item batch atomically", () => {
  const source = doc([{
    type: "bulletList",
    content: [{
      type: "listItem",
      attrs: { blockId: "blk_item_a0" },
      content: [paragraph("blk_para_a0", "Alpha Beta")],
    }],
  }]);
  const newItem = {
    type: "listItem" as const,
    attrs: { blockId: "blk_item_b0" },
    content: [paragraph("blk_para_b0", "Beta")],
  };
  const operations = validateTiptapBlockPatchOperations([
    {
      type: "replace",
      blockId: "blk_para_a0",
      node: paragraph("blk_para_a0", "Alpha"),
    },
    {
      type: "create",
      scope: "listItem",
      clientId: "blk_item_b0",
      blockId: "blk_item_b0",
      targetBlockId: "blk_item_a0",
      position: "after",
      node: newItem,
    },
    {
      type: "create",
      scope: "listItem",
      clientId: "blk_item_c0",
      blockId: "blk_item_c0",
      targetBlockId: "blk_item_b0",
      position: "after",
      node: {
        type: "listItem",
        attrs: { blockId: "blk_item_c0" },
        content: [paragraph("blk_para_c0", "Gamma")],
      },
    },
  ]);

  const result = applyTiptapBlockPatch(source, operations);
  const parsed = JSON.parse(result.content);
  assert.deepEqual(
    parsed.content[0].content.map((entry: any) => entry.attrs.blockId),
    ["blk_item_a0", "blk_item_b0", "blk_item_c0"],
  );
  assert.equal(parsed.content[0].content[0].content[0].content[0].text, "Alpha");
  assert.deepEqual(result.createdBlocks.map((entry) => entry.blockId), ["blk_item_b0", "blk_item_c0"]);
});

test("replaces one leaf block with validated marks and block attributes", () => {
  const operations = validateTiptapBlockPatchOperations([{
    type: "replace",
    blockId: "blk_rich0000",
    node: {
      type: "heading",
      attrs: {
        blockId: "blk_rich0000",
        level: 3,
        textAlign: "center",
        lineHeight: "1.6",
      },
      content: [
        {
          type: "text",
          text: "Nowen",
          marks: [
            { type: "bold" },
            { type: "textStyle", attrs: { color: "#3b82f6", fontSize: "20px" } },
          ],
        },
        { type: "hardBreak" },
        {
          type: "text",
          text: "Docs",
          marks: [{
            type: "link",
            attrs: {
              href: "note:12345678-1234-1234-1234-123456789012#blk:blk_target00",
              target: "_blank",
              rel: "noopener noreferrer",
            },
          }],
        },
      ],
    },
  }]);

  const result = applyTiptapBlockPatch(
    doc([paragraph("blk_rich0000", "Before")]),
    operations,
  );
  const replaced = JSON.parse(result.content).content[0];

  assert.equal(replaced.type, "heading");
  assert.equal(replaced.attrs.blockId, "blk_rich0000");
  assert.equal(replaced.attrs.level, 3);
  assert.equal(replaced.attrs.textAlign, "center");
  assert.deepEqual(replaced.content[0].marks.map((mark: any) => mark.type), ["bold", "textStyle"]);
  assert.equal(replaced.content[2].marks[0].attrs.href.startsWith("note:"), true);
  assert.deepEqual(result.affectedBlockIds, ["blk_rich0000"]);
});

test("rejects unsafe links, unknown marks and mismatched replacement IDs", () => {
  const invalidNodes = [
    {
      type: "paragraph",
      attrs: { blockId: "blk_safe0000" },
      content: [{
        type: "text",
        text: "Bad link",
        marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
      }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "blk_safe0000" },
      content: [{ type: "text", text: "Bad mark", marks: [{ type: "script" }] }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "blk_other000" },
      content: [{ type: "text", text: "Wrong ID" }],
    },
  ];

  for (const node of invalidNodes) {
    assert.throws(
      () => validateTiptapBlockPatchOperations([{
        type: "replace",
        blockId: "blk_safe0000",
        node,
      }]),
      (error: unknown) => (
        error instanceof TiptapBlockPatchError
        && error.code === "INVALID_BLOCK_NODE"
      ),
    );
  }
});

test("keeps nested list paragraph replacement schema-compatible", () => {
  const source = doc([{
    type: "bulletList",
    content: [{
      type: "listItem",
      attrs: { blockId: "blk_item000" },
      content: [paragraph("blk_nested00", "Before")],
    }],
  }]);

  const valid = applyTiptapBlockPatch(source, validateTiptapBlockPatchOperations([{
    type: "replace",
    blockId: "blk_nested00",
    node: {
      type: "paragraph",
      attrs: { blockId: "blk_nested00", lineHeight: "1.8" },
      content: [{ type: "text", text: "After", marks: [{ type: "italic" }] }],
    },
  }]));
  const nested = JSON.parse(valid.content).content[0].content[0].content[0];
  assert.equal(nested.type, "paragraph");
  assert.equal(nested.content[0].marks[0].type, "italic");

  assert.throws(
    () => applyTiptapBlockPatch(source, validateTiptapBlockPatchOperations([{
      type: "replace",
      blockId: "blk_nested00",
      node: {
        type: "heading",
        attrs: { blockId: "blk_nested00", level: 2 },
        content: [{ type: "text", text: "Invalid nested heading" }],
      },
    }])),
    (error: unknown) => (
      error instanceof TiptapBlockPatchError
      && error.code === "INVALID_BLOCK_NODE"
    ),
  );
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
