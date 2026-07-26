import assert from "node:assert/strict";
import test from "node:test";
import { projectMarkdownForUser } from "../src/lib/markdownUserContent";

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
