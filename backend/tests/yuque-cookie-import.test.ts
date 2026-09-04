import assert from "node:assert/strict";
import test from "node:test";
import { yuqueMarkdownToHtml } from "../src/lib/yuqueMarkdownToHtml";
import { parseYuquePageToc } from "../src/lib/yuquePageToc";

// ---------- yuqueMarkdownToHtml ----------

test("md：标题 / 列表 / 加粗转换", () => {
  const md = "# 标题\n\n**加粗**正文\n\n- 甲\n- 乙\n";
  const out = yuqueMarkdownToHtml(md);
  assert.match(out, /<h1[^>]*>标题<\/h1>/);
  assert.match(out, /<strong>加粗<\/strong>/);
  assert.match(out, /<ul>/);
  assert.match(out, /<li>甲<\/li>/);
});

test("md：行内公式保留为 data-math-inline", () => {
  const md = "公式 $x^2+1$ 结束";
  const out = yuqueMarkdownToHtml(md);
  assert.match(out, /<span data-math-inline="true" data-latex="x\^2\+1">/);
});

test("md：块级公式保留为 data-math-block", () => {
  const md = "$$\\frac{1}{2}$$";
  const out = yuqueMarkdownToHtml(md);
  assert.match(out, /<div data-math-block="true" data-latex="\\frac\{1\}\{2\}">/);
});

test("md：表格（GFM）转换", () => {
  const md = "| a | b |\n|---|---|\n| 1 | 2 |\n";
  const out = yuqueMarkdownToHtml(md);
  assert.match(out, /<table>/);
  assert.match(out, /<th[^>]*>a<\/th>/);
  assert.match(out, /<td[^>]*>1<\/td>/);
});

test("md：图片链接保留（交由图片本地化处理）", () => {
  const md = "![图](https://cdn.nlark.com/yuque/1.png)";
  const out = yuqueMarkdownToHtml(md);
  assert.match(out, /<img[^>]*src="https:\/\/cdn\.nlark\.com\/yuque\/1\.png"/);
});

test("md：危险内容被清洗", () => {
  const md = "安全\n\n<script>alert(1)</script>\n\n[点我](javascript:alert(2))";
  const out = yuqueMarkdownToHtml(md);
  assert.ok(!out.includes("<script"));
  assert.ok(!out.includes("javascript:"));
});

test("md：closing ** 前有空格仍恢复加粗（**STOP **）", () => {
  const md = "点击开始即可，**STOP **终止烧录， **ERASE **可清除。";
  const out = yuqueMarkdownToHtml(md);
  assert.match(out, /<strong>STOP<\/strong>/);
  assert.match(out, /<strong>ERASE<\/strong>/);
  assert.ok(!out.includes("**STOP"));
});

test("md：反引号代码内裹星号转 strong 包 code（`**1**`）", () => {
  const md = "初次使用 `**1**` 处全部打钩";
  const out = yuqueMarkdownToHtml(md);
  assert.match(out, /<strong><code>1<\/code><\/strong>/);
  assert.ok(!out.includes("**1**"));
});

test("md：正常加粗不受影响", () => {
  const md = "这是 **正常加粗** 文本";
  const out = yuqueMarkdownToHtml(md);
  assert.match(out, /<strong>正常加粗<\/strong>/);
});

test("md：空输入返回空串", () => {
  assert.equal(yuqueMarkdownToHtml(""), "");
});

test("md：:::success 高亮块转 callout", () => {
  const md = ":::success\n高亮内容 **加粗**\n\n:::\n\n后面段落";
  const out = yuqueMarkdownToHtml(md);
  assert.match(out, /<div data-type="callout" data-callout-type="success">/);
  assert.match(out, /<strong>加粗<\/strong>/);
  assert.match(out, /高亮内容/);
  assert.match(out, /后面段落/);
});

test("md：未知 ::: 类型回退 info", () => {
  const md = ":::custom\n内容\n\n:::";
  const out = yuqueMarkdownToHtml(md);
  assert.match(out, /data-callout-type="info"/);
  assert.match(out, /内容/);
});

test("md：带空格的公式 $ c $ 仍识别为行内公式", () => {
  const md = "这是 $ c $ 公式";
  const out = yuqueMarkdownToHtml(md);
  assert.match(out, /<span data-math-inline="true" data-latex="c">/);
});

test("md：::: 高亮块内含公式也转换", () => {
  const md = ":::warning\n$$E=mc^2$$\n\n:::";
  const out = yuqueMarkdownToHtml(md);
  assert.match(out, /<div data-type="callout" data-callout-type="warning">/);
  assert.match(out, /data-math-block="true" data-latex="E=mc\^2"/);
});

// ---------- parseYuquePageToc ----------

test("toc：提取 DOC 条目并过滤非文档节点", () => {
  const appData = JSON.stringify({
    book: {
      toc: [
        { type: "DOC", id: 1, uuid: "u1", title: "文档一", url: "doc1", parent_uuid: "" },
        { type: "TITLE", id: 2, uuid: "u2", title: "分组", url: "", parent_uuid: "" },
        { type: "DOC", id: 3, uuid: "u3", title: "文档二", url: "doc2", parent_uuid: "u1" },
      ],
    },
  });
  const encoded = encodeURIComponent(appData);
  const html = `<!doctype html><script>window.appData = JSON.parse(decodeURIComponent("${encoded}"));})();</script>`;
  const docs = parseYuquePageToc(html);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].title, "文档一");
  assert.equal(docs[0].url, "doc1");
  assert.equal(docs[1].parentUuid, "u1");
});

test("toc：无 appData 返回空数组", () => {
  assert.deepEqual(parseYuquePageToc("<html><body>empty</body></html>"), []);
});

test("toc：损坏 JSON 返回空数组", () => {
  const html = `window.appData = JSON.parse(decodeURIComponent("%7Bbroken"));`;
  assert.deepEqual(parseYuquePageToc(html), []);
});
