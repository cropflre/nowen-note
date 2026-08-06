import assert from "node:assert/strict";
import test from "node:test";
import {
  projectMarkdownForUser,
  stripLegacyInternalMarkdownMarkers,
} from "../src/lib/markdownUserContent";

const LEGACY_BLOCK_ID = "blk4e38ed87e6734393a537ba817a91e00f";

test("projects only indexed Markdown block markers", () => {
  const source = [
    "# 标题 ^blk_heading1",
    "用户保留 ^blk_unknown1",
    "```",
    "^blk_heading1",
    "```",
    "^blk_code001",
    "尾声",
  ].join("\n");
  const visible = projectMarkdownForUser(
    source,
    new Set(["blk_heading1", "blk_code001"]),
  );
  assert.equal(visible, [
    "# 标题",
    "用户保留 ^blk_unknown1",
    "```",
    "^blk_heading1",
    "```",
    "尾声",
  ].join("\n"));
});

test("projects legacy compact block metadata without exposing or deleting code samples", () => {
  const source = [
    `正文 ^${LEGACY_BLOCK_ID}`,
    `^${LEGACY_BLOCK_ID}`,
    `^${LEGACY_BLOCK_ID} 前置说明`,
    "```text",
    `^${LEGACY_BLOCK_ID}`,
    "```",
    "普通示例 ^blk_example_text",
  ].join("\n");

  assert.equal(projectMarkdownForUser(source, new Set()), [
    "正文",
    "前置说明",
    "```text",
    `^${LEGACY_BLOCK_ID}`,
    "```",
    "普通示例 ^blk_example_text",
  ].join("\n"));
});

test("legacy normalization preserves current block identity", () => {
  const source = [
    "正文 ^blk_current001",
    `^${LEGACY_BLOCK_ID}`,
    "尾声",
  ].join("\n");

  assert.equal(stripLegacyInternalMarkdownMarkers(source), [
    "正文 ^blk_current001",
    "尾声",
  ].join("\n"));
});
