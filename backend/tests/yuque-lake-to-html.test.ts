import assert from "node:assert/strict";
import test from "node:test";
import { yuqueLakeToHtml } from "../src/lib/yuqueLakeToHtml";

test("标题 / 段落 / 加粗保留", () => {
  const html = `<div class="lake-content"><h1 class="lake-h1">标题</h1><p><strong>加粗</strong>正文</p></div>`;
  const out = yuqueLakeToHtml(html);
  assert.match(out, /<h1[^>]*>标题<\/h1>/);
  assert.match(out, /<strong>加粗<\/strong>/);
  assert.match(out, /正文/);
  // 外层 lake-content 容器被剥掉
  assert.ok(!out.includes("lake-content"));
});

test("列表结构保留", () => {
  const html = `<ul><li>甲</li><li>乙</li></ul><ol><li>一</li></ol>`;
  const out = yuqueLakeToHtml(html);
  assert.match(out, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
  assert.match(out, /<ol><li>一<\/li><\/ol>/);
});

test("代码块：data-language 转 language class", () => {
  const html = `<pre data-language="javascript">const a = 1;</pre>`;
  const out = yuqueLakeToHtml(html);
  assert.match(out, /<pre><code class="language-javascript">/);
  assert.match(out, /const a = 1;/);
  assert.ok(out.includes("</code></pre>"));
});

test("代码块：无 data-language 不重复包裹", () => {
  const html = `<pre>plain code</pre>`;
  const out = yuqueLakeToHtml(html);
  assert.match(out, /<pre><code>plain code<\/code><\/pre>/);
  assert.ok(!out.includes("<code><code"));
});

test("代码块：已含 code 不重复包裹", () => {
  const html = `<pre><code class="language-py">x = 1</code></pre>`;
  const out = yuqueLakeToHtml(html);
  assert.match(out, /<pre><code class="language-py">x = 1<\/code><\/pre>/);
});

test("表格保留", () => {
  const html = `<table><thead><tr><th>列1</th></tr></thead><tbody><tr><td>值</td></tr></tbody></table>`;
  const out = yuqueLakeToHtml(html);
  assert.match(out, /<table>/);
  assert.match(out, /<th[^>]*>列1<\/th>/);
  assert.match(out, /<td[^>]*>值<\/td>/);
});

test("图片 src 保留（交由后续本地化处理）", () => {
  const html = `<p><img src="https://cdn.nlark.com/yuque/0/2021/png/1.png" alt="图" /></p>`;
  const out = yuqueLakeToHtml(html);
  assert.match(out, /<img[^>]*src="https:\/\/cdn\.nlark\.com\/yuque\/0\/2021\/png\/1\.png"/);
});

test("行内数学公式保留为 data-math-inline", () => {
  const html = `<p>公式 <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow><annotation encoding="application/x-tex">x+1</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="strut"></span><span class="mord mathnormal">x</span></span></span></span> 结束</p>`;
  const out = yuqueLakeToHtml(html);
  // LaTeX 源码被提取并保留为项目公式节点
  assert.match(out, /<span data-math-inline="true" data-latex="x\+1">/);
  // 不再残留 KaTeX 渲染结构
  assert.ok(!out.includes("katex"));
  assert.ok(!out.includes("<math"));
  assert.ok(!out.includes("annotation"));
  assert.match(out, /公式/);
  assert.match(out, /结束/);
});

test("块级数学公式保留为 data-math-block", () => {
  const html = `<p><span class="katex-display"><span class="katex"><span class="katex-mathml"><math><semantics><mrow><mfrac><mn>1</mn><mn>2</mn></mfrac></mrow><annotation encoding="application/x-tex">\\frac{1}{2}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x</span></span></span></p>`;
  const out = yuqueLakeToHtml(html);
  assert.match(out, /<div data-math-block="true" data-latex="\\frac\{1\}\{2\}">/);
  assert.ok(!out.includes("katex-display"));
});

test("特殊字符 LaTeX 源码正确转义进 data-latex", () => {
  const html = `<p><span class="katex"><span class="katex-mathml"><math><semantics><mrow><annotation encoding="application/x-tex">a &lt; b &amp; c</annotation></mrow></semantics></math></span></span></p>`;
  const out = yuqueLakeToHtml(html);
  assert.match(out, /data-latex="a &lt; b &amp; c"/);
});

test("引用块保留", () => {
  const html = `<blockquote><p>引用内容</p></blockquote>`;
  const out = yuqueLakeToHtml(html);
  assert.match(out, /<blockquote>/);
  assert.match(out, /引用内容/);
});

test("危险内容被清洗（XSS）", () => {
  const html = `<p>安全</p><script>alert(1)</script><img src="x" onerror="alert(2)">`;
  const out = yuqueLakeToHtml(html);
  assert.ok(!out.includes("<script"));
  assert.ok(!out.includes("onerror"));
  assert.ok(!out.includes("javascript:"));
});

test("空输入返回空串", () => {
  assert.equal(yuqueLakeToHtml(""), "");
  assert.equal(yuqueLakeToHtml("   "), "");
});
