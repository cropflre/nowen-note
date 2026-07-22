import { describe, expect, it } from "vitest";

import {
  buildMarkdownSplitPreview,
  findPreferredMarkdownSplitLevel,
} from "@/lib/noteSplit";

describe("Markdown note split preview", () => {
  it("prefers H1 when two H1 headings are available", () => {
    expect(findPreferredMarkdownSplitLevel("# One\nbody\n# Two\nbody")).toBe(1);
  });

  it("falls back to H2 and preserves higher-level preamble", () => {
    const markdown = "# Book\nintro\n## A\na\n## B\nb";
    expect(findPreferredMarkdownSplitLevel(markdown)).toBe(2);
    const preview = buildMarkdownSplitPreview(markdown, 2);
    expect(preview.preamble).toBe("# Book\nintro");
    expect(preview.sections.map((section) => section.title)).toEqual(["A", "B"]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const markdown = "# One\n```md\n# Fake\n```\n# Two";
    const preview = buildMarkdownSplitPreview(markdown, 1);
    expect(preview.sections).toHaveLength(2);
    expect(preview.sections[0].content).toContain("# Fake");
  });

  it("keeps deeper headings inside a parent section", () => {
    const markdown = "# One\n## Nested\nbody\n# Two\nend";
    const preview = buildMarkdownSplitPreview(markdown, 1);
    expect(preview.sections[0].content).toContain("## Nested");
    expect(preview.sections[1].content).toBe("end");
  });

  it("strips persisted runtime block ids from chapter titles", () => {
    const markdown = [
      "# Alpha ^blk_12345678",
      "body",
      "# Beta ^blk_abcdefgh",
      "body",
    ].join("\n");
    expect(buildMarkdownSplitPreview(markdown, 1).sections.map((section) => section.title))
      .toEqual(["Alpha", "Beta"]);
  });

  it("returns null when there are not enough peer headings", () => {
    expect(findPreferredMarkdownSplitLevel("# Only\nbody")).toBeNull();
  });
});
