/**
 * contentFormat.ts 单元测试（T1）
 *
 * 重点：编辑器切换 (RTE↔MD) 转换链路的正确性回归。
 * 覆盖：
 *   - detectFormat：md / tiptap-json / html / empty 的边界
 *   - normalizeToMarkdown：tiptap-json → md 的可用性 + md 原样 + empty
 *   - markdownToHtml：GFM 任务列表、围栏代码块、表格
 *   - markdownToPlainText：去除常见 MD 标记
 *   - RTE→MD→RTE 回路上关键结构（高亮颜色 / 段落对齐）不丢失
 */
import { describe, expect, it } from "vitest";
import {
  detectFormat,
  markdownToHtml,
  markdownToPlainText,
  markdownToTiptapJSON,
  normalizeToMarkdown,
  tiptapJsonToMarkdown,
} from "@/lib/contentFormat";

describe("detectFormat", () => {
  it("空 / null / 空对象 → empty", () => {
    expect(detectFormat("")).toBe("empty");
    expect(detectFormat(null)).toBe("empty");
    expect(detectFormat(undefined)).toBe("empty");
    expect(detectFormat("{}")).toBe("empty");
    expect(detectFormat("   ")).toBe("empty");
  });

  it("Tiptap doc JSON → tiptap-json", () => {
    const json = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    });
    expect(detectFormat(json)).toBe("tiptap-json");
  });

  it("含 type + content 数组的对象也算 tiptap-json", () => {
    const json = JSON.stringify({
      type: "paragraph",
      content: [{ type: "text", text: "hi" }],
    });
    expect(detectFormat(json)).toBe("tiptap-json");
  });

  it("以 { 开头但非 Tiptap 特征 → md", () => {
    // "{foo: 1}" 不是合法 JSON
    expect(detectFormat("{foo: 1}")).toBe("md");
    // 是合法 JSON 但无 Tiptap 特征
    expect(detectFormat('{"a":1}')).toBe("md");
  });

  it("以 < 开头且像 HTML → html", () => {
    expect(detectFormat("<p>hi</p>")).toBe("html");
    expect(detectFormat("<div><span>x</span></div>")).toBe("html");
  });

  it("以 < 开头但非 HTML → md", () => {
    expect(detectFormat("<3 i love md")).toBe("md");
    expect(detectFormat("<= 5 items")).toBe("md");
  });

  it("普通文本 → md", () => {
    expect(detectFormat("# Heading\n\nSome *text*")).toBe("md");
    expect(detectFormat("just text")).toBe("md");
  });
});

describe("normalizeToMarkdown", () => {
  it("md 原样返回", () => {
    const md = "# Title\n\n- item1\n- item2";
    expect(normalizeToMarkdown(md)).toBe(md);
  });

  it("empty → 空串", () => {
    expect(normalizeToMarkdown("")).toBe("");
    expect(normalizeToMarkdown(null)).toBe("");
    expect(normalizeToMarkdown("{}")).toBe("");
  });

  it("tiptap-json → markdown（含标题 / 加粗）", () => {
    const json = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Hello" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "this is " },
            {
              type: "text",
              marks: [{ type: "bold" }],
              text: "bold",
            },
          ],
        },
      ],
    });
    const md = normalizeToMarkdown(json);
    expect(md).toContain("# Hello");
    expect(md).toContain("**bold**");
  });
});

describe("markdownToHtml", () => {
  it("ATX 标题", () => {
    expect(markdownToHtml("# H1\n\n## H2")).toContain("<h1>H1</h1>");
    expect(markdownToHtml("# H1\n\n## H2")).toContain("<h2>H2</h2>");
  });

  it("加粗 / 斜体 / 删除线", () => {
    const html = markdownToHtml("**bold** *em* ~~del~~");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<s>del</s>");
  });

  it("GFM 任务列表", () => {
    const md = "- [x] done\n- [ ] todo";
    const html = markdownToHtml(md);
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-type="taskItem"');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('data-checked="false"');
  });

  it("围栏代码块带 language", () => {
    const md = "```js\nconst x = 1;\n```";
    const html = markdownToHtml(md);
    expect(html).toContain('<pre><code class="language-js">');
    expect(html).toContain("const x = 1;");
  });

  it("GFM 表格", () => {
    const md = [
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "| 3 | 4 |",
    ].join("\n");
    const html = markdownToHtml(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<th>B</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>4</td>");
  });

  it("空字符串 → 空串", () => {
    expect(markdownToHtml("")).toBe("");
  });

  it("带对齐 style 的 HTML 块原样透传（支撑 Turndown 对齐规则的闭环）", () => {
    const md = '<p style="text-align:center">centered</p>';
    const html = markdownToHtml(md);
    expect(html).toContain('style="text-align:center"');
    expect(html).toContain("centered");
  });
});

describe("markdownToPlainText", () => {
  it("去掉标题 / 加粗 / 列表标记", () => {
    expect(markdownToPlainText("# Title")).toBe("Title");
    expect(markdownToPlainText("**bold** text")).toBe("bold text");
    expect(markdownToPlainText("- item1\n- item2")).toContain("item1");
    expect(markdownToPlainText("- item1\n- item2")).toContain("item2");
  });

  it("去掉代码围栏 + 行内代码", () => {
    expect(markdownToPlainText("```\nfoo\n```")).toBe("");
    expect(markdownToPlainText("use `npm` to install")).toBe(
      "use npm to install",
    );
  });

  it("链接只保留文本", () => {
    expect(markdownToPlainText("See [docs](https://x.com)")).toBe("See docs");
  });

  it("图片只保留 alt", () => {
    expect(markdownToPlainText("![banner](x.png) after")).toBe("banner after");
  });
});

describe("RTE ↔ MD 回路（关键结构保留）", () => {
  it("高亮颜色在 Tiptap→MD 时以 <mark> 形式保留", () => {
    const json = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              marks: [{ type: "highlight", attrs: { color: "#ffd700" } }],
              text: "yellow",
            },
          ],
        },
      ],
    });
    const md = tiptapJsonToMarkdown(json);
    expect(md).toContain("<mark");
    expect(md.toLowerCase()).toContain("ffd700");
  });

  it("段落对齐在 Tiptap→MD 时保留为 HTML 块", () => {
    const json = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { textAlign: "center" },
          content: [{ type: "text", text: "hi" }],
        },
      ],
    });
    const md = tiptapJsonToMarkdown(json);
    // 预期形如 <p style="text-align:center">hi</p>
    expect(md).toMatch(/<p[^>]*text-align:\s*center/i);
    expect(md).toContain("hi");
  });

  it("MD → Tiptap JSON：标题 / 任务列表结构正确", () => {
    const md = "# Title\n\n- [x] done\n- [ ] todo";
    const json = markdownToTiptapJSON(md);
    expect(json).toBeTruthy();
    expect(json.type).toBe("doc");
    const blocks = (json.content || []) as any[];
    const heading = blocks.find((b) => b.type === "heading");
    expect(heading).toBeTruthy();
    expect(heading.attrs?.level).toBe(1);
    const taskList = blocks.find((b) => b.type === "taskList");
    expect(taskList).toBeTruthy();
    const items = (taskList.content || []) as any[];
    expect(items.length).toBe(2);
    expect(items[0].attrs?.checked).toBe(true);
    expect(items[1].attrs?.checked).toBe(false);
  });

  it("MD→Tiptap JSON：表格结构正确", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const json = markdownToTiptapJSON(md);
    const table = (json.content || []).find((b: any) => b.type === "table");
    expect(table).toBeTruthy();
    // 至少含表头行 + 数据行
    expect((table.content || []).length).toBeGreaterThanOrEqual(2);
  });
});
