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
    attrs: { blockId, textAlign: null, lineHeight: null, indent: 0 },
    content: text ? [{ type: "text", text }] : [],
  };
}

function doc(content: unknown[]): string {
  return JSON.stringify({ type: "doc", content });
}

function table(blockId: string, text: string, paragraphId = "blk_cellpara0") {
  return {
    type: "table",
    attrs: { blockId, tableAligns: ["left"], colgroup: null },
    content: [{
      type: "tableRow",
      attrs: { height: 36 },
      content: [{
        type: "tableCell",
        attrs: { colspan: 1, rowspan: 1, colwidth: null, align: "left" },
        content: [paragraph(paragraphId, text)],
      }],
    }],
  };
}

test("replaces one top-level table atomically while preserving its Block ID", () => {
  const tableId = "blk_table0000";
  const replacement = table(tableId, "After");
  const result = applyTiptapBlockPatch(
    doc([table(tableId, "Before")]),
    validateTiptapBlockPatchOperations([{
      type: "replace",
      blockId: tableId,
      node: replacement,
    }]),
  );

  assert.deepEqual(JSON.parse(result.content).content[0], replacement);
  assert.deepEqual(result.affectedBlockIds, [tableId]);
});

test("reports nested paragraph IDs removed by a table replacement", () => {
  const tableId = "blk_table0000";
  const result = applyTiptapBlockPatch(
    doc([table(tableId, "Before", "blk_oldpara00")]),
    validateTiptapBlockPatchOperations([{
      type: "replace",
      blockId: tableId,
      node: table(tableId, "After", "blk_newpara00"),
    }]),
  );

  assert.deepEqual(result.deletedBlockIds, ["blk_oldpara00"]);
});

test("rejects table creation, nested table replacement and nested Block ID conflicts", () => {
  assert.throws(
    () => validateTiptapBlockPatchOperations([{
      type: "create",
      blockId: "blk_table0000",
      blockType: "table",
      text: "",
    }]),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_PATCH",
  );

  const nestedTableId = "blk_table0000";
  assert.throws(
    () => applyTiptapBlockPatch(doc([{
      type: "blockquote",
      attrs: { blockId: "blk_quote0000" },
      content: [table(nestedTableId, "Before")],
    }]), validateTiptapBlockPatchOperations([{
      type: "replace",
      blockId: nestedTableId,
      node: table(nestedTableId, "After"),
    }])),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
  );

  assert.throws(
    () => applyTiptapBlockPatch(
      doc([
        table("blk_table0000", "Before"),
        paragraph("blk_conflict0", "Outside"),
      ]),
      validateTiptapBlockPatchOperations([{
        type: "replace",
        blockId: "blk_table0000",
        node: table("blk_table0000", "After", "blk_conflict0"),
      }]),
    ),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "BLOCK_ID_CONFLICT",
  );
});

test("rejects duplicate paragraph IDs and oversized table shapes before applying", () => {
  const duplicate = table("blk_table0000", "First", "blk_duplicate0");
  duplicate.content[0].content.push({
    type: "tableCell",
    attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
    content: [paragraph("blk_duplicate0", "Second")],
  });
  assert.throws(
    () => validateTiptapBlockPatchOperations([{
      type: "replace",
      blockId: "blk_table0000",
      node: duplicate,
    }]),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
  );

  const oversized = table("blk_table0000", "Cell");
  oversized.content = Array.from({ length: 501 }, () => oversized.content[0]);
  assert.throws(
    () => validateTiptapBlockPatchOperations([{
      type: "replace",
      blockId: "blk_table0000",
      node: oversized,
    }]),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
  );

  const utf8Oversized = table("blk_table0000", "中".repeat(90_000));
  assert.throws(
    () => validateTiptapBlockPatchOperations([{
      type: "replace",
      blockId: "blk_table0000",
      node: utf8Oversized,
    }]),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
  );

  const looseAttrs = table("blk_table0000", "Cell") as any;
  looseAttrs.content[0].content[0].attrs.colspan = "1";
  assert.throws(
    () => validateTiptapBlockPatchOperations([{
      type: "replace",
      blockId: "blk_table0000",
      node: looseAttrs,
    }]),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
  );

  const looseParagraph = table("blk_table0000", "Cell") as any;
  looseParagraph.content[0].content[0].content[0].attrs.textAlign = ["left"];
  assert.throws(
    () => validateTiptapBlockPatchOperations([{
      type: "replace",
      blockId: "blk_table0000",
      node: looseParagraph,
    }]),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
  );
});

test("rejects every operation below a table except replacing the top-level table", () => {
  const source = doc([table("blk_table0000", "Before", "blk_cellpara0")]);
  const cases = [
    { type: "update", blockId: "blk_table0000", text: "No" },
    { type: "delete", blockId: "blk_table0000" },
    { type: "move", blockId: "blk_table0000", targetBlockId: "blk_other000", position: "after" },
    {
      type: "replace",
      blockId: "blk_cellpara0",
      node: paragraph("blk_cellpara0", "No"),
    },
  ];
  for (const operation of cases) {
    assert.throws(
      () => applyTiptapBlockPatch(source, validateTiptapBlockPatchOperations([operation])),
      (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
    );
  }
});

test("requires a table replacement to be the only operation in the request", () => {
  assert.throws(
    () => validateTiptapBlockPatchOperations([
      {
        type: "replace",
        blockId: "blk_table0000",
        node: table("blk_table0000", "After"),
      },
      { type: "update", blockId: "blk_other000", text: "Other" },
    ]),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_PATCH",
  );
});


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

test("replaces safe top-level video, block embed and math atoms", () => {
  const source = doc([
    {
      type: "video",
      attrs: {
        blockId: "blk_video0000",
        src: "/api/attachments/11111111-1111-4111-8111-111111111111",
        platform: "file",
        kind: "file",
        originalUrl: "/api/attachments/11111111-1111-4111-8111-111111111111",
        attachmentId: "11111111-1111-4111-8111-111111111111",
        filename: "before.mp4",
        mimeType: "video/mp4",
        size: 1024,
      },
    },
    { type: "blockEmbed", attrs: { blockId: "blk_embed0000", href: "note:11111111-1111-4111-8111-111111111111" } },
    { type: "mathBlock", attrs: { blockId: "blk_math00000", latex: "x" } },
  ]);
  const replacements = [
    {
      type: "replace",
      blockId: "blk_video0000",
      node: {
        type: "video",
        attrs: {
          blockId: "blk_video0000",
          src: "/api/attachments/11111111-1111-4111-8111-111111111111",
          platform: "file",
          kind: "file",
          originalUrl: "/api/attachments/11111111-1111-4111-8111-111111111111",
          attachmentId: "11111111-1111-4111-8111-111111111111",
          filename: "after.mp4",
          mimeType: "video/mp4",
          size: 2048,
        },
      },
    },
    {
      type: "replace",
      blockId: "blk_embed0000",
      node: { type: "blockEmbed", attrs: { blockId: "blk_embed0000", href: "note:22222222-2222-4222-8222-222222222222" } },
    },
    {
      type: "replace",
      blockId: "blk_math00000",
      node: { type: "mathBlock", attrs: { blockId: "blk_math00000", latex: "x + y" } },
    },
  ];

  const result = applyTiptapBlockPatch(source, validateTiptapBlockPatchOperations(replacements));
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.content[0].attrs.filename, "after.mp4");
  assert.match(parsed.content[1].attrs.href, /^note:/);
  assert.equal(parsed.content[2].attrs.latex, "x + y");
});

test("replaces image attributes in the owning paragraph and rejects unsafe atoms", () => {
  const blockId = "blk_imagepara";
  const source = doc([{
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null, indent: 0 },
    content: [{ type: "image", attrs: { src: "/api/attachments/image-id", alt: "before", title: null, width: 320, height: null } }],
  }]);
  const replacement = {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null, indent: 0 },
    content: [{ type: "image", attrs: { src: "/api/attachments/image-id", alt: "after", title: "预览", width: 640, height: 480 } }],
  };
  const result = applyTiptapBlockPatch(source, validateTiptapBlockPatchOperations([{
    type: "replace",
    blockId,
    node: replacement,
  }]));
  assert.deepEqual(JSON.parse(result.content).content[0], replacement);

  const unsafeNodes = [
    {
      type: "video",
      attrs: {
        blockId: "blk_video0000",
        src: "javascript:alert(1)",
        platform: "file",
        kind: "file",
        originalUrl: "javascript:alert(1)",
        attachmentId: "",
        filename: "demo.mp4",
        mimeType: "video/mp4",
        size: 1,
      },
    },
    { type: "blockEmbed", attrs: { blockId: "blk_embed0000", href: "https://evil.example" } },
    { type: "mathBlock", attrs: { blockId: "blk_math00000", latex: "x".repeat(65_537) } },
  ];
  for (const node of unsafeNodes) {
    assert.throws(
      () => validateTiptapBlockPatchOperations([{ type: "replace", blockId: node.attrs.blockId, node }]),
      (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
    );
  }
});
