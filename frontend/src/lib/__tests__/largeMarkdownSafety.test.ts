import { describe, expect, it } from "vitest";

import { EDITOR_RUNTIME_THRESHOLDS } from "@/lib/editorRuntimePolicy";
import {
  LARGE_MARKDOWN_OUTLINE_LIMIT,
  LARGE_MARKDOWN_SEARCH_TEXT_LIMIT,
  LARGE_MARKDOWN_THRESHOLDS,
  buildLargeMarkdownSearchText,
  computeSingleTextChange,
  extractLargeMarkdownHeadings,
  shouldUseLargeMarkdownOptimizedMode,
  shouldUseLargeMarkdownSafeMode,
} from "@/lib/largeMarkdownSafety";

describe("large Markdown progressive editor routing", () => {
  it("keeps ordinary notes in the full editor", () => {
    const markdown = "# Title\n\nSmall note.";
    expect(shouldUseLargeMarkdownOptimizedMode(markdown)).toBe(false);
    expect(shouldUseLargeMarkdownSafeMode(markdown)).toBe(false);
  });

  it("routes medium documents to the viewport editor before lightweight mode", () => {
    const line = `${"x".repeat(80)}\n`;
    const markdown = line.repeat(
      Math.ceil(EDITOR_RUNTIME_THRESHOLDS.markdown.viewport.characters / line.length),
    );

    expect(shouldUseLargeMarkdownOptimizedMode(markdown)).toBe(true);
    expect(shouldUseLargeMarkdownSafeMode(markdown)).toBe(false);
  });

  it("detects a lightweight document by total character count", () => {
    const line = `${"x".repeat(80)}\n`;
    const markdown = line.repeat(
      Math.ceil(LARGE_MARKDOWN_THRESHOLDS.characters / line.length),
    );

    expect(shouldUseLargeMarkdownSafeMode(markdown)).toBe(true);
    expect(shouldUseLargeMarkdownOptimizedMode(markdown)).toBe(true);
  });

  it("detects pathological line counts and single-line lengths", () => {
    expect(
      shouldUseLargeMarkdownSafeMode(
        "\n".repeat(LARGE_MARKDOWN_THRESHOLDS.lines - 1),
      ),
    ).toBe(true);
    expect(
      shouldUseLargeMarkdownSafeMode(
        "x".repeat(LARGE_MARKDOWN_THRESHOLDS.longestLine),
      ),
    ).toBe(true);
  });

  it("caps parser-free outline extraction", () => {
    const markdown = Array.from(
      { length: LARGE_MARKDOWN_OUTLINE_LIMIT + 20 },
      (_, index) => `## Heading ${index}`,
    ).join("\n");

    const headings = extractLargeMarkdownHeadings(markdown);
    expect(headings).toHaveLength(LARGE_MARKDOWN_OUTLINE_LIMIT);
    expect(headings[0]).toMatchObject({
      level: 2,
      text: "Heading 0",
      pos: 0,
    });
  });

  it("bounds the search snapshot while preserving both ends", () => {
    const markdown = `START-${"x".repeat(LARGE_MARKDOWN_SEARCH_TEXT_LIMIT)}-END`;
    const searchText = buildLargeMarkdownSearchText(markdown);

    expect(searchText.length).toBeLessThanOrEqual(
      LARGE_MARKDOWN_SEARCH_TEXT_LIMIT + 5,
    );
    expect(searchText.startsWith("START-")).toBe(true);
    expect(searchText.endsWith("-END")).toBe(true);
  });

  it("compacts a local edit to one replacement range", () => {
    expect(computeSingleTextChange("alpha beta", "alpha brave beta")).toEqual({
      from: 6,
      deleteCount: 0,
      insert: "brave ",
    });
    expect(computeSingleTextChange("same", "same")).toBeNull();
  });
});
