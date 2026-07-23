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
    attrs: { blockId, textAlign: null, lineHeight: null },
    content: text ? [{ type: "text", text }] : [],
  };
}

function doc(content: unknown[]): string {
  return JSON.stringify({ type: "doc", content });
}

test("replaces a paragraph with validated marks, hard breaks and block attributes", () => {
  const blockId = "blk_rich0000";
  const operations = validateTiptapBlockPatchOperations([{
    type: "replace",
    blockId,
    node: {
      type: "paragraph",
      attrs: { blockId, textAlign: "center", lineHeight: "1.6" },
      content: [
        { type: "text", text: "Bold", marks: [{ type: "bold" }] },
        { type: "hardBreak" },
        {
          type: "text",
          text: "Nowen",
          marks: [{
            type: "link",
            attrs: {
              href: "note:11111111-1111-4111-8111-111111111111#blk:blk_target00",
              target: null,
              rel: "noopener noreferrer nofollow",
              class: null,
            },
          }],
        },
        {
          type: "text",
          text: " styled",
          marks: [
            { type: "textStyle", attrs: { color: "#ef4444", fontSize: "20px" } },
            { type: "highlight", attrs: { color: "#fef9c3" } },
          ],
        },
      ],
    },
  }]);

  const result = applyTiptapBlockPatch(doc([paragraph(blockId, "Before")]), operations);
  const node = JSON.parse(result.content).content[0];

  assert.equal(node.type, "paragraph");
  assert.deepEqual(node.attrs, { blockId, textAlign: "center", lineHeight: "1.6" });
  assert.equal(node.content[0].marks[0].type, "bold");
  assert.equal(node.content[1].type, "hardBreak");
  assert.match(node.content[2].marks[0].attrs.href, /^note:/);
  assert.equal(node.content[3].marks[0].attrs.fontSize, "20px");
  assert.deepEqual(result.affectedBlockIds, [blockId]);
});

test("allows top-level paragraph, heading and code block conversions with safe attrs", () => {
  const source = doc([
    paragraph("blk_heading00", "Title"),
    {
      type: "codeBlock",
      attrs: { blockId: "blk_code0000", language: null, indent: 0 },
      content: [{ type: "text", text: "const a = 1" }],
    },
  ]);

  const result = applyTiptapBlockPatch(source, validateTiptapBlockPatchOperations([
    {
      type: "replace",
      blockId: "blk_heading00",
      node: {
        type: "heading",
        attrs: {
          blockId: "blk_heading00",
          level: 3,
          textAlign: "right",
          lineHeight: "1.8",
        },
        content: [{ type: "text", text: "Formatted title", marks: [{ type: "italic" }] }],
      },
    },
    {
      type: "replace",
      blockId: "blk_code0000",
      node: {
        type: "codeBlock",
        attrs: { blockId: "blk_code0000", language: "typescript", indent: 2 },
        content: [{ type: "text", text: "const answer: number = 42" }],
      },
    },
  ]));
  const parsed = JSON.parse(result.content);

  assert.equal(parsed.content[0].type, "heading");
  assert.equal(parsed.content[0].attrs.level, 3);
  assert.equal(parsed.content[0].content[0].marks[0].type, "italic");
  assert.equal(parsed.content[1].attrs.language, "typescript");
  assert.equal(parsed.content[1].attrs.indent, 2);
});

test("rejects unsafe links, unknown marks and mismatched Block IDs before applying", () => {
  const unsafeCases = [
    {
      type: "paragraph",
      attrs: { blockId: "blk_safe0000" },
      content: [{
        type: "text",
        text: "unsafe",
        marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
      }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "blk_safe0000" },
      content: [{ type: "text", text: "unknown", marks: [{ type: "mention" }] }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "blk_other000" },
      content: [{ type: "text", text: "wrong id" }],
    },
  ];

  for (const node of unsafeCases) {
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

test("does not allow a nested paragraph replacement to change the parent schema", () => {
  const source = doc([{
    type: "bulletList",
    content: [{
      type: "listItem",
      attrs: { blockId: "blk_item0000" },
      content: [paragraph("blk_nested00", "Nested")],
    }],
  }]);

  assert.throws(
    () => applyTiptapBlockPatch(source, validateTiptapBlockPatchOperations([{
      type: "replace",
      blockId: "blk_nested00",
      node: {
        type: "heading",
        attrs: {
          blockId: "blk_nested00",
          level: 2,
          textAlign: null,
          lineHeight: null,
        },
        content: [{ type: "text", text: "Must remain a paragraph" }],
      },
    }])),
    (error: unknown) => (
      error instanceof TiptapBlockPatchError
      && error.code === "INVALID_BLOCK_NODE"
    ),
  );
});
