import { describe, expect, it } from "vitest";
import { noteContentToExportHtml } from "@/lib/exportService";

describe("noteContentToExportHtml", () => {
  it("renders native Markdown notes to HTML for image export", () => {
    const markdown = [
      "# 一级标题",
      "",
      "正文段落",
      "",
      "## 二级标题",
      "",
      "- 第一条",
      "- 第二条",
      "",
      "> 引用内容",
      "",
      "```js",
      "console.log(\"hello\");",
      "```",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n");

    const html = noteContentToExportHtml(markdown, "", "markdown");

    expect(html).toContain("<h1>一级标题</h1>");
    expect(html).toContain("<h2>二级标题</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<pre><code");
    expect(html).toContain("<table>");
    expect(html).not.toContain("# 一级标题");
  });
});
