import { describe, expect, it } from "vitest";
import {
  buildMarkdownPreviewHeadingIndex,
  findMarkdownPreviewHeadingTarget,
  headingDataAttrs,
} from "@/lib/markdownPreviewOutline";

function heading(pos: number): HTMLElement {
  const el = document.createElement("h2");
  el.dataset.mdPos = String(pos);
  return el;
}

describe("markdownPreviewOutline", () => {
  it("builds stable unique Chinese heading ids and ignores fenced pseudo headings", () => {
    const markdown = [
      "# 中文 标题",
      "",
      "```markdown",
      "# 中文 标题",
      "```",
      "",
      "## 中文 标题",
      "",
      "标题二",
      "------",
    ].join("\n");

    expect(buildMarkdownPreviewHeadingIndex(markdown)).toEqual([
      { id: "中文-标题", level: 1, pos: 0 },
      { id: "中文-标题-1", level: 2, pos: markdown.indexOf("## 中文 标题") },
      { id: "标题二", level: 2, pos: markdown.indexOf("标题二") },
    ]);
  });

  it("keeps generated ids globally unique and does not reuse an ATX heading as Setext text", () => {
    const markdown = ["# foo", "", "# foo-1", "", "# foo", "", "# title", "---"].join("\n");

    expect(buildMarkdownPreviewHeadingIndex(markdown).map(({ id }) => id)).toEqual([
      "foo",
      "foo-1",
      "foo-2",
      "title",
    ]);
  });

  it("emits data-md-pos from markdown node offsets", () => {
    expect(headingDataAttrs({ position: { start: { offset: 123 } } })).toEqual({
      "data-md-pos": "123",
    });
  });

  it("attaches the precomputed heading id by global source offset", () => {
    const ids = new Map([[123, "中文-标题"]]);
    expect(headingDataAttrs({ position: { start: { offset: 23 } } }, 100, ids)).toEqual({
      id: "中文-标题",
      "data-md-pos": "123",
    });
  });

  it("does not stringify missing offsets", () => {
    expect(headingDataAttrs({})).toEqual({});
    expect(headingDataAttrs({ position: { start: {} } })).toEqual({});
  });

  it("selects the exact heading target when available", () => {
    const first = heading(10);
    const exact = heading(42);
    const later = heading(80);

    expect(findMarkdownPreviewHeadingTarget([later, exact, first], 42)).toBe(exact);
  });

  it("falls back to the nearest previous heading when exact target is missing", () => {
    const first = heading(10);
    const nearestPrevious = heading(42);
    const later = heading(80);

    expect(findMarkdownPreviewHeadingTarget([later, first, nearestPrevious], 60)).toBe(nearestPrevious);
  });

  it("falls back to the first heading when all headings are after the requested position", () => {
    const first = heading(10);
    const later = heading(80);

    expect(findMarkdownPreviewHeadingTarget([later, first], 5)).toBe(first);
  });
});
