/**
 * lake 格式 HTML → Nowen 兼容 HTML（导入专用）。
 *
 * 输入：文档详情 API 返回的 body 字段（lake 编辑器渲染后的 HTML，内容区为
 *       <div class="lake-content"> 或旧格式 <div class="lake-engine">）。
 * 输出：可供 sanitizeForImport 直接入库的通用 HTML 结构。
 *
 * 转换策略：
 *  - 数学公式：从 KaTeX 渲染的 `<annotation encoding="application/x-tex">`
 *    提取 LaTeX 源码，转成项目公式节点 `<span data-math-inline data-latex="…">`
 *    与 `<div data-math-block data-latex="…">`（行内/块级），公式完整保留。
 *  - 代码块：`<pre data-language="js">` → `<pre><code class="language-js">`。
 *  - 表格 / 列表 / 引用 / 图片等结构完整保留；图片交由 rewriteImages 本地化。
 */
import { load } from "cheerio";
import { sanitizeForImport } from "./sanitizeHtml";

/** HTML 属性值转义（用于把 LaTeX 源码安全写入 data-latex）。 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 数学公式：KaTeX 渲染的公式提取 LaTeX，转项目公式节点。 */
function convertFormulas($: ReturnType<typeof load>): void {
  // 先处理块级公式（span.katex-display 是 KaTeX displayMode 的标准包装）
  $("span.katex-display").each((_, el) => {
    const $el = $(el);
    const latex = $el.find('annotation[encoding="application/x-tex"]').first().text().trim();
    if (!latex) return;
    const $div = $(`<div data-math-block="true" data-latex="${escapeAttr(latex)}">$${latex}$</div>`);
    $el.replaceWith($div);
  });

  // 再处理行内公式（剩余的 span.katex）
  $("span.katex").each((_, el) => {
    const $el = $(el);
    const latex = $el.find('annotation[encoding="application/x-tex"]').first().text().trim();
    if (!latex) return;
    const $span = $(`<span data-math-inline="true" data-latex="${escapeAttr(latex)}">$${latex}$</span>`);
    $el.replaceWith($span);
  });
}

/** 代码块归一化：data-language 转为 <code class="language-*">。 */
function convertCodeBlocks($: ReturnType<typeof load>): void {
  $("pre").each((_, el) => {
    const $pre = $(el);
    const lang = ($pre.attr("data-language") || "").trim();
    $pre.removeAttr("data-language");
    const $code = $pre.children("code").first();
    if ($code.length) {
      if (lang) $code.addClass(`language-${lang}`);
      return;
    }
    const inner = $pre.html() || "";
    $pre.empty();
    $pre.append(`<code${lang ? ` class="language-${lang}"` : ""}>${inner}</code>`);
  });
}

/** 去掉空容器与多余空白，避免导入后出现悬空空行。 */
function cleanup(html: string): string {
  return html
    .replace(/<div[^>]*>\s*<\/div>/g, "")
    .replace(/<span[^>]*>\s*<\/span>/g, "")
    .replace(/<br\s*\/?>\s*<br\s*\/?>/g, "<br>")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** lake HTML → 可入库的通用 HTML。 */
export function yuqueLakeToHtml(input: string): string {
  if (!input || typeof input !== "string") return "";
  const $ = load(input);

  // 剥掉 lake-content / lake-engine 外层包装，只留正文
  const container = $(".lake-content, .lake-engine").first();
  let html: string;
  if (container.length) {
    html = container.html() || "";
  } else {
    html = $("body").length ? $("body").html() || "" : $.html();
  }

  // 用完整文档解析公式与代码块（容器内容可能被重新 load）
  const $frag = load(html);
  convertFormulas($frag);
  convertCodeBlocks($frag);

  html = $frag.html() || html;
  html = sanitizeForImport(html);
  return cleanup(html);
}
