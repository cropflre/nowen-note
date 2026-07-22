import { describe, expect, it } from "vitest";

import {
  analyzeMarkdown,
  MARKDOWN_ANALYSIS_OUTLINE_LIMIT,
} from "@/lib/markdownAnalysis";

describe("Markdown background analysis", () => {
  it("extracts headings, plain text and mixed-language word statistics", () => {
    const result = analyzeMarkdown([
      "# Project Plan",
      "",
      "中文 [documentation](https://example.com) and ![diagram](image.png).",
      "",
      "Second section",
      "--------------",
      "",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n"));

    expect(result.headings).toEqual([
      expect.objectContaining({ level: 1, text: "Project Plan", pos: 0 }),
      expect.objectContaining({ level: 2, text: "Second section" }),
    ]);
    expect(result.plainText).toContain("中文 documentation and diagram.");
    expect(result.plainText).toContain("const value = 1;");
    expect(result.plainText).not.toContain("```ts");
    expect(result.stats.words).toBeGreaterThan(8);
    expect(result.stats.charsNoSpace).toBeLessThanOrEqual(result.stats.chars);
  });

  it("caps generated outlines and bounds the search payload", () => {
    const markdown = Array.from(
      { length: MARKDOWN_ANALYSIS_OUTLINE_LIMIT + 25 },
      (_, index) => `## Heading ${index}\n${"x".repeat(20)}`,
    ).join("\n");

    const result = analyzeMarkdown(markdown, {
      outlineLimit: 12,
      searchTextLimit: 200,
    });

    expect(result.headings).toHaveLength(12);
    expect(result.plainText.length).toBeLessThanOrEqual(205);
    expect(result.plainText).toContain("…");
  });

  it("does not include zero-width editor markers in the search text", () => {
    const result = analyzeMarkdown("alpha\u200Bbeta\uFEFFgamma");
    expect(result.plainText).toBe("alphabetagamma");
  });
});
