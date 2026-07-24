import { describe, expect, it } from "vitest";
import {
  findInternalMarkdownMarkerRanges,
  projectMarkdownForUser,
} from "../markdownUserContent";

const HEADING_ID = "blk_11111111-1111-4111-8111-111111111111";
const PARAGRAPH_ID = "blk_22222222-2222-4222-8222-222222222222";
const CODE_ID = "blk_33333333-3333-4333-8333-333333333333";

describe("projectMarkdownForUser", () => {
  it("removes generated inline and post-fence markers while preserving code contents", () => {
    const source = [
      `# 标题 ^${HEADING_ID}`,
      "",
      `正文 ^${PARAGRAPH_ID}`,
      "",
      "```ts",
      "const value = '^blk_inside';",
      "```",
      `^${CODE_ID}`,
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

  it("keeps ordinary user-authored ^blk_ text visible", () => {
    const source = "文档中的普通示例 ^blk_example_text";
    expect(projectMarkdownForUser(source)).toBe(source);
  });

  it("returns source offsets for editor decorations", () => {
    const source = `a ^${HEADING_ID}\n^${CODE_ID}\n`;
    expect(findInternalMarkdownMarkerRanges(source).map(({ kind, blockId }) => ({ kind, blockId }))).toEqual([
      { kind: "inline", blockId: HEADING_ID },
      { kind: "line", blockId: CODE_ID },
    ]);
  });
});
