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
});
