import { describe, expect, it } from "vitest";
import { splitMarkdownPreview } from "@/lib/markdownPreviewSegments";

describe("splitMarkdownPreview", () => {
  it("preserves source text, offsets and task indices", () => {
    const first = `# First\n\n- [ ] one\n\n${"a".repeat(50_000)}\n\n`;
    const second = `# Second\n\n- [x] two\n\n${"b".repeat(50_000)}\n\n`;
    const third = "# Third\n\n- [ ] three\n";
    const markdown = first + second + third;
    const segments = splitMarkdownPreview(markdown);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.map((segment) => segment.markdown).join("")).toBe(markdown);
    expect(segments[1].start).toBe(segments[0].end);
    expect(segments[1].taskOffset).toBe(1);
  });

  it("does not split inside a fenced code block", () => {
    const fenced = `\`\`\`md\n${"x\n".repeat(40_000)}\`\`\`\n\n`;
    const markdown = `${fenced}# Safe boundary\n\n${"tail\n\n".repeat(10_000)}`;
    const segments = splitMarkdownPreview(markdown);
    expect(segments[0].markdown).toContain("```md");
    expect(segments[0].markdown).toContain("```");
    expect(segments.map((segment) => segment.markdown).join("")).toBe(markdown);
  });

  it.each([
    ["loose nested list", `- parent\n\n  continuation\n\n  - child\n\n${"  nested text\n".repeat(8_000)}\n\n# Tail\n`],
    ["blockquote callout", `> [!NOTE]\n> title\n>\n${"> quoted text\n".repeat(8_000)}\n\n# Tail\n`],
    ["raw html block", `<details>\n<summary>Title</summary>\n${"<p>body</p>\n".repeat(8_000)}</details>\n\n# Tail\n`],
    ["indented code", `${"    const value = 1;\n".repeat(5_000)}\n# Tail\n`],
    ["table", `| A | B |\n|---|---|\n${"| one | two |\n".repeat(6_000)}\n\n# Tail\n`],
    ["math block", `$$\n${"x + y \\\\ z\n".repeat(8_000)}$$\n\n# Tail\n`],
  ])("preserves %s as one syntactic unit", (_name, markdown) => {
    const segments = splitMarkdownPreview(markdown);
    expect(segments.map((segment) => segment.markdown).join("")).toBe(markdown);
    expect(segments[0].markdown).not.toContain("Tail");
  });

  it("keeps link reference definitions and their consumers in the same render root", () => {
    const markdown = `[docs][guide]\n\n${"content\n\n".repeat(10_000)}[guide]: https://example.com\n`;
    expect(splitMarkdownPreview(markdown)).toHaveLength(1);
  });
});
