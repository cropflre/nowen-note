import { describe, expect, it } from "vitest";
import {
  findInternalMarkdownMarkerRanges,
  projectMarkdownForUser,
  resolveInternalMarkerSyncSelection,
  resolveInternalMarkdownTypingPosition,
  sanitizeMarkdownClipboardText,
} from "../markdownUserContent";

const HEADING_ID = "blk_11111111-1111-4111-8111-111111111111";
const PARAGRAPH_ID = "blk_22222222-2222-4222-8222-222222222222";
const CODE_ID = "blk_33333333-3333-4333-8333-333333333333";
const LEGACY_ID = "blk4e38ed87e6734393a537ba817a91e00f";

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

  it("removes legacy compact markers from imported Markdown", () => {
    const source = [
      `正文 ^${LEGACY_ID}`,
      `^${LEGACY_ID}`,
      `^${LEGACY_ID} 前置说明`,
      "尾声",
    ].join("\n");

    expect(projectMarkdownForUser(source)).toBe([
      "正文",
      "前置说明",
      "尾声",
    ].join("\n"));
  });

  it("keeps ordinary user-authored ^blk_ text visible", () => {
    const source = "文档中的普通示例 ^blk_example_text";
    expect(projectMarkdownForUser(source)).toBe(source);
  });

  it("hides a truncated generated block marker instead of exposing it in the editor", () => {
    const damaged = "blk_d765500d-f8a2-4507-b53f-4fae35ba069";
    const source = `正文 ^${damaged}`;

    expect(projectMarkdownForUser(source)).toBe("正文");
    expect(findInternalMarkdownMarkerRanges(source)).toEqual([
      expect.objectContaining({ kind: "inline", blockId: damaged }),
    ]);
  });

  it("hides a generated block marker when its leading space was removed", () => {
    const source = `as^${PARAGRAPH_ID}`;

    expect(projectMarkdownForUser(source)).toBe("as");
    expect(findInternalMarkdownMarkerRanges(source)).toEqual([
      expect.objectContaining({ from: 2, kind: "inline", blockId: PARAGRAPH_ID }),
    ]);
  });

  it("returns source offsets for editor decorations", () => {
    const source = `a ^${HEADING_ID}\n^${CODE_ID}\n`;
    expect(findInternalMarkdownMarkerRanges(source).map(({ kind, blockId }) => ({ kind, blockId }))).toEqual([
      { kind: "inline", blockId: HEADING_ID },
      { kind: "line", blockId: CODE_ID },
    ]);
  });

  it("preserves legacy-looking text inside fenced code", () => {
    const source = [
      "```text",
      `^${LEGACY_ID}`,
      "```",
    ].join("\n");
    expect(projectMarkdownForUser(source)).toBe(source);
  });
});

describe("sanitizeMarkdownClipboardText", () => {
  it("removes generated block IDs even after they move into the middle of a line", () => {
    expect(sanitizeMarkdownClipboardText(
      `前半段 ^${PARAGRAPH_ID} 后半段`,
    )).toBe("前半段 后半段");
  });

  it("removes copied line-end and standalone generated markers", () => {
    expect(sanitizeMarkdownClipboardText([
      `标题 ^${HEADING_ID}`,
      `^${PARAGRAPH_ID}`,
      "正文",
    ].join("\n"))).toBe("标题\n\n正文");
  });

  it("removes legacy compact markers from pasted imports", () => {
    expect(sanitizeMarkdownClipboardText([
      `标题 ^${LEGACY_ID}`,
      `^${LEGACY_ID} 前置说明`,
    ].join("\n"))).toBe("标题\n前置说明");
  });

  it("preserves marker-like text in fenced code and ordinary user text", () => {
    const source = [
      "```text",
      `literal ^${CODE_ID}`,
      `^${LEGACY_ID}`,
      "```",
      "普通示例 ^blk_example_text",
    ].join("\n");
    expect(sanitizeMarkdownClipboardText(source)).toBe(source);
  });
});

describe("resolveInternalMarkdownTypingPosition", () => {
  it("keeps continued heading text before a hidden block marker", () => {
    const source = `# Test ^${HEADING_ID}`;
    expect(resolveInternalMarkdownTypingPosition(
      source,
      source.length,
      source.length,
      "T",
    )).toBe(source.indexOf(` ^${HEADING_ID}`));
  });

  it("allows Enter to create a new block after the marker", () => {
    const source = `# Test ^${HEADING_ID}`;
    expect(resolveInternalMarkdownTypingPosition(
      source,
      source.length,
      source.length,
      "\n",
    )).toBeNull();
  });

  it("does not redirect ordinary input or user-authored marker examples", () => {
    const source = "普通示例 ^blk_example_text";
    expect(resolveInternalMarkdownTypingPosition(source, 2, 2, "字")).toBeNull();
    expect(resolveInternalMarkdownTypingPosition(
      source,
      source.length,
      source.length,
      "T",
    )).toBeNull();
  });
});

describe("resolveInternalMarkerSyncSelection", () => {
  it("keeps the cursor before a server-inserted hidden heading marker", () => {
    const current = "# Test";
    const next = `${current} ^${HEADING_ID}`;
    expect(resolveInternalMarkerSyncSelection({
      currentMarkdown: current,
      nextMarkdown: next,
      from: current.length,
      currentTo: current.length,
      nextTo: next.length,
      anchor: current.length,
      head: current.length,
    })).toEqual({ anchor: current.length, head: current.length });
  });

  it("does not override selections away from the normalized block", () => {
    const current = "# Test\n\n正文";
    const next = `# Test ^${HEADING_ID}\n\n正文`;
    expect(resolveInternalMarkerSyncSelection({
      currentMarkdown: current,
      nextMarkdown: next,
      from: "# Test".length,
      currentTo: "# Test".length,
      nextTo: `# Test ^${HEADING_ID}`.length,
      anchor: current.length,
      head: current.length,
    })).toBeNull();
  });
});
