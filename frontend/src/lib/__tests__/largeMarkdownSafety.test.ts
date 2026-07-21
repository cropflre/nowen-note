import { describe, expect, it } from "vitest";

import {
  LARGE_MARKDOWN_OUTLINE_LIMIT,
  LARGE_MARKDOWN_SEARCH_TEXT_LIMIT,
  LARGE_MARKDOWN_THRESHOLDS,
  buildLargeMarkdownSearchText,
  computeSingleTextChange,
  extractLargeMarkdownHeadings,
  shouldUseLargeMarkdownSafeMode,
} from "@/lib/largeMarkdownSafety";

describe("large Markdown safe mode", () => {
  it("keeps ordinary notes in the full editor", () => {
    expect(shouldUseLargeMarkdownSafeMode("# Title\n\nSmall note.")).toBe(false);
  });

  it("detects a document by total character count without additional parsing", () => {
    expect(
      shouldUseLargeMarkdownSafeMode(
        "x".repeat(LARGE_MARKDOWN_THRESHOLDS.characters),
      ),
    ).toBe(true);
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
