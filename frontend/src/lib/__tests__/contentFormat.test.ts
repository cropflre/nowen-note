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

// 编辑器给每个 taskItem / listItem / paragraph 等块分配 blockId，MD 笔记保存后后端也会给每块补上 ^blk_ 标记，
// 所以真实笔记的转换都走带 blockId 的路径。
describe("带 blockId 的 RTE ↔ MD 往返", () => {
  type Outline = { type?: string; checked?: boolean; blockId?: string; text?: string; content?: Outline[] };
  const outline = (node: JSONContent): Outline => ({
    type: node.type,
    ...(node.type === "taskItem" ? { checked: Boolean(node.attrs?.checked) } : {}),
    ...(node.attrs?.blockId ? { blockId: String(node.attrs.blockId) } : {}),
    ...(node.text ? { text: node.text } : {}),
    ...(node.content?.length ? { content: node.content.map(outline) } : {}),
  });
  const textOf = (node: JSONContent): string => [node.text ?? "", ...(node.content ?? []).map(textOf)].join("\n");
  const para = (blockId: string | null, text?: string): JSONContent => ({
    type: "paragraph",
    ...(blockId ? { attrs: { blockId } } : {}),
    ...(text ? { content: [{ type: "text", text }] } : {}),
  });
  const taskItem = (blockId: string, checked: boolean, content: JSONContent[]): JSONContent => ({ type: "taskItem", attrs: { blockId, checked }, content });
  const listItem = (blockId: string, content: JSONContent[]): JSONContent => ({ type: "listItem", attrs: { blockId }, content });

  // 列表项首段与列表项共用一行，一行只写一个标记：写列表项的 ID，首段自己的 ID 不写出，
  // 转回富文本后首段没有 ID（编辑器会重新分配）。下面用 leadIds=false 构造往返后的预期。
  it("嵌套任务列表与文末空任务项：任务项 ID 写在各自行尾，往返后嵌套、勾选与 ID 不变，正文不出现标记", () => {
    const doc = (leadIds: boolean): JSONContent => ({
      type: "doc",
      content: [{
        type: "taskList",
        content: [
          taskItem("blk_item01", false, [
            para(leadIds ? "blk_para01" : null, "parent"),
            { type: "taskList", content: [taskItem("blk_item02", true, [para(leadIds ? "blk_para02" : null, "child")])] },
          ]),
          taskItem("blk_item03", false, [para(leadIds ? "blk_para03" : null)]),
        ],
      }],
    });
    const md = tiptapJsonToMarkdown(doc(true));
    expect(md).toBe("- [ ] parent ^blk_item01\n\n  - [x] child ^blk_item02\n- [ ]  ^blk_item03");

    const back: JSONContent = markdownToTiptapJSON(md);
    expect(outline(back)).toEqual(outline(doc(false)));
    expect(textOf(back)).not.toMatch(/\^blk_|NOWENBLOCKIDTOKEN/);
    expect(tiptapJsonToMarkdown(back)).toBe(md);
  });

  it("多段任务项：后续段落缩进并保留自己的 ID，列表后的段落不被并进任务项", () => {
    const doc = (leadIds: boolean): JSONContent => ({
      type: "doc",
      content: [
        { type: "taskList", content: [taskItem("blk_item01", true, [para(leadIds ? "blk_para01" : null, "first"), para("blk_para02", "second")])] },
        para("blk_para09", "after"),
      ],
    });
    const md = tiptapJsonToMarkdown(doc(true));
    expect(md).toBe("- [x] first ^blk_item01\n\n  second ^blk_para02\n\nafter ^blk_para09");

    const back: JSONContent = markdownToTiptapJSON(md);
    expect(outline(back)).toEqual(outline(doc(false)));
    expect(textOf(back)).not.toMatch(/\^blk_|NOWENBLOCKIDTOKEN/);
    expect(tiptapJsonToMarkdown(back)).toBe(md);
  });

  it("普通列表项（无序、有序、嵌套、多段）同样把 ID 写在列表项所在行，往返后结构与 ID 不变", () => {
    const doc = (leadIds: boolean): JSONContent => ({
      type: "doc",
      content: [{
        type: "bulletList",
        content: [
          listItem("blk_li0001", [
            para(leadIds ? "blk_lp0001" : null, "one"),
            { type: "orderedList", content: [listItem("blk_li0002", [para(leadIds ? "blk_lp0002" : null, "two"), para("blk_lp0003", "two-b")])] },
          ]),
          listItem("blk_li0004", [para(leadIds ? "blk_lp0004" : null, "three")]),
        ],
      }],
    });
    const md = tiptapJsonToMarkdown(doc(true));
    expect(md).toBe("- one ^blk_li0001\n  1. two ^blk_li0002\n\n     two-b ^blk_lp0003\n- three ^blk_li0004");

    const back: JSONContent = markdownToTiptapJSON(md);
    expect(outline(back)).toEqual(outline(doc(false)));
    expect(textOf(back)).not.toMatch(/\^blk_|NOWENBLOCKIDTOKEN/);
    expect(tiptapJsonToMarkdown(back)).toBe(md);
  });

  it("有序列表：按起始编号顺排并随标记宽度缩进续段，往返后起始编号、续段与 ID 不变", () => {
    const list = (leadIds: boolean): JSONContent => ({
      type: "doc",
      content: [{
        type: "orderedList",
        attrs: { start: 9 },
        content: [
          listItem("blk_item01", [para(leadIds ? "blk_para01" : null, "a")]),
          // 「10. 」的内容列是 4，续段缩进 3 格就会脱离该项
          listItem("blk_item02", [para(leadIds ? "blk_para02" : null, "b"), para("blk_para03", "b2")]),
          listItem("blk_item03", [para(leadIds ? "blk_para04" : null, "c")]),
        ],
      }],
    });
    const md = tiptapJsonToMarkdown(list(true));
    expect(md).toBe(["9. a ^blk_item01", "10. b ^blk_item02", "", "    b2 ^blk_para03", "11. c ^blk_item03"].join("\n"));

    const back: JSONContent = markdownToTiptapJSON(md);
    expect(back.content?.[0]).toMatchObject({ type: "orderedList", attrs: { start: 9 } });
    expect(outline(back)).toEqual(outline(list(false)));
    expect(textOf(back)).not.toMatch(/\^blk_|NOWENBLOCKIDTOKEN/);
    expect(tiptapJsonToMarkdown(back)).toBe(md);

    // 没有起始编号的列表从 1 顺排，与不带 ID 的列表一致
    const plain: JSONContent = { type: "doc", content: [{ type: "orderedList", content: [listItem("blk_item04", [para(null, "x")]), listItem("blk_item05", [para(null, "y")])] }] };
    expect(tiptapJsonToMarkdown(plain)).toBe("1. x ^blk_item04\n2. y ^blk_item05");
  });

  it("有序列表：起始编号不是 1 的嵌套列表与上一段之间要有空行，否则被当成上一段的续行而丢掉列表", () => {
    const doc = (withIds: boolean): JSONContent => ({
      type: "doc",
      content: [{
        type: "bulletList",
        content: [{
          type: "listItem",
          ...(withIds ? { attrs: { blockId: "blk_item01" } } : {}),
          content: [
            para(null, "x"),
            { type: "orderedList", attrs: { start: 4 }, content: [{ type: "listItem", ...(withIds ? { attrs: { blockId: "blk_item02" } } : {}), content: [para(null, "y")] }] },
          ],
        }],
      }],
    });
    const md = tiptapJsonToMarkdown(doc(true));
    expect(md).toBe("- x ^blk_item01\n\n  4. y ^blk_item02");
    for (const source of [md, tiptapJsonToMarkdown(doc(false))]) {
      const back: JSONContent = markdownToTiptapJSON(source);
      expect(back.content?.[0]?.content?.[0]?.content?.[1]).toMatchObject({ type: "orderedList", attrs: { start: 4 } });
      expect(textOf(back)).not.toMatch(/\^blk_|NOWENBLOCKIDTOKEN/);
      expect(tiptapJsonToMarkdown(back)).toBe(source);
    }
  });

  it("引用块：末段与引用块共用最后一行，只写引用块的 ID；往返后各段 ID 归位、正文无标记、输出稳定", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "blockquote", attrs: { blockId: "blk_quot01" }, content: [para("blk_para01", "q1"), para("blk_para02", "q2")] }],
    };
    const md = tiptapJsonToMarkdown(doc);
    // 非末段保留自己的 ID；末段自己的不写出，转回后由编辑器重新分配
    expect(md).toBe(["> q1 ^blk_para01", "> ", "> q2 ^blk_quot01"].join("\n"));

    const back: JSONContent = markdownToTiptapJSON(md);
    expect(outline(back)).toEqual({
      type: "doc",
      content: [{
        type: "blockquote",
        blockId: "blk_quot01",
        content: [
          { type: "paragraph", blockId: "blk_para01", content: [{ type: "text", text: "q1" }] },
          { type: "paragraph", content: [{ type: "text", text: "q2" }] },
        ],
      }],
    });
    expect(textOf(back)).not.toMatch(/\^blk_|NOWENBLOCKIDTOKEN/);
    expect(tiptapJsonToMarkdown(back)).toBe(md);

    const solo: JSONContent = { type: "doc", content: [{ type: "blockquote", attrs: { blockId: "blk_quot02" }, content: [para("blk_para03", "solo")] }] };
    expect(tiptapJsonToMarkdown(solo)).toBe("> solo ^blk_quot02");
  });

  it("引用块末块是列表、标题或代码块：末块自己的标记占着最后一行，引用块的 ID 不写出；往返后无可见标记、输出稳定", () => {
    const text = (value: string): Outline[] => [{ type: "text", text: value }];
    const cases: Array<{ last: JSONContent; md: string[]; lastOutline: Outline }> = [
      {
        last: { type: "bulletList", content: [listItem("blk_item01", [para("blk_para02", "item")])] },
        md: ["> intro ^blk_para01", "> ", "> - item ^blk_item01"],
        lastOutline: { type: "bulletList", content: [{ type: "listItem", blockId: "blk_item01", content: [{ type: "paragraph", content: text("item") }] }] },
      },
      {
        last: { type: "heading", attrs: { level: 2, blockId: "blk_head01" }, content: [{ type: "text", text: "h" }] },
        md: ["> intro ^blk_para01", "> ", "> ## h ^blk_head01"],
        lastOutline: { type: "heading", blockId: "blk_head01", content: text("h") },
      },
      {
        last: { type: "codeBlock", attrs: { language: "js", blockId: "blk_code01" }, content: [{ type: "text", text: "x()" }] },
        md: ["> intro ^blk_para01", "> ", "> ```js", "> x()", "> ```", "> ^blk_code01"],
        lastOutline: { type: "codeBlock", blockId: "blk_code01", content: text("x()") },
      },
    ];
    for (const { last, md: expected, lastOutline } of cases) {
      const doc: JSONContent = {
        type: "doc",
        content: [{ type: "blockquote", attrs: { blockId: "blk_quot01" }, content: [para("blk_para01", "intro"), last] }],
      };
      const md = tiptapJsonToMarkdown(doc);
      expect(md).toBe(expected.join("\n"));

      const back: JSONContent = markdownToTiptapJSON(md);
      // 末块的 ID 归末块；引用块的 ID 不写出，转回后由编辑器重新分配
      expect(outline(back)).toEqual({
        type: "doc",
        content: [{ type: "blockquote", content: [{ type: "paragraph", blockId: "blk_para01", content: text("intro") }, lastOutline] }],
      });
      expect(textOf(back)).not.toMatch(/\^blk_|NOWENBLOCKIDTOKEN/);
      expect(tiptapJsonToMarkdown(back)).toBe(md);
    }
  });

  it("MD→RTE：标题、段落、引用、代码块的 ID 各归原节点，块间空行不被吞，代码块后的正文不进代码", () => {
    const md = [
      "## Title ^blk_head01", "", "alpha ^blk_para01", "", "beta ^blk_para02", "", "> quoted ^blk_quot01", "",
      "```ts", "const a = 1;", "```", "^blk_code01", "", "tail ^blk_para03",
    ].join("\n");
    const text = (value: string): Outline[] => [{ type: "text", text: value }];
    expect(outline(markdownToTiptapJSON(md))).toEqual({
      type: "doc",
      content: [
        { type: "heading", blockId: "blk_head01", content: text("Title") },
        { type: "paragraph", blockId: "blk_para01", content: text("alpha") },
        { type: "paragraph", blockId: "blk_para02", content: text("beta") },
        { type: "blockquote", blockId: "blk_quot01", content: [{ type: "paragraph", content: text("quoted") }] },
        { type: "codeBlock", blockId: "blk_code01", content: text("const a = 1;") },
        { type: "paragraph", blockId: "blk_para03", content: text("tail") },
      ],
    });
  });

  it("MD→RTE：代码块里形如块标记的文字是代码内容，原样保留", () => {
    const md = "```md\n- [ ] 示例 ^blk_sample01\n```\n^blk_code01";
    expect(outline(markdownToTiptapJSON(md))).toEqual({
      type: "doc",
      content: [{ type: "codeBlock", blockId: "blk_code01", content: [{ type: "text", text: "- [ ] 示例 ^blk_sample01" }] }],
    });
  });
});

describe("表格 RTE ↔ MD", () => {
  const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
  const para = (...content: JSONContent[]): JSONContent => (content.length ? { type: "paragraph", content } : { type: "paragraph" });
  const th = (content: JSONContent[], attrs?: JSONContent["attrs"]): JSONContent => ({ type: "tableHeader", ...(attrs ? { attrs } : {}), content });
  const td = (content: JSONContent[], attrs?: JSONContent["attrs"]): JSONContent => ({ type: "tableCell", ...(attrs ? { attrs } : {}), content });
  const tableDoc = (...rows: JSONContent[][]): JSONContent => ({
    type: "doc",
    content: [{ type: "table", content: rows.map((cells) => ({ type: "tableRow", content: cells })) }],
  });
  const tableOf = (json: JSONContent) => json.content?.find((node) => node.type === "table");
  // 每个单元格摘要为「th/td:文字」，段落之间记为 ¶，硬换行记为 ⏎
  const cellText = (cell: JSONContent) =>
    (cell.content ?? []).map((block) => (block.content ?? []).map((n) => (n.type === "hardBreak" ? "⏎" : n.text ?? "")).join("")).join("¶");
  const grid = (json: JSONContent) =>
    tableOf(json)?.content?.map((row) => row.content?.map((cell) => `${cell.type === "tableHeader" ? "th" : "td"}:${cellText(cell)}`));
  // RTE → MD → RTE，并要求第二次转成 MD 与第一次完全一致
  const roundTrip = (doc: JSONContent) => {
    const md = tiptapJsonToMarkdown(doc);
    const back: JSONContent = markdownToTiptapJSON(md);
    expect(tiptapJsonToMarkdown(back)).toBe(md);
    return { md, back };
  };

  it("普通表格输出为 GFM 管道表格，往返后结构与内容一致", () => {
    const doc = tableDoc(
      [th([para(text("A"))]), th([para(text("B"))])],
      [td([para(text("1"))]), td([para(text("2"))])],
      [td([para(text("3"))]), td([para(text("4"))])],
    );
    const { md, back } = roundTrip(doc);
    expect(md).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
    expect(grid(back)).toEqual(grid(doc));
  });

  it("没有表头行的表格把首行输出为表头行：不多出空行，转回后首行成为表头", () => {
    const doc = tableDoc(
      [td([para(text("1"))]), td([para(text("2"))])],
      [td([para(text("3"))]), td([para(text("4"))])],
    );
    const { md, back } = roundTrip(doc);
    expect(md).toBe("| 1 | 2 |\n| --- | --- |\n| 3 | 4 |");
    expect(grid(back)).toEqual([["th:1", "th:2"], ["td:3", "td:4"]]);
  });

  it("单元格里的 | 转义为 \\|，粗体、链接、行内代码往返不变", () => {
    const doc = tableDoc(
      [th([para(text("文字"))]), th([para(text("格式"))]), th([para(text("代码"))])],
      [
        td([para(text("a|b"))]),
        td([para(text("加粗", [{ type: "bold" }]), text(" 与 "), text("链接", [{ type: "link", attrs: { href: "https://example.com/?q=a|b" } }]))]),
        td([para(text("ls | wc", [{ type: "code" }]))]),
      ],
    );
    const { md, back } = roundTrip(doc);
    expect(md.split("\n")[2]).toBe("| a\\|b | **加粗** 与 [链接](https://example.com/?q=a\\|b) | `ls \\| wc` |");
    const inline = (json: JSONContent) =>
      tableOf(json)?.content?.[1]?.content?.map((cell) =>
        (cell.content?.[0]?.content ?? []).map((n) => [n.text, n.marks?.map((m) => m.type) ?? [], n.marks?.[0]?.attrs?.href ?? null]),
      );
    expect(inline(back)).toEqual(inline(doc));
  });

  it("内部链接 [[…|别名]] 里的 | 不转义：解析表格前已被预处理，不会拆开单元格", () => {
    const href = "note:00000000-0000-4000-8000-000000000001";
    const md = normalizeToMarkdown(
      `<table><tbody><tr><th><p>笔记</p></th><th><p>说明</p></th></tr>` +
        `<tr><td><p><a href="${href}" rel="nowen-title-alias">别名</a></p></td><td><p>x</p></td></tr></tbody></table>`,
    );
    expect(md).toBe(`| 笔记 | 说明 |\n| --- | --- |\n| [[${href}|别名]] | x |`);
    expect(markdownToHtml(md)).toMatch(/<tr><td><a href="note:[^"]+"[^>]*>别名<\/a><\/td><td>x<\/td><\/tr>/);
  });

  it("单元格里的多个段落与硬换行用 <br> 连接，每个单元格只占一行", () => {
    const doc = tableDoc(
      [th([para(text("段落"))]), th([para(text("换行"))])],
      [td([para(text("one")), para(), para(text("two"))]), td([para(text("a"), { type: "hardBreak" }, text("b"))])],
    );
    const { md, back } = roundTrip(doc);
    expect(md).toBe("| 段落 | 换行 |\n| --- | --- |\n| one<br><br>two | a<br>b |");
    // GFM 单元格只能放行内内容：转回后多个段落合并为一个带硬换行的段落，文字与换行位置不变
    expect(grid(back)).toEqual([["th:段落", "th:换行"], ["td:one⏎⏎two", "td:a⏎b"]]);
  });

  it("空单元格不会让后面的单元格错列", () => {
    const fromMd: JSONContent = markdownToTiptapJSON("| A | B | C |\n| --- | --- | --- |\n|  | 2 |  |");
    expect(grid(fromMd)).toEqual([["th:A", "th:B", "th:C"], ["td:", "td:2", "td:"]]);

    const doc = tableDoc([th([para(text("A"))]), th([para()]), th([para(text("C"))])], [td([para()]), td([para(text("2"))]), td([para()])]);
    const { md, back } = roundTrip(doc);
    expect(md).toBe("| A |  | C |\n| --- | --- | --- |\n|  | 2 |  |");
    expect(grid(back)).toEqual(grid(doc));
  });

  it("单元格对齐属性与 GFM 列对齐互转；同一列对齐不一致时不输出对齐标记", () => {
    const md = "| L | C | R | N |\n| :--- | :---: | ---: | --- |\n| 1 | 2 | 3 | 4 |";
    const json: JSONContent = markdownToTiptapJSON(md);
    expect(tableOf(json)?.content?.map((row) => row.content?.map((cell) => cell.attrs?.align ?? null))).toEqual([
      ["left", "center", "right", null],
      ["left", "center", "right", null],
    ]);
    expect(tiptapJsonToMarkdown(json)).toBe(md);

    const mixed = tableDoc([th([para(text("H"))], { align: "center" })], [td([para(text("1"))])]);
    expect(tiptapJsonToMarkdown(mixed)).toBe("| H |\n| --- |\n| 1 |");
  });

  it("合并单元格保留为 HTML 表格，往返后合并与内容不丢", () => {
    const doc = tableDoc(
      [th([para(text("合并"))], { colspan: 2 })],
      [td([para(text("1"))]), td([para(text("2"))])],
    );
    const { md, back } = roundTrip(doc);
    expect(md.startsWith("<table")).toBe(true);
    expect(md).toContain('colspan="2"');
    expect(tableOf(back)?.content?.[0]?.content?.[0]?.attrs?.colspan).toBe(2);
    expect(grid(back)).toEqual(grid(doc));
  });

  it("单元格里有段落以外的块，或行内代码含 \\| 时保留为单行 HTML 表格，内容不丢", () => {
    const item = (value: string): JSONContent => ({ type: "listItem", content: [para(text(value))] });
    const blocks = tableDoc(
      [th([para(text("列表"))]), th([para(text("代码"))])],
      [td([{ type: "bulletList", content: [item("x"), item("y")] }]), td([{ type: "codeBlock", content: [text("a\n\nb")] }])],
    );
    const { md, back } = roundTrip(blocks);
    // 整个表格在一行里：HTML 块遇到空行就会结束，代码里的空行不能原样写出
    expect(md.startsWith("<table")).toBe(true);
    expect(md).not.toContain("\n");
    const [listCell, codeCell] = tableOf(back)?.content?.[1]?.content ?? [];
    expect(listCell?.content?.[0]?.type).toBe("bulletList");
    expect(listCell?.content?.[0]?.content).toHaveLength(2);
    expect(codeCell?.content?.[0]).toMatchObject({ type: "codeBlock", content: [{ text: "a\n\nb" }] });

    const regex = tableDoc([th([para(text("正则"))])], [td([para(text("a\\|b", [{ type: "code" }]))])]);
    const { md: regexMd, back: regexBack } = roundTrip(regex);
    expect(regexMd.startsWith("<table")).toBe(true);
    expect(tableOf(regexBack)?.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("a\\|b");
  });

  // 编辑器里的表格和每个单元格段落都带 blockId。一行只能带一个标记，表格各行又是同一个块（后端 Markdown 块模型），
  // 所以表格 ID 写在最后一行行尾，单元格段落的 ID 不写出，转回后由编辑器重新分配。
  describe("带 blockId 的表格", () => {
    const idPara = (blockId: string, value: string): JSONContent => ({ type: "paragraph", attrs: { blockId }, ...(value ? { content: [text(value)] } : {}) });
    const withId = (doc: JSONContent, blockId: string): JSONContent => ({
      ...doc,
      content: doc.content?.map((node) => (node.type === "table" ? { ...node, attrs: { blockId } } : node)),
    });
    const noMarkerText = (json: JSONContent) => expect(JSON.stringify(json)).not.toMatch(/\^blk_|NOWENBLOCKIDTOKEN/);

    it("管道表格：表格 ID 写在最后一行行尾，往返后 ID 归表格，单元格不多不少", () => {
      const table = withId(
        tableDoc([th([idPara("blk_cell01", "A")]), th([idPara("blk_cell02", "B")])], [td([idPara("blk_cell03", "1")]), td([idPara("blk_cell04", "")])]),
        "blk_table01",
      );
      const doc: JSONContent = { ...table, content: [...(table.content ?? []), idPara("blk_para09", "after")] };
      const md = tiptapJsonToMarkdown(doc);
      expect(md).toBe("| A | B |\n| --- | --- |\n| 1 |  | ^blk_table01\n\nafter ^blk_para09");

      const back: JSONContent = markdownToTiptapJSON(md);
      expect(tableOf(back)?.attrs?.blockId).toBe("blk_table01");
      expect(grid(back)).toEqual([["th:A", "th:B"], ["td:1", "td:"]]);
      expect(back.content?.[1]).toMatchObject({ type: "paragraph", attrs: { blockId: "blk_para09" } });
      expect(JSON.stringify(back)).not.toContain("blk_cell");
      noMarkerText(back);
      expect(tiptapJsonToMarkdown(back)).toBe(md);
    });

    it("表格是带 ID 的引用块的最后一个块时，最后一行行尾的标记属于引用块（同引用块最后一段）", () => {
      const table = tableOf(withId(tableDoc([th([idPara("blk_cell01", "A")])], [td([idPara("blk_cell02", "1")])]), "blk_table04"));
      const doc: JSONContent = { type: "doc", content: [{ type: "blockquote", attrs: { blockId: "blk_quote01" }, content: table ? [table] : [] }] };
      const md = tiptapJsonToMarkdown(doc);
      expect(md).toBe("> | A |\n> | --- |\n> | 1 | ^blk_quote01");

      const back: JSONContent = markdownToTiptapJSON(md);
      expect(back.content?.[0]).toMatchObject({ type: "blockquote", attrs: { blockId: "blk_quote01" } });
      expect(grid(back.content?.[0] ?? {})).toEqual([["th:A"], ["td:1"]]);
      noMarkerText(back);
      expect(tiptapJsonToMarkdown(back)).toBe(md);
    });

    it("只有表头行的表格不写标记：分隔行后接上标记就不再是表格", () => {
      const md = tiptapJsonToMarkdown(withId(tableDoc([th([idPara("blk_cell01", "A")])]), "blk_table02"));
      expect(md).toBe("| A |\n| --- |");
      expect(grid(markdownToTiptapJSON(md))).toEqual([["th:A"]]);
    });

    it("保留为 HTML 的表格：表格与单元格段落的 ID 随属性往返，行尾另写表格 ID", () => {
      const doc = withId(
        tableDoc([th([idPara("blk_cell01", "合并")], { colspan: 2 })], [td([idPara("blk_cell02", "1")]), td([idPara("blk_cell03", "2")])]),
        "blk_table03",
      );
      const { md, back } = roundTrip(doc);
      expect(md.startsWith("<table")).toBe(true);
      expect(md.endsWith("</table> ^blk_table03")).toBe(true);
      expect(tableOf(back)?.attrs?.blockId).toBe("blk_table03");
      expect(tableOf(back)?.content?.map((row) => row.content?.map((cell) => cell.content?.[0]?.attrs?.blockId))).toEqual([
        ["blk_cell01"],
        ["blk_cell02", "blk_cell03"],
      ]);
      noMarkerText(back);
    });
  });
});
