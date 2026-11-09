import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { describe, expect, it } from "vitest";

import { remarkSiyuanCallouts } from "../markdownCallouts";
import { remarkPreserveLineBreaks } from "../markdownLineBreaks";

function render(markdown: string, options: { raw?: boolean; withPlugin?: boolean } = {}): string {
  const { raw = false, withPlugin = true } = options;
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: withPlugin
      ? [remarkGfm, remarkSiyuanCallouts, remarkPreserveLineBreaks]
      : [remarkGfm, remarkSiyuanCallouts],
    rehypePlugins: raw ? [rehypeRaw] : [],
  }, markdown));
}

const countBr = (html: string) => (html.match(/<br\s*\/?>/g) || []).length;

describe("remarkPreserveLineBreaks", () => {
  it("没有插件时单个换行只是文本里的 \\n（浏览器会折叠成空格）", () => {
    expect(render("12.1是3.3V供电\n18.5是5V供电", { withPlugin: false })).toBe("<p>12.1是3.3V供电\n18.5是5V供电</p>");
  });

  it("把段落里的单个换行渲染成 <br>，文字内容与换行位置不变", () => {
    const html = render("12.1是3.3V供电\n18.5是5V供电");
    expect(html).toBe("<p>12.1是3.3V供电<br/>\n18.5是5V供电</p>");
  });

  it("n 行文字得到 n-1 个 <br>，CRLF 与 LF 等价", () => {
    expect(countBr(render("一\n二\n三\n四"))).toBe(3);
    expect(render("一\r\n二\r\n三")).toBe(render("一\n二\n三"));
  });

  it("行首行尾夹带空格 / 制表符时仍只换一行", () => {
    expect(countBr(render("甲 \t\n \t乙"))).toBe(1);
    expect(render("甲 \t\n \t乙")).toContain("甲");
  });

  it("空行分隔的段落保持原样，不产生 <br>", () => {
    expect(render("段落一\n\n段落二\n\n\n段落三")).toBe(render("段落一\n\n段落二\n\n\n段落三", { withPlugin: false }));
    expect(countBr(render("段落一\n\n段落二\n\n\n段落三"))).toBe(0);
  });

  it("强调、链接等行内节点内部和之间的换行也保留", () => {
    expect(render("**粗\n体**")).toBe("<p><strong>粗<br/>\n体</strong></p>");
    expect(render("*甲*\n*乙*")).toBe("<p><em>甲</em><br/>\n<em>乙</em></p>");
    expect(render("[链\n接](https://example.com)")).toBe('<p><a href="https://example.com">链<br/>\n接</a></p>');
  });

  it("已有的硬换行（两个空格 / 反斜杠）不会被重复换行", () => {
    expect(render("甲  \n乙")).toBe(render("甲  \n乙", { withPlugin: false }));
    expect(countBr(render("甲  \n乙"))).toBe(1);
    expect(countBr(render("甲\\\n乙"))).toBe(1);
  });

  it("行尾手写的 <br> 后面的换行不会再多换一次", () => {
    for (const tag of ["<br>", "<br/>", "<br />", "<BR>"]) {
      const html = render(`显式换行${tag}\n下一行`, { raw: true });
      expect(countBr(html)).toBe(1);
      expect(html).toContain("下一行");
    }
    // <br> 之后再换两行，只有真正的软换行才补 <br>
    expect(countBr(render("甲<br>\n乙\n丙", { raw: true }))).toBe(2);
    // <br> 后面带了空格再换行，同样不多换一次
    expect(countBr(render("甲<br> \n乙", { raw: true }))).toBe(1);
  });

  it("围栏代码块、缩进代码块和行内代码里的换行不被处理", () => {
    const fenced = render("```js\nconst a = 1;\nconst b = 2;\n```");
    expect(countBr(fenced)).toBe(0);
    expect(fenced).toContain("const a = 1;\nconst b = 2;");
    expect(render("~~~\n甲\n乙\n~~~")).toBe(render("~~~\n甲\n乙\n~~~", { withPlugin: false }));
    expect(render("    缩进甲\n    缩进乙")).toBe(render("    缩进甲\n    缩进乙", { withPlugin: false }));
    expect(countBr(render("前 `行内\n代码` 后"))).toBe(0);
  });

  it("raw HTML 块里的换行不被处理", () => {
    const markdown = "<div>\n甲\n乙\n</div>";
    expect(render(markdown, { raw: true })).toBe(render(markdown, { raw: true, withPlugin: false }));
  });

  it("列表项、任务列表、引用里的续行都保留换行", () => {
    expect(render("- 甲\n  续行\n- 乙")).toContain("<li>甲<br/>\n续行</li>");
    expect(render("1. 甲\n   续行\n2. 乙")).toContain("<li>甲<br/>\n续行</li>");
    expect(render("- [ ] 任务\n  续行")).toContain("任务<br/>\n续行");
    expect(render("> 引用一\n> 引用二")).toContain("<p>引用一<br/>\n引用二</p>");
  });

  it("表格不受影响", () => {
    const table = "| 列A | 列B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |";
    expect(render(table)).toBe(render(table, { withPlugin: false }));
    expect(countBr(render(table))).toBe(0);
  });

  it("Callout 的标记行与正文仍被识别，正文里的换行保留", () => {
    const html = render("> [!NOTE] 提示标题\n> 正文第一行\n> 正文第二行");
    expect(html).not.toContain("[!NOTE]");
    expect(html).toContain("正文第一行<br/>\n正文第二行");
    expect(countBr(html)).toBe(1);
  });
});
