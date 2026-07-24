import { describe, expect, it } from "vitest";

import { applyMarkdownBlockPatch } from "@/lib/markdownBlockPatch";
import { planMarkdownBlockPatch } from "@/lib/markdownBlockPatchPlanner";

const base = [
  "# 标题 ^blk_heading00",
  "正文 ^blk_body00000",
  "```ts\nconst value = 1;\n```\n^blk_code00000",
].join("\n\n");

describe("Markdown Block Patch planner", () => {
  it("plans replace, insert, delete and move and replays exactly", () => {
    const next = [
      "新增 ^blk_new00000",
      "```ts\nconst value = 2;\n```\n^blk_code00000",
      "## 新标题 ^blk_heading00",
    ].join("\n\n");
    const plan = planMarkdownBlockPatch(base, next);
    expect(plan).not.toBeNull();
    expect(plan?.operations.map((operation) => operation.type)).toEqual([
      "replace", "replace", "delete", "insert", "move", "move",
    ]);
    expect(applyMarkdownBlockPatch(base, plan!.operations).content).toBe(next);
  });

  it("fails closed without stable IDs or across an unsafe fence", () => {
    expect(planMarkdownBlockPatch("plain text", "changed text")).toBeNull();
    expect(planMarkdownBlockPatch(
      "```ts\nconst value = 1;\n```\n^blk_code00000",
      "```ts\nconst value = 2;\n^blk_code00000",
    )).toBeNull();
  });
});
