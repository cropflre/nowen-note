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
import { generateJSON, type JSONContent } from "@tiptap/core";
import {
  detectFormat,
  getTiptapExtensions,
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

describe("shared tiptap schema", () => {
  it("preserves h4-h6 when parsing html to tiptap json", () => {
    const json = generateJSON("<h4>Deep</h4><h5>Deeper</h5><h6>Deepest</h6>", getTiptapExtensions()) as any;
    expect(json.content?.map((node: any) => node.type)).toEqual(["heading", "heading", "heading"]);
    expect(json.content?.map((node: any) => node.attrs?.level)).toEqual([4, 5, 6]);
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

  it("GFM 任务项：去掉任务标记，只保留正文", () => {
    expect(markdownToHtml("- [ ] 待补充")).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>待补充</p></li></ul>',
    );
    expect(markdownToHtml("- [x] b")).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>b</p></li></ul>',
    );
  });

  it("GFM 任务项：多项各自保留勾选状态（含大写 X）", () => {
    expect(markdownToHtml("- [ ] a\n- [X] b\n- [ ] c")).toBe(
      '<ul data-type="taskList">' +
        '<li data-type="taskItem" data-checked="false"><p>a</p></li>' +
        '<li data-type="taskItem" data-checked="true"><p>b</p></li>' +
        '<li data-type="taskItem" data-checked="false"><p>c</p></li>' +
        "</ul>",
    );
  });

  it("GFM 任务项：勾选状态只看任务标记，正文里的 [x] 不算勾选", () => {
    const html = markdownToHtml("- [ ] 把 [x] 改掉\n- [ ] 写成 [X] 也一样");
    expect(html.match(/data-checked="\w+"/g)).toEqual(['data-checked="false"', 'data-checked="false"']);
  });

  it("GFM 任务项：嵌套与缩进的任务同样去掉标记", () => {
    expect(markdownToHtml("- [ ] parent\n  - [x] child")).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>parent</p>' +
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>child</p></li></ul>' +
        "</li></ul>",
    );
    expect(markdownToHtml("- parent\n  - [ ] child task")).toBe(
      '<ul><li><p>parent</p><ul data-type="taskList">' +
        '<li data-type="taskItem" data-checked="false"><p>child task</p></li>' +
        "</ul></li></ul>",
    );
    expect(markdownToHtml("   - [x] indented")).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>indented</p></li></ul>',
    );
  });

  it("GFM 任务项：正文的行内格式与链接照常渲染，后续段落不受影响", () => {
    expect(markdownToHtml("- [ ] **粗体** 与 [链接](https://example.com) 和 `code`")).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false">' +
        '<p><strong>粗体</strong> 与 <a href="https://example.com">链接</a> 和 <code>code</code></p>' +
        "</li></ul>",
    );
    expect(markdownToHtml("- [ ] first\n\n  second para")).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false">' +
        "<p>first</p><p>second para</p>" +
        "</li></ul>",
    );
  });

  it("混合列表（只有部分项是任务）：任务标记作为文字保留，行内格式照常渲染", () => {
    expect(markdownToHtml("- 普通项\n- [ ] **粗体** 与 `code`")).toBe(
      "<ul><li><p>普通项</p></li><li><p>[ ] <strong>粗体</strong> 与 <code>code</code></p></li></ul>",
    );
    expect(markdownToHtml("1. 普通项\n2. [x] *斜体*")).toBe(
      "<ol><li><p>普通项</p></li><li><p>[x] <em>斜体</em></p></li></ol>",
    );
  });

  it("没有 URL 的方括号文字原样保留（段落、列表项、任务项）", () => {
    expect(markdownToHtml("见 [备注]")).toBe("<p>见 [备注]</p>");
    expect(markdownToHtml("- 见 [备注]")).toBe("<ul><li><p>见 [备注]</p></li></ul>");
    expect(markdownToHtml("- [ ] 把 [x] 改成 [**重点**]")).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false">' +
        "<p>把 [x] 改成 [<strong>重点</strong>]</p>" +
        "</li></ul>",
    );
  });

  it("裸 URL（GFM 自动链接）渲染为链接，不再从正文里消失", () => {
    expect(markdownToHtml("见 https://example.com/a?b=1 文档")).toBe(
      '<p>见 <a href="https://example.com/a?b=1">https://example.com/a?b=1</a> 文档</p>',
    );
    expect(markdownToHtml("# 标题 https://h.example.com")).toBe(
      '<h1>标题 <a href="https://h.example.com">https://h.example.com</a></h1>',
    );
    expect(markdownToHtml("- [ ] 打开 www.example.com")).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false">' +
        '<p>打开 <a href="http://www.example.com">www.example.com</a></p>' +
        "</li></ul>",
    );
    expect(markdownToHtml("联系 foo@example.com 或 <bar@example.com>")).toBe(
      '<p>联系 <a href="mailto:foo@example.com">foo@example.com</a> 或 <a href="mailto:bar@example.com">bar@example.com</a></p>',
    );
  });

  it("引用式链接：有定义时渲染为链接，没有定义时保留方括号原文", () => {
    const html = markdownToHtml("[文档][ref]、[Ref][]、[REF] 与 [未定义][missing]\n\n[ref]: https://example.com/doc");
    const link = (text: string) => `<a href="https://example.com/doc">${text}</a>`;
    expect(html).toContain(`<p>${link("文档")}、${link("Ref")}、${link("REF")} 与 [未定义][missing]</p>`);
  });

  it("反斜杠转义按字面字符渲染，反斜杠不进入富文本", () => {
    expect(markdownToHtml("见 \\[备注\\] 与 \\*非强调\\* 和 C:\\\\temp")).toBe("<p>见 [备注] 与 *非强调* 和 C:\\temp</p>");
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

  it("Tiptap→MD：保留 H4-H6 标题级别", () => {
    const json = JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "H4" }] },
        { type: "heading", attrs: { level: 5 }, content: [{ type: "text", text: "H5" }] },
        { type: "heading", attrs: { level: 6 }, content: [{ type: "text", text: "H6" }] },
      ],
    });

    const md = tiptapJsonToMarkdown(json);
    expect(md).toMatch(/^#### H4$/m);
    expect(md).toMatch(/^##### H5$/m);
    expect(md).toMatch(/^###### H6$/m);
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

  it("MD → Tiptap JSON：任务项段落文本不含任务标记，行内 mark 保留", () => {
    const json: JSONContent = markdownToTiptapJSON("- [ ] 待补充\n- [x] **完成** 见 [链接](https://example.com)");
    const taskList = json.content?.find((b) => b.type === "taskList");
    const items = taskList?.content ?? [];
    expect(items.map((item) => item.attrs?.checked)).toEqual([false, true]);

    const inlineOf = (item: JSONContent) => item.content?.[0]?.content ?? [];
    const firstInline = inlineOf(items[0]);
    expect(firstInline.map((n) => n.text).join("")).toBe("待补充");

    const secondInline = inlineOf(items[1]);
    expect(secondInline.map((n) => n.text).join("")).toBe("完成 见 链接");
    expect(secondInline[0]).toMatchObject({ text: "完成", marks: [{ type: "bold" }] });
    expect(secondInline[2]).toMatchObject({
      text: "链接",
      marks: [{ type: "link", attrs: { href: "https://example.com" } }],
    });
  });

  it("MD → Tiptap JSON：裸 URL 保留为带 link mark 的文字", () => {
    const json: JSONContent = markdownToTiptapJSON("见 https://example.com 文档");
    const inline = json.content?.[0]?.content ?? [];
    expect(inline.map((n) => n.text).join("")).toBe("见 https://example.com 文档");
    expect(inline[1]).toMatchObject({
      text: "https://example.com",
      marks: [{ type: "link", attrs: { href: "https://example.com" } }],
    });
  });

  it("MD → RTE → MD：任务列表往返稳定，不会逐次累积转义的任务标记", () => {
    const md = "- [ ] 待补充\n- [x] **完成** 见 [链接](https://example.com)";
    const once = tiptapJsonToMarkdown(markdownToTiptapJSON(md));
    expect(once).toBe(md);
    expect(tiptapJsonToMarkdown(markdownToTiptapJSON(once))).toBe(md);
  });

  it("RTE → MD → RTE：含 Markdown 特殊字符的文字往返不累积反斜杠", () => {
    const text = "见 [备注] 与 *星号* 和 snake_case 及 C:\\temp";
    const md = tiptapJsonToMarkdown({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    const back: JSONContent = markdownToTiptapJSON(md);
    expect(back.content?.[0]?.content?.map((n) => n.text).join("")).toBe(text);
    expect(tiptapJsonToMarkdown(back)).toBe(md);

    const once = tiptapJsonToMarkdown(markdownToTiptapJSON("- [ ] 把 [x] 改掉"));
    const onceJson: JSONContent = markdownToTiptapJSON(once);
    const task = onceJson.content?.[0]?.content?.[0];
    expect(task?.attrs?.checked).toBe(false);
    expect(task?.content?.[0]?.content?.map((n) => n.text).join("")).toBe("把 [x] 改掉");
    expect(tiptapJsonToMarkdown(onceJson)).toBe(once);
  });

  it("RTE → MD → RTE：链接文字、链接地址与裸 URL 里的转义同样还原", () => {
    const inlineOf = (json: JSONContent) =>
      (json.content?.[0]?.content ?? []).map((n) => [n.text, n.marks?.[0]?.attrs?.href ?? null]);
    const twice = (inline: JSONContent[]) => {
      const once: JSONContent = markdownToTiptapJSON(
        tiptapJsonToMarkdown({ type: "doc", content: [{ type: "paragraph", content: inline }] }),
      );
      const again: JSONContent = markdownToTiptapJSON(tiptapJsonToMarkdown(once));
      expect(inlineOf(again)).toEqual(inlineOf(once));
      return inlineOf(once);
    };
    const link = (text: string, href: string): JSONContent => ({ type: "text", text, marks: [{ type: "link", attrs: { href } }] });

    expect(twice([link("https://x.com/a_b", "https://x.com/a_b")])).toEqual([["https://x.com/a_b", "https://x.com/a_b"]]);
    expect(twice([link("Foo", "https://en.wikipedia.org/wiki/Foo_(bar)")])).toEqual([
      ["Foo", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ]);
    expect(twice([{ type: "text", text: "见 https://x.com/a_b 文档" }])).toEqual([
      ["见 ", null],
      ["https://x.com/a_b", "https://x.com/a_b"],
      [" 文档", null],
    ]);
  });

  it("Tiptap→MD：嵌套任务列表与任务项的后续段落保持缩进，不被拍平", () => {
    const para = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
    const item = (checked: boolean, content: JSONContent[]): JSONContent => ({ type: "taskItem", attrs: { checked }, content });
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            item(false, [para("parent"), { type: "taskList", content: [item(true, [para("child")])] }]),
            item(false, [para("first"), para("second para")]),
          ],
        },
      ],
    };
    expect(tiptapJsonToMarkdown(doc)).toBe("- [ ] parent\n\n  - [x] child\n- [ ] first\n\n  second para");
  });

  it("MD → RTE → MD：嵌套任务列表往返后仍保持嵌套", () => {
    const once = tiptapJsonToMarkdown(markdownToTiptapJSON("- [ ] parent\n  - [x] child\n- [ ] sibling"));
    expect(once).toBe("- [ ] parent\n\n  - [x] child\n- [ ] sibling");

    const json: JSONContent = markdownToTiptapJSON(once);
    const items = json.content?.[0]?.content ?? [];
    expect(items).toHaveLength(2);
    expect(items[0].content?.[1]).toMatchObject({ type: "taskList", content: [{ attrs: { checked: true } }] });
    expect(tiptapJsonToMarkdown(json)).toBe(once);
  });

  it("Tiptap→MD：文末的空任务项保留标记后的空格，转回后仍是任务项", () => {
    const para = (text?: string): JSONContent => ({ type: "paragraph", content: text ? [{ type: "text", text }] : undefined });
    const item = (checked: boolean, content: JSONContent[]): JSONContent => ({ type: "taskItem", attrs: { checked }, content });

    const flat = tiptapJsonToMarkdown({ type: "doc", content: [{ type: "taskList", content: [item(false, [para("a")]), item(true, [para()])] }] });
    expect(flat).toBe("- [ ] a\n- [x] ");
    const flatBack: JSONContent = markdownToTiptapJSON(flat);
    expect(flatBack.content?.[0]?.type).toBe("taskList");
    expect(flatBack.content?.[0]?.content?.map((node) => node.attrs?.checked)).toEqual([false, true]);

    const nested = tiptapJsonToMarkdown({
      type: "doc",
      content: [{ type: "taskList", content: [item(false, [para("parent"), { type: "taskList", content: [item(false, [para()])] }])] }],
    });
    expect(nested).toBe("- [ ] parent\n\n  - [ ] ");
    const nestedBack: JSONContent = markdownToTiptapJSON(nested);
    expect(nestedBack.content?.[0]?.content?.[0]?.content?.[1]?.type).toBe("taskList");
  });

  it("MD→Tiptap JSON：表格结构正确", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const json = markdownToTiptapJSON(md);
    const table = (json.content || []).find((b: any) => b.type === "table");
    expect(table).toBeTruthy();
    // 至少含表头行 + 数据行
    expect((table.content || []).length).toBeGreaterThanOrEqual(2);
  });

  // ---------------- TextStyle / Color / FontSize 回路 ----------------
  // 这三个 mark 来自 @tiptap/extension-text-style + @tiptap/extension-color
  // + 自写 FontSize 扩展。CommonMark 没有原生语法，需要 Turndown 把
  // <span style="font-size:..;color:.."> 原样保留为 inline HTML，反向再
  // 由 markdownToHtml 透传给 generateJSON 还原为 textStyle mark。

  it("Tiptap→MD：textStyle 字号 + 颜色保留为 <span style>", () => {
    const json = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              marks: [
                {
                  type: "textStyle",
                  attrs: { fontSize: "20px", color: "#ef4444" },
                },
              ],
              text: "BIG RED",
            },
          ],
        },
      ],
    });
    const md = tiptapJsonToMarkdown(json);
    expect(md).toContain("BIG RED");
    expect(md.toLowerCase()).toContain("font-size:20px");
    // 浏览器在 generateHTML 时会把 #ef4444 解析为 rgb(239, 68, 68)，二者等价
    expect(md.toLowerCase().replace(/\s/g, "")).toMatch(
      /color:(#ef4444|rgb\(239,68,68\))/,
    );
  });

  it("MD→Tiptap JSON：<span style> 还原为 textStyle mark", () => {
    const md = `普通 <span style="font-size:24px;color:#3b82f6">大蓝</span> 文字`;
    const json = markdownToTiptapJSON(md);
    // 找到带 textStyle mark 的 text 节点
    const para = (json.content || []).find((b: any) => b.type === "paragraph");
    expect(para).toBeTruthy();
    const styledText = (para.content || []).find((c: any) =>
      c?.marks?.some((m: any) => m.type === "textStyle"),
    );
    expect(styledText).toBeTruthy();
    expect(styledText.text).toContain("大蓝");
    const ts = styledText.marks.find((m: any) => m.type === "textStyle");
    expect(ts.attrs?.fontSize).toBe("24px");
    // color 解析依赖浏览器的 style 解析行为，放宽匹配
    expect(String(ts.attrs?.color).toLowerCase().replace(/\s/g, "")).toMatch(
      /(#3b82f6|rgb\(59,130,246\))/,
    );
  });

  it("markdownToPlainText：剥掉 <span style> 标签但保留文本", () => {
    const md = '前 <span style="color:red">红色</span> 后';
    const text = markdownToPlainText(md);
    expect(text).toContain("红色");
    expect(text).not.toContain("<span");
    expect(text).not.toContain("style=");
  });
});
