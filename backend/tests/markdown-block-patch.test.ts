import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMarkdownBlockPatch,
  hashMarkdownBlock,
  MarkdownBlockPatchError,
  parseMarkdownPatchDocument,
  validateMarkdownBlockPatchOperations,
} from "../src/lib/markdownBlockPatch";

const source = [
  "# 标题 ^blk_heading00",
  "- 第一项\n  - 子项\n- 第二项 ^blk_list00000",
  "```ts\nconst value = 1;\n```\n^blk_code00000",
  "| A | B |\n| - | - |\n| 1 | 2 | ^blk_table0000",
].join("\n\n");

test("uses a browser-compatible FNV-1a 64 hash", () => {
  assert.equal(hashMarkdownBlock("hello"), "a430d84680aabd0b");
});

test("parses stable Markdown blocks without splitting lists, fences or tables", () => {
  const parsed = parseMarkdownPatchDocument(source);
  assert.deepEqual(parsed.blocks.map((block) => block.blockId), [
    "blk_heading00", "blk_list00000", "blk_code00000", "blk_table0000",
  ]);
  assert.match(parsed.blocks[1].content, /子项/);
  assert.match(parsed.blocks[2].content, /const value/);
  assert.match(parsed.blocks[3].content, /\| 1 \| 2 \|/);
});

test("applies replace, insert, move and delete with per-block hashes", () => {
  const blocks = parseMarkdownPatchDocument(source).blocks;
  const operations = validateMarkdownBlockPatchOperations([
    {
      type: "replace",
      blockId: "blk_heading00",
      expectedHash: blocks[0].contentHash,
      content: "## 新标题 ^blk_heading00",
    },
    {
      type: "insert",
      blockId: "blk_new00000",
      targetBlockId: "blk_heading00",
      position: "after",
      content: "新增段落 ^blk_new00000",
    },
    {
      type: "move",
      blockId: "blk_table0000",
      expectedHash: blocks[3].contentHash,
      targetBlockId: "blk_list00000",
      position: "before",
    },
    {
      type: "delete",
      blockId: "blk_code00000",
      expectedHash: blocks[2].contentHash,
    },
  ]);
  const result = applyMarkdownBlockPatch(source, operations);
  assert.deepEqual(parseMarkdownPatchDocument(result.content).blocks.map((block) => block.blockId), [
    "blk_heading00", "blk_new00000", "blk_table0000", "blk_list00000",
  ]);
  assert.match(result.content, /## 新标题/);
});

test("rejects stale hashes, duplicate IDs and unsafe fenced boundaries", () => {
  assert.throws(
    () => applyMarkdownBlockPatch(source, validateMarkdownBlockPatchOperations([{
      type: "delete",
      blockId: "blk_heading00",
      expectedHash: hashMarkdownBlock("stale"),
    }])),
    (error: unknown) => error instanceof MarkdownBlockPatchError && error.code === "BLOCK_HASH_CONFLICT",
  );
  assert.throws(
    () => parseMarkdownPatchDocument("A ^blk_duplicate\n\nB ^blk_duplicate"),
    (error: unknown) => error instanceof MarkdownBlockPatchError && error.code === "BLOCK_ID_CONFLICT",
  );
  assert.throws(
    () => validateMarkdownBlockPatchOperations([{
      type: "replace",
      blockId: "blk_code00000",
      expectedHash: parseMarkdownPatchDocument(source).blocks[2].contentHash,
      content: "```ts\nconst broken = true;\n^blk_code00000",
    }]),
    (error: unknown) => error instanceof MarkdownBlockPatchError && error.code === "UNSAFE_MARKDOWN_BOUNDARY",
  );
  assert.throws(
    () => parseMarkdownPatchDocument("```md\ntext ^blk_inside00\n```\n^blk_code00000"),
    (error: unknown) => error instanceof MarkdownBlockPatchError && error.code === "UNSAFE_MARKDOWN_BOUNDARY",
  );
  assert.throws(
    () => validateMarkdownBlockPatchOperations([{
      type: "replace",
      blockId: "blk_html0000",
      expectedHash: "0000000000000000",
      content: "<details>\ncontent\n^blk_html0000",
    }]),
    (error: unknown) => error instanceof MarkdownBlockPatchError && error.code === "UNSAFE_MARKDOWN_BOUNDARY",
  );
  assert.throws(
    () => validateMarkdownBlockPatchOperations([{
      type: "replace",
      blockId: "blk_math0000",
      expectedHash: "0000000000000000",
      content: "$$\nx + y\n^blk_math0000",
    }]),
    (error: unknown) => error instanceof MarkdownBlockPatchError && error.code === "UNSAFE_MARKDOWN_BOUNDARY",
  );
});
