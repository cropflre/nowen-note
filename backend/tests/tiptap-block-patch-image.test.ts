import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTiptapBlockPatch,
  TiptapBlockPatchError,
  validateTiptapBlockPatchOperations,
} from "../src/lib/tiptapBlockPatch";

const paragraphId = "blk_image_paragraph";

function paragraph(imageAttrs: Record<string, unknown>) {
  return {
    type: "paragraph",
    attrs: { blockId: paragraphId, textAlign: null, lineHeight: null },
    content: [
      { type: "text", text: "Before " },
      { type: "image", attrs: imageAttrs },
      { type: "text", text: " after" },
    ],
  };
}

function doc(node: unknown): string {
  return JSON.stringify({ type: "doc", content: [node] });
}

function replace(node: unknown) {
  return validateTiptapBlockPatchOperations([{
    type: "replace",
    blockId: paragraphId,
    node,
  }]);
}

test("replaces one paragraph containing a safely attributed inline image", () => {
  const base = paragraph({
    src: "/api/attachments/11111111-1111-4111-8111-111111111111/content",
    alt: "Diagram",
    title: null,
    width: 320,
    height: 180,
    rotation: 0,
    flipX: false,
  });
  const next = paragraph({
    src: "/api/attachments/11111111-1111-4111-8111-111111111111/content",
    alt: "Diagram",
    title: "Rotated diagram",
    width: 640,
    height: 360,
    rotation: 90,
    flipX: true,
  });

  const operations = replace(next);
  const result = applyTiptapBlockPatch(doc(base), operations);
  const parsed = JSON.parse(result.content);

  assert.deepEqual(parsed.content[0], next);
  assert.deepEqual(result.affectedBlockIds, [paragraphId]);
  assert.deepEqual(result.deletedBlockIds, []);
});

test("accepts a bounded raster data URL but rejects SVG and unsafe protocols", () => {
  const raster = paragraph({ src: "data:image/png;base64,iVBORw0KGgo=", width: 12, height: 12 });
  assert.equal(replace(raster).length, 1);

  for (const src of [
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "javascript:alert(1)",
    "file:///tmp/private.png",
    "blob:https://example.com/temporary",
  ]) {
    assert.throws(
      () => replace(paragraph({ src, width: 12, height: 12 })),
      (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
    );
  }
});

test("rejects unknown image attrs and images inside code blocks", () => {
  assert.throws(
    () => replace(paragraph({ src: "https://example.com/a.png", onclick: "alert(1)" })),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
  );

  assert.throws(
    () => replace({
      type: "codeBlock",
      attrs: { blockId: paragraphId, language: null, indent: 0 },
      content: [{ type: "image", attrs: { src: "https://example.com/a.png" } }],
    }),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
  );
});

test("rejects oversized dimensions and image marks", () => {
  assert.throws(
    () => replace(paragraph({ src: "https://example.com/a.png", width: 10001 })),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
  );

  const marked = paragraph({ src: "https://example.com/a.png" });
  (marked.content[1] as Record<string, unknown>).marks = [{ type: "link", attrs: { href: "https://example.com" } }];
  assert.throws(
    () => replace(marked),
    (error: unknown) => error instanceof TiptapBlockPatchError && error.code === "INVALID_BLOCK_NODE",
  );
});
