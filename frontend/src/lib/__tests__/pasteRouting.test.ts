import { describe, expect, it } from "vitest";
import {
  classifyClipboardHtml,
  extractClipboardVisibleText,
  hasMeaningfulClipboardHtml,
  hasRichRtfContent,
  normalizeClipboardComparisonText,
  shouldHandleAsMarkdownPaste,
} from "@/lib/pasteRouting";

describe("paste routing", () => {
  it("优先保留钉钉提供的真正富文本，而不是把数字列表误当作 Markdown", () => {
    const html = `
      <h2 style="background-color:#b7d7ce">一、产品介绍说明</h2>
      <ul><li><strong>主光源：</strong>8 颗 6W 灯珠</li></ul>
    `;

    const analysis = classifyClipboardHtml({ html });
    expect(analysis.kind).toBe("rich");
    expect(hasMeaningfulClipboardHtml(html)).toBe(true);
    expect(shouldHandleAsMarkdownPaste(html, true)).toBe(false);
  });

  it("剪贴板只有 Markdown 纯文本时仍保留自动识别", () => {
    expect(shouldHandleAsMarkdownPaste("", true)).toBe(true);
    expect(shouldHandleAsMarkdownPaste("", false)).toBe(false);
  });

  it("只有剪贴板元信息的 HTML 空壳不会阻断 Markdown 识别", () => {
    const shell = '<html><head><meta charset="utf-8"></head><body></body></html>';

    expect(classifyClipboardHtml({ html: shell }).kind).toBe("empty");
    expect(hasMeaningfulClipboardHtml(shell)).toBe(false);
    expect(shouldHandleAsMarkdownPaste(shell, true)).toBe(true);
  });

  it("div/span/p 只是 Markdown 的展示外壳时允许 Markdown 路由接管", () => {
    const text = [
      "## 二、解决方案",
      "",
      "- 腾讯 EO 负责控制台",
      "- 阿里云 ESA 负责下载",
      "",
      "| 域名 | 作用 |",
      "| --- | --- |",
      "| fn.example.com | 控制台 |",
    ].join("\n");
    const html = [
      "<div><span>## 二、解决方案</span></div>",
      "<div><br></div>",
      "<p><span>- 腾讯 EO 负责控制台</span></p>",
      "<p><span>- 阿里云 ESA 负责下载</span></p>",
      "<div><br></div>",
      "<div>| 域名 | 作用 |</div>",
      "<div>| --- | --- |</div>",
      "<div>| fn.example.com | 控制台 |</div>",
    ].join("");

    const analysis = classifyClipboardHtml({ html, text });
    expect(analysis.kind).toBe("text-shell");
    expect(analysis.plainTextEquivalent).toBe(true);
    expect(hasMeaningfulClipboardHtml(html)).toBe(false);

    // Canonical route (text + html) and the existing TiptapEditor legacy call must both fix the
    // reported case so this change is effective without changing the Markdown score/threshold.
    expect(shouldHandleAsMarkdownPaste({ text, html, markdownLike: true })).toBe(true);
    expect(shouldHandleAsMarkdownPaste(html, true)).toBe(true);
  });

  it("普通 class/color/font-family 包装不应把 Markdown 误判成真正富文本", () => {
    const text = "## 标题\n\n- A\n- B";
    const html = [
      '<div class="ql-line"><span style="color:#000;font-family:Arial">## 标题</span></div>',
      "<div><br></div>",
      '<p class="ql-line"><span>- A</span></p>',
      '<p class="ql-line"><span>- B</span></p>',
    ].join("");

    expect(classifyClipboardHtml({ html, text }).kind).toBe("text-shell");
    expect(shouldHandleAsMarkdownPaste({ text, html, markdownLike: true })).toBe(true);
    expect(shouldHandleAsMarkdownPaste(html, true)).toBe(true);
  });

  it("HTML 可见文本与 text/plain 不一致时 fail closed，继续保留 HTML", () => {
    const text = "## Markdown 标题\n\n- A\n- B";
    const html = "<div>这是另一个内容</div>";
    const analysis = classifyClipboardHtml({ html, text });

    expect(analysis.kind).toBe("ambiguous");
    expect(analysis.reason).toBe("text-mismatch");
    expect(analysis.plainTextEquivalent).toBe(false);
    expect(shouldHandleAsMarkdownPaste({ text, html, markdownLike: true })).toBe(false);
  });

  it("真正的结构标签始终 HTML 优先", () => {
    const cases = [
      "<h2>标题</h2><ul><li>项目 A</li></ul>",
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
      '<p><a href="https://example.com">Example</a></p>',
      "<p><strong>粗体</strong>和<em>斜体</em></p>",
      "<pre><code>const a = 1</code></pre>",
    ];

    for (const html of cases) {
      expect(classifyClipboardHtml({ html }).kind).toBe("rich");
      expect(shouldHandleAsMarkdownPaste(html, true)).toBe(false);
    }
  });

  it("图片、视频和 ProseMirror/Nowen 内部 clipboard 数据不能被 Markdown 抢走", () => {
    const cases = [
      '<p><img src="https://example.com/a.png"></p>',
      '<div><video src="https://example.com/a.mp4"></video></div>',
      '<div data-pm-slice="1 1 []">## title</div>',
      '<div data-nowen-attachment-id="abc">## title</div>',
    ];

    for (const html of cases) {
      expect(classifyClipboardHtml({ html }).kind).toBe("rich");
      expect(shouldHandleAsMarkdownPaste(html, true)).toBe(false);
    }
  });

  it("RTF 携带嵌入图片时即使 plain/html 看起来像 Markdown 也保留富内容路径", () => {
    const text = "## 标题\n\n- A\n- B";
    const html = "<div>## 标题</div><div><br></div><div>- A</div><div>- B</div>";
    const rtf = "{\\rtf1\\ansi{\\pict\\pngblip 89504E47}}";

    expect(hasRichRtfContent(rtf)).toBe(true);
    expect(shouldHandleAsMarkdownPaste({ text, html, rtf, markdownLike: true })).toBe(false);
  });

  it("高价值 inline style 仍视为真正富文本，但普通 color/font-family 包装不是", () => {
    expect(classifyClipboardHtml({
      html: '<div><span style="font-weight:700">## 标题</span></div>',
    }).kind).toBe("rich");
    expect(classifyClipboardHtml({
      html: '<div><span style="background-color:yellow">## 标题</span></div>',
    }).kind).toBe("rich");
    expect(classifyClipboardHtml({
      html: '<div><span style="color:#222;font-family:Arial">## 标题</span></div>',
    }).kind).toBe("text-shell");
  });

  it("未知 HTML 标签按 ambiguous 处理，不凭猜测丢弃 HTML", () => {
    const html = "<custom-editor-block>## 标题</custom-editor-block>";
    const analysis = classifyClipboardHtml({ html });

    expect(analysis.kind).toBe("ambiguous");
    expect(analysis.reason).toBe("unknown-html");
    expect(shouldHandleAsMarkdownPaste(html, true)).toBe(false);
  });

  it("HTML visible text 提取保留 div/p/br 的块边界并规范 nbsp", () => {
    const html = "<div>## 标题</div><div><br></div><p>- A&nbsp;B</p><p>- C</p>";
    const visible = extractClipboardVisibleText(html);

    expect(visible).toBe("## 标题\n\n- A B\n- C");
    expect(normalizeClipboardComparisonText("## 标题\r\n\r\n- A B  \r\n- C")).toBe(visible);
  });

  it("普通文本即使 HTML 只是 shell，也不会被 Markdown 路由接管", () => {
    const text = "这只是普通文本\n第二行";
    const html = "<div>这只是普通文本</div><div>第二行</div>";

    expect(classifyClipboardHtml({ html, text }).kind).toBe("text-shell");
    expect(shouldHandleAsMarkdownPaste({ text, html, markdownLike: false })).toBe(false);
    expect(shouldHandleAsMarkdownPaste(html, false)).toBe(false);
  });
});
