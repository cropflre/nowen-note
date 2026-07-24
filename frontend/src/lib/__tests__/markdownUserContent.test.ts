import { describe, expect, it } from "vitest";
import {
  findInternalMarkdownMarkerRanges,
  projectMarkdownForUser,
} from "../markdownUserContent";

describe("projectMarkdownForUser", () => {
  it("removes inline and post-fence system markers while preserving code contents", () => {
    const source = [
      "# 标题 ^blk_heading1",
      "",
      "正文 ^blk_para001",
      "",
      "```ts",
      "const value = '^blk_inside';",
      "```",
      "^blk_code001",
      "",
      "尾声",
    ].join("\n");

    expect(projectMarkdownForUser(source)).toBe([
      "# 标题",
      "",
      "正文",
      "",
      "```ts",
      "const value = '^blk_inside';",
      "```",
      "",
      "尾声",
    ].join("\n"));
  });

  it("returns source offsets for editor decorations", () => {
    const source = "a ^blk_abcdef\n^blk_ghijkl\n";
    expect(findInternalMarkdownMarkerRanges(source).map(({ kind, blockId }) => ({ kind, blockId }))).toEqual([
      { kind: "inline", blockId: "blk_abcdef" },
      { kind: "line", blockId: "blk_ghijkl" },
    ]);
  });
});
