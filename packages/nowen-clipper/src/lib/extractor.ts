/**
 * 网页内容抽取：把当前页面 / 选区转为"结构化 HTML + 纯文本"。
 *
 * 三种模式：
 *   - article：走 Mozilla Readability，智能提取正文，保留图片等所有元素
 *   - simplified：走 Readability，但移除图片/视频等重元素，只保留文本
 *   - selection：只处理用户已选中的区域，保留用户意图
 *
 * 输出始终是 HTML（而不是 Tiptap JSON），原因：
 *   - 后端 /api/export/import 会把 <img src="data:..."> 自动抽到 attachments
 *   - HTML → Markdown 转换（turndown）放在 background（或 popup），content 脚本
 *     不做重活，避免把 turndown 注入到每个页面增加内存
 *   - 保留"链接 href"靠 <a href> 天然优势，不需要额外编码
 *
 * 这个文件会被打包到 content script，依赖必须是 ESM 且能在网页 worker-less
 * 环境下运行。Readability 官方包就是纯 ESM，没有副作用，正合适。
 */

import { Readability, isProbablyReaderable } from "@mozilla/readability";

export interface ExtractResult {
  title: string;
  html: string;
  text: string;
  /** 页面原始 URL */
  url: string;
  /** 站点名（og:site_name 或 hostname） */
  siteName: string;
  /** 简短摘要（Readability 给出的 excerpt） */
  excerpt: string;
  /** 字数估计 */
  length: number;
  /** 抽取模式 */
  mode: "article" | "selection" | "simplified";
}

/**
 * 抽取当前页"正文"（完整内容）。
 *
 * 策略：先用 Readability 智能提取，再做质量检测。
 * 如果 Readability 提取出的文字量不足全文的 30%，或者文字量小于 100 字，
 * 则认为 Readability 对该页面类型效果不佳（论坛、列表页、后台面板等），
 * 回退到 **直接抓取 body 内容** 并做基本清洗的方式，保证内容完整。
 *
 * 注意阈值故意偏高（30%），宁可多触发 fallback 也不丢内容。
 * Readability 对标准文章页（新闻、博客）的提取比例通常在 60-90%，
 * 不会被误伤。
 */
export function extractArticle(): ExtractResult | null {
  // 参考全文文字量（去掉 script/style 后的文字）
  const bodyText = (document.body?.innerText || "").trim();
  const bodyTextLen = bodyText.length;

  // 尝试 Readability 提取
  const readabilityResult = tryReadability();

  if (readabilityResult) {
    const extractedTextLen = readabilityResult.text.length;
    // 质量检测：提取出的文字量是否足够
    const ratio = bodyTextLen > 0 ? extractedTextLen / bodyTextLen : 1;
    console.log(
      `[nowen-clipper] Readability 提取: ${extractedTextLen} 字 / 全文 ${bodyTextLen} 字 (${(ratio * 100).toFixed(1)}%)`,
    );
    if (extractedTextLen >= 100 && ratio >= 0.3) {
      // Readability 提取效果合格
      return readabilityResult;
    }
    console.log(
      `[nowen-clipper] Readability 提取不充分，回退到全页抓取`,
    );
  } else {
    console.log("[nowen-clipper] Readability 返回 null，回退到全页抓取");
  }

  // Fallback：直接抓取 body 内容，只做基本清洗
  return extractFullBody();
}

/** Readability 智能提取（原方案） */
function tryReadability(): ExtractResult | null {
  const cloned = document.cloneNode(true) as Document;
  preCleanDom(cloned);
  const reader = new Readability(cloned, {
    keepClasses: false,
    charThreshold: 200,
  });
  const parsed = reader.parse();
  if (!parsed) return null;

  const html = sanitizeHtml(parsed.content || "");
  return {
    title: (parsed.title || document.title || "").trim() || "无标题",
    html,
    text: (parsed.textContent || "").trim(),
    url: location.href,
    siteName: parsed.siteName || location.hostname,
    excerpt: (parsed.excerpt || "").trim(),
    length: parsed.length || 0,
    mode: "article",
  };
}

/**
 * Fallback：当 Readability 效果不佳时，直接抓取页面主体内容。
 *
 * 优先查找 <main>、<article>、[role="main"]；如果没有就取整个 <body>。
 * 移除 script/style/nav/header/footer 等明显非正文标签，但不做激进的 class 名匹配清洗——
 * 宁可多留一些无关内容也不能丢失正文。
 */
function extractFullBody(): ExtractResult | null {
  // 优先查找语义化的主内容区域
  const mainEl = document.querySelector("main, [role='main'], article");
  const sourceEl = mainEl || document.body;
  if (!sourceEl) return null;

  const cloned = sourceEl.cloneNode(true) as HTMLElement;

  // 轻度清洗：只移除一定不需要的标签
  const lightRemove = "script, style, noscript, link[rel='stylesheet'], svg, canvas";
  for (const el of Array.from(cloned.querySelectorAll(lightRemove))) {
    el.parentNode?.removeChild(el);
  }

  // 移除语义化的导航/页脚元素（不做 class 名模式匹配，避免误删论坛正文）
  for (const el of Array.from(cloned.querySelectorAll("nav, [role='navigation']"))) {
    el.parentNode?.removeChild(el);
  }

  // 规范化图片链接为绝对 URL
  absolutizeUrls(cloned, location.href);

  // 清洗 HTML（去掉事件、追踪属性等，但保留结构）
  const html = sanitizeHtml(cloned.innerHTML);
  const text = (cloned.textContent || "").trim();

  if (!text) return null;

  return {
    title: (document.title || "").trim() || "无标题",
    html,
    text,
    url: location.href,
    siteName: getSiteName(),
    excerpt: text.slice(0, 200),
    length: text.length,
    mode: "article",
  };
}

/**
 * 简化内容模式：同样走 Readability 抽取正文，但移除图片、视频、音频、iframe 等重元素，
 * 只保留纯文本 + 标题/段落/列表/表格/链接等结构。
 */
export function extractSimplified(): ExtractResult | null {
  const cloned = document.cloneNode(true) as Document;
  // 在 Readability 解析前清理克隆 DOM
  preCleanDom(cloned);
  const reader = new Readability(cloned, {
    keepClasses: false,
    charThreshold: 200,
  });
  const parsed = reader.parse();
  if (!parsed) return null;

  // 在 parsed.content 上移除图片/视频等重元素
  let html = parsed.content || "";
  html = stripHeavyElements(html);
  html = sanitizeHtml(html);
  // 简化模式：额外清理残留的空白元素和无意义内容
  html = postCleanHtml(html);

  return {
    title: (parsed.title || document.title || "").trim() || "无标题",
    html,
    text: (parsed.textContent || "").trim(),
    url: location.href,
    siteName: parsed.siteName || location.hostname,
    excerpt: (parsed.excerpt || "").trim(),
    length: parsed.length || 0,
    mode: "simplified",
  };
}

/**
 * 在 Readability 解析之前预清理 DOM，移除导航栏、侧边栏、页脚、广告等
 * 显而易见的非正文元素。这能显著提升 Readability 对 SPA / 复杂页面的抽取精度。
 */
function preCleanDom(doc: Document): void {
  // 1. 移除语义化的非正文元素
  const semanticRemove = [
    "nav",
    "header",
    "footer",
    "aside",
    // 常见 role 属性
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']",
    "[role='complementary']",
    "[role='menu']",
    "[role='menubar']",
    "[role='toolbar']",
    "[role='dialog']",
    "[role='alertdialog']",
    // 常见 class/id 模式（覆盖绝大多数网站）
    "[class*='sidebar']",
    "[class*='Sidebar']",
    "[class*='side-bar']",
    "[class*='nav-']",
    "[class*='Nav-']",
    "[class*='navbar']",
    "[class*='Navbar']",
    "[class*='header']",
    "[class*='Header']",
    "[class*='footer']",
    "[class*='Footer']",
    "[class*='menu']",
    "[class*='Menu']",
    "[class*='toolbar']",
    "[class*='Toolbar']",
    "[class*='cookie']",
    "[class*='Cookie']",
    "[class*='popup']",
    "[class*='modal']",
    "[class*='Modal']",
    "[class*='toast']",
    "[class*='Toast']",
    "[class*='banner']",
    "[class*='Banner']",
    "[class*='ad-']",
    "[class*='ads-']",
    "[class*='advert']",
    "[class*='social']",
    "[class*='Social']",
    "[class*='share']",
    "[class*='Share']",
    "[class*='breadcrumb']",
    "[class*='Breadcrumb']",
    "[id*='sidebar']",
    "[id*='nav']",
    "[id*='header']",
    "[id*='footer']",
    "[id*='menu']",
    "[id*='cookie']",
    "[id*='popup']",
    "[id*='modal']",
    "[id*='banner']",
    "[id*='ad-']",
    "[id*='ads-']",
    "[id*='advert']",
  ].join(",");

  for (const el of Array.from(doc.querySelectorAll(semanticRemove))) {
    // 安全检查：如果这个元素包含 <article> 或 <main>，不移除它
    if (el.querySelector("article, main, [role='main']")) continue;
    // 安全检查：如果这个元素内的文字非常多（可能是误伤的正文容器），不移除
    const textLen = (el.textContent || "").trim().length;
    const bodyTextLen = (doc.body?.textContent || "").trim().length;
    if (bodyTextLen > 0 && textLen / bodyTextLen > 0.5) continue;
    el.parentNode?.removeChild(el);
  }

  // 2. 移除 <script> / <style> / <noscript> 等无内容标签
  for (const el of Array.from(doc.querySelectorAll("script, style, noscript, link[rel='stylesheet']"))) {
    el.parentNode?.removeChild(el);
  }

  // 3. 移除隐藏元素 (display:none / visibility:hidden / aria-hidden)
  for (const el of Array.from(doc.querySelectorAll("[aria-hidden='true'], [hidden]"))) {
    el.parentNode?.removeChild(el);
  }
}

/**
 * Readability 输出后的二次清理（用于简化模式）：
 * 移除只包含空白、单个短词或纯符号的残留段落/div。
 */
function postCleanHtml(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const root = tpl.content;

  // 移除文字极短（<3字符）且不含有效链接的块级元素
  const blockSelector = "p, div, section, span, li";
  for (const el of Array.from(root.querySelectorAll(blockSelector))) {
    const text = (el.textContent || "").trim();
    // 空或只有极短内容（如单个字母、图标字符等），并且不含子元素
    if (text.length < 3 && el.children.length === 0) {
      el.parentNode?.removeChild(el);
      continue;
    }
    // 移除只包含非文字 unicode 字符（图标、箭头等）的节点
    if (text.length < 10 && /^[\s\u00a0\u200b-\u200f\u2028-\u202f\ufeff\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff\ue000-\uf8ff]+$/u.test(text)) {
      el.parentNode?.removeChild(el);
    }
  }

  // 移除空的列表
  for (const el of Array.from(root.querySelectorAll("ul, ol"))) {
    if (!el.querySelector("li") || !(el.textContent || "").trim()) {
      el.parentNode?.removeChild(el);
    }
  }

  const container = document.createElement("div");
  container.appendChild(root.cloneNode(true));
  return container.innerHTML;
}

/** 移除 img / video / audio / picture / figure（仅含图片的） 等重元素 */
function stripHeavyElements(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const root = tpl.content;

  const heavySelector = "img, video, audio, picture, source, svg, canvas, iframe, embed, object";
  for (const el of Array.from(root.querySelectorAll(heavySelector))) {
    el.parentNode?.removeChild(el);
  }

  // figure 里如果只剩空白（图片已被移除），也移除整个 figure
  for (const fig of Array.from(root.querySelectorAll("figure"))) {
    if (!fig.textContent?.trim()) {
      fig.parentNode?.removeChild(fig);
    }
  }

  const container = document.createElement("div");
  container.appendChild(root.cloneNode(true));
  return container.innerHTML;
}

/**
 * 完全克隆模式：把整个页面包括样式完整地克隆下来，
 * 生成一个自包含的 HTML 文档字符串（含内联 CSS），
 * 预览端用 <iframe srcdoc> 渲染即可 1:1 还原。
 *
 * 策略：
 *   1. 收集页面上所有 <style> 标签的内容
 *   2. 收集所有 <link rel="stylesheet"> 通过 CSSOM 读取已加载的规则（无跨域限制问题）
 *   3. 克隆 <body>，保留 class / id / style 属性（不做清洗）
 *   4. 把绝对化后的图片 URL、链接 URL 一并保留
 *   5. 输出格式：完整 HTML 文档字符串 `<!DOCTYPE html><html>...</html>`
 */
export function extractFullPage(): ExtractResult | null {
  try {
    // ── 1. 收集所有 CSS ──
    const cssTexts: string[] = [];

    // 1a. 读取所有已加载的 stylesheet（通过 CSSOM，可以规避跨域 fetch 的限制）
    for (let i = 0; i < document.styleSheets.length; i++) {
      const sheet = document.styleSheets[i];
      try {
        const rules = sheet.cssRules || sheet.rules;
        if (rules && rules.length > 0) {
          const parts: string[] = [];
          for (let j = 0; j < rules.length; j++) {
            parts.push(rules[j].cssText);
          }
          cssTexts.push(parts.join("\n"));
        }
      } catch {
        // 跨域 stylesheet 无法读取 cssRules，忽略
        // 这种情况下只能跳过（CDN CSS 等）
        if (sheet.href) {
          // 保留一个 @import 引用，预览时如果有网络可以加载
          cssTexts.push(`@import url("${sheet.href}");`);
        }
      }
    }

    // 1b. 也收集 <style> 标签（以防 CSSOM 没覆盖到的内联样式块）
    // （实际上 CSSOM 已经包含了它们，这里做个兜底）

    // ── 2. 克隆 body ──
    const bodyClone = document.body.cloneNode(true) as HTMLElement;

    // 移除 script / noscript（不需要执行脚本）
    for (const el of Array.from(bodyClone.querySelectorAll("script, noscript"))) {
      el.parentNode?.removeChild(el);
    }

    // 规范化图片和链接 URL 为绝对路径
    absolutizeUrls(bodyClone, location.href);

    // 处理懒加载图片：很多网站用 data-src 存储真实图片 URL
    for (const img of Array.from(bodyClone.querySelectorAll("img"))) {
      const src = img.getAttribute("src") || "";
      const dataSrc = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy-src") || "";
      // 如果 src 是空的或者是占位图，用 data-src 替换
      if (dataSrc && (!src || src.startsWith("data:image/gif") || src.startsWith("data:image/svg") || src.includes("placeholder") || src.includes("loading"))) {
        try {
          img.setAttribute("src", new URL(dataSrc, location.href).href);
        } catch { /* ignore */ }
      }
    }

    // ── 3. 获取页面 meta 信息 ──
    const charset = document.characterSet || "UTF-8";
    const baseHref = location.href;

    // ── 4. 拼装完整 HTML 文档 ──
    // 包含：meta charset、base href（让相对资源能正确加载）、
    //       收集到的 CSS、body 内容
    const fullHtml = [
      `<!DOCTYPE html>`,
      `<html lang="${document.documentElement.lang || ""}">`,
      `<head>`,
      `<meta charset="${charset}">`,
      `<base href="${escapeFullPageAttr(baseHref)}">`,
      `<meta name="viewport" content="width=device-width, initial-scale=1">`,
      // 注入收集到的所有 CSS
      `<style>`,
      cssTexts.join("\n\n/* --- sheet boundary --- */\n\n"),
      `</style>`,
      `</head>`,
      `<body class="${escapeFullPageAttr(document.body.className || "")}">`,
      bodyClone.innerHTML,
      `</body>`,
      `</html>`,
    ].join("\n");

    const text = (bodyClone.textContent || "").trim();

    return {
      title: (document.title || "").trim() || "无标题",
      html: fullHtml,
      text: text.slice(0, 5000), // text 只用于搜索索引，截断避免过大
      url: location.href,
      siteName: getSiteName(),
      excerpt: text.slice(0, 200),
      length: text.length,
      mode: "article", // 复用 article mode 标记，后端不需要区分
    };
  } catch (e: any) {
    console.error("[nowen-clipper] extractFullPage 失败:", e);
    return null;
  }
}

/** 转义 HTML 属性值（用于 fullpage 模式拼装） */
function escapeFullPageAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 抽取当前选中区域（至少 1 个字符） */
export function extractSelection(): ExtractResult | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

  const container = document.createElement("div");
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    container.appendChild(range.cloneContents());
  }
  // 规范化 <img src> / <a href> 为绝对 URL
  absolutizeUrls(container, location.href);
  const html = sanitizeHtml(container.innerHTML);
  const text = container.textContent || "";
  if (!text.trim()) return null;

  return {
    title: (document.title || "").trim() || "无标题",
    html,
    text: text.trim(),
    url: location.href,
    siteName: getSiteName(),
    excerpt: text.trim().slice(0, 200),
    length: text.length,
    mode: "selection",
  };
}

function getSiteName(): string {
  const og = document.querySelector('meta[property="og:site_name"]');
  if (og) {
    const v = og.getAttribute("content");
    if (v) return v;
  }
  return location.hostname;
}

/**
 * 把 <img src="relative.jpg">、<a href="/path"> 转为绝对 URL。
 * selectionRange.cloneContents() 会丢失相对 URL 的 base，必须手动修。
 */
function absolutizeUrls(root: HTMLElement, base: string): void {
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (src) {
      try {
        img.setAttribute("src", new URL(src, base).href);
      } catch {
        /* ignore */
      }
    }
    // data-src / srcset 懒加载兜底（不少站点 src 是占位图）
    const dataSrc = img.getAttribute("data-src") || img.getAttribute("data-original");
    if (dataSrc && (!src || src.startsWith("data:image/gif"))) {
      try {
        img.setAttribute("src", new URL(dataSrc, base).href);
      } catch {
        /* ignore */
      }
    }
    img.removeAttribute("srcset"); // 简化
  }
  for (const a of Array.from(root.querySelectorAll("a"))) {
    const href = a.getAttribute("href");
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      try {
        a.setAttribute("href", new URL(href, base).href);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 简单的 HTML 清洗：移除明显不需要的标签/属性。
 * 目的不是严格 XSS 防御（后端会再处理），而是避免把一堆 <script> / <style>
 * / 追踪脚本一起剪藏进去。
 */
function sanitizeHtml(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const root = tpl.content;

  const removeSelector = [
    "script",
    "style",
    "noscript",
    "iframe",
    "object",
    "embed",
    "svg",
    "canvas",
    "link",
    "meta",
    // 常见"广告/推荐/评论"容器
    "[aria-hidden='true']",
  ].join(",");
  for (const el of Array.from(root.querySelectorAll(removeSelector))) {
    el.parentNode?.removeChild(el);
  }

  // 清掉内联事件和无用属性
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const attrs = el.getAttributeNames();
    for (const a of attrs) {
      if (a.startsWith("on")) el.removeAttribute(a);
      if (a === "style") el.removeAttribute(a);
      if (a === "class") el.removeAttribute(a);
      if (a === "id") el.removeAttribute(a);
      if (a.startsWith("data-")) el.removeAttribute(a);
    }
  }

  const container = document.createElement("div");
  container.appendChild(root.cloneNode(true));
  return container.innerHTML;
}
