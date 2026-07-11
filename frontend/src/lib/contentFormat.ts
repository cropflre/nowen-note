/**
 * 笔记内容格式兼容层（MD 迁移 · 阶段 0）
 * ------------------------------------------------------------
 * 背景：
 *   历史笔记的 `content` 字段存的是 Tiptap ProseMirror JSON（字符串）。
 *   新编辑器（CodeMirror 6 MD）希望把 `content` 直接当成 Markdown 纯文本存取。
 *
 * 目标：
 *   - 让两种编辑器在并行上线阶段可以无缝读取任何一篇笔记
 *   - 后端 schema/接口零改动（`content TEXT` 继续原样透传）
 *   - 迁移可逆：只要不保存，旧数据格式不会被破坏
 *
 * 核心 API：
 *   - detectFormat(content)        判断字符串是 md / tiptap-json / html / empty
 *   - tiptapJsonToMarkdown(json)   Tiptap JSON → Markdown（复用 exportService 已有链路）
 *   - normalizeToMarkdown(content) 任意格式 → Markdown（MD 编辑器打开时用）
 *
 * 注意：
 *   本模块同步依赖 @tiptap/core + turndown，首次使用时会加载这些包。
 *   为了让新编辑器的主路径保持"纯 MD、不触达 Tiptap"，我们把转换函数做成
 *   **惰性初始化**（闭包里缓存 Turndown / Tiptap extensions）。只有遇到
 *   老格式笔记才会真正跑到那段代码。
 */

import { generateHTML, generateJSON, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableHeader, TableCell } from "@tiptap/extension-table";
// 与主编辑器对齐：TableRow 用扩展过 height 属性的版本（schema 兼容版，不带拖拽 plugin）
import { TableRowWithHeight } from "@/components/extensions/TableRowResizable";
import TextAlign from "@tiptap/extension-text-align";
import { common, createLowlight } from "lowlight";
import TurndownService from "turndown";
import { parser as baseMdParser } from "@lezer/markdown";
import { GFM } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import { MathInline, MathBlock } from "@/components/MathExtensions";
import { FootnoteReference, FootnoteDefinition } from "@/components/FootnoteExtensions";
import { TextStyleKit } from "@/components/FontSizeExtension";
import { Video as VideoExtension, videoNodeToMarkdown } from "@/components/VideoExtension";

// BLOCK-ID-01: heading blockId 扩展（与 TiptapEditor 对齐）
// 只声明 attrs，不带 appendTransaction plugin（generateHTML/generateJSON 不需要）
const BlockIdAttrs = Extension.create({
  name: "blockId",
  addGlobalAttributes() {
    return [{
      types: ["heading"],
      attributes: {
        blockId: {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id") || null,
          renderHTML: (attributes: any) => {
            if (!attributes.blockId) return {};
            return { "data-block-id": attributes.blockId };
          },
        },
      },
    }];
  },
});

// ---------- 格式识别 ----------

export type ContentFormat = "md" | "tiptap-json" | "html" | "empty";

/**
 * 启发式判断内容格式：
 * - 空串 / "{}" -> empty
 * - 形如 `{"type":"doc"...}` 或 `{"type":"..."}` -> tiptap-json
 * - 以 `<` 开头 + 含标签特征 -> html（历史少见，但 parseContent 里有兼容分支）
 * - 其他 -> md
 *
 * 这里做得比较保守：只有明确识别出 JSON 对象才认定为 tiptap-json，
 * 防止把以 `{` 开头的 MD 内容（极少见）误判。
 */
export function detectFormat(content: string | null | undefined): ContentFormat {
  if (content == null) return "empty";
  // 统一先剥掉首尾空白 + 零宽字符（常见于复制粘贴源污染）
  const trimmed = content.replace(/^[\s\uFEFF\u200B\u200C\u200D]+|[\s\uFEFF\u200B\u200C\u200D]+$/g, "");
  if (!trimmed || trimmed === "{}" || trimmed === "[]") return "empty";

  // Tiptap 以 `{` 开头。为减少误判，要求合法 JSON 对象且**明确含 Tiptap 文档特征**。
  // （`Array.isArray(parsed.content)` 单独一条不够严格——改为 type==="doc" OR
  // 顶层有 `type` 字段且含 `content` 数组。）
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const looksLikeTiptap =
          parsed.type === "doc" ||
          (typeof parsed.type === "string" && Array.isArray(parsed.content));
        if (looksLikeTiptap) return "tiptap-json";
      }
    } catch {
      /* 不是合法 JSON，往下当 md（例如 "{foo} 这段代码..." 这种 MD 内容） */
    }
  }

  // HTML 特征检测：
  //   1. 完整 HTML 文档：以 `<!DOCTYPE` 或 `<html` 开头（来自 clipper 完全克隆模式）
  //      注意：早期版本可能在文档前面拼了 HTML 注释（<!-- clipper-xxx -->），
  //      需要先跳过这些注释再检测。
  //   2. HTML 片段：以 `<tagname` 开头，且整体必须看起来像一个标签
  //      正确：<p>…   <div class="x">…   <br/>
  //      错误：<3 i love md   <= 5 items   < space

  // 跳过开头的 HTML 注释后再做 <!DOCTYPE / <html 检测
  const stripped = trimmed.replace(/^(\s*<!--[\s\S]*?-->\s*)+/, "");
  const lower = stripped.slice(0, 20).toLowerCase();
  if (lower.startsWith("<!doctype") || lower.startsWith("<html")) {
    return "html";
  }
  // 也检查原始内容（以 <!-- 开头且后续含 <!DOCTYPE 也算 HTML）
  if (trimmed.startsWith("<!--") && (lower.startsWith("<!doctype") || lower.startsWith("<html"))) {
    return "html";
  }
  if (trimmed.startsWith("<") && /^<[A-Za-z][A-Za-z0-9-]*(\s|\/|>)/.test(trimmed) && /<[A-Za-z][^<>]*>|<\/[A-Za-z][^<>]*>/.test(trimmed)) {
    return "html";
  }

  return "md";
}

// ---------- Tiptap → MD 转换（惰性初始化） ----------

let _extensions: any[] | null = null;
function getTiptapExtensions() {
  if (_extensions) return _extensions;
  const lowlight = createLowlight(common);
  _extensions = [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3] },
    }),
    Image.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          width: {
            default: null,
            parseHTML: (element) => {
              const raw = element.getAttribute("width");
              if (!raw) return null;
              const n = parseInt(raw, 10);
              return Number.isFinite(n) && n > 0 ? n : null;
            },
            renderHTML: (attrs) => {
              if (attrs.width == null) return {};
              return { width: attrs.width };
            },
          },
          height: {
            default: null,
            parseHTML: (element) => {
              const raw = element.getAttribute("height");
              if (!raw) return null;
              const n = parseInt(raw, 10);
              return Number.isFinite(n) && n > 0 ? n : null;
            },
            renderHTML: (attrs) => {
              if (attrs.height == null) return {};
              return { height: attrs.height };
            },
          },
        };
      },
    }).configure({ inline: false, allowBase64: true }),
    CodeBlockLowlight.configure({ lowlight }),
    Underline,
    Highlight.configure({ multicolor: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRowWithHeight,
    TableHeader,
    TableCell,
    // TextAlign 必须与 TiptapEditor 的 extensions 对齐，否则 generateHTML 时
    // `textAlign` 属性会被 Tiptap schema 过滤掉 → Turndown 拿不到 style
    // → RTE→MD 时段落对齐被静默丢失。markdownToTiptapJSON 反向也靠它识别 align 属性。
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    // BLOCK-ID-01: heading blockId 属性，与 TiptapEditor 对齐
    // 避免 generateHTML/generateJSON 时 blockId 被 schema 过滤
    BlockIdAttrs,
    // 数学公式：与 TiptapEditor 保持一致，避免 generateHTML 时 math 节点被 schema
    // 过滤掉。MathInline / MathBlock 都是 atom 节点，仅用属性 `latex` 携带源码。
    MathInline,
    MathBlock,
    // 脚注：与 TiptapEditor 对齐，generateHTML 时不能让 footnote 节点被过滤
    FootnoteReference,
    FootnoteDefinition,
    // TextStyle + Color + FontSize：行内 <span style="color/font-size">
    // 没有这三个扩展，generateHTML 时 textStyle mark 会被 schema 过滤掉
    // → Turndown 拿不到 inline style → 切到 MD 后再切回 RTE 时颜色/字号丢失。
    ...TextStyleKit,
    // 视频节点：必须与 TiptapEditor 保持一致，否则 generateHTML 时 video 节点
    // 会被 schema 过滤，导致切换到 MD 后视频丢失。
    VideoExtension,
  ];
  return _extensions;
}

let _turndown: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (_turndown) return _turndown;
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    // 换行用两个空格 + \n 的形式会破坏一些 MD 解析器，这里用硬换行
    br: "  ",
  });

  // 任务列表
  td.addRule("taskListItem", {
    filter: (node) =>
      node.nodeName === "LI" && node.getAttribute("data-type") === "taskItem",
    replacement: (content, node) => {
      const checked = (node as Element).getAttribute("data-checked") === "true";
      const cleanContent = content.replace(/^\n+/, "").replace(/\n+$/, "");
      return `${checked ? "- [x]" : "- [ ]"} ${cleanContent}\n`;
    },
  });

  // 高亮 (mark) → ==text==
  // 多色高亮：Tiptap 的 Highlight 多色扩展会把颜色写在 data-color / style 上，
  // 为了 MD→RTE 回读时不丢颜色，有颜色的 mark 以 HTML 原样保留（MD 原生不支持染色语法）。
  td.addRule("highlight", {
    filter: "mark",
    replacement: (content, node) => {
      const el = node as Element;
      const color =
        el.getAttribute("data-color") ||
        (el.getAttribute("style") || "").match(/background-color:\s*([^;]+)/i)?.[1]?.trim() ||
        "";
      if (color) {
        // 保留完整的 <mark data-color="..."> 使得 generateJSON 时 Highlight 能识别
        return `<mark data-color="${color.replace(/"/g, "&quot;")}" style="background-color:${color.replace(/"/g, "&quot;")}">${content}</mark>`;
      }
      return `==${content}==`;
    },
  });

  // 图片宽度保留：Tiptap image node 有 width 属性时，generateHTML 输出的 <img> 含
  // width="xxx"；Turndown 默认会把 img 转成 ![alt](src) 丢失 width。这里当 img
  // 有 width 属性时，保留为 HTML <img> 标签，让 ReactMarkdown + rehype-raw 透传，
  // 分享页 DOM 后处理再补 inline style。
  td.addRule("imageWithWidth", {
    filter: (node) => {
      if (node.nodeName !== "IMG") return false;
      const el = node as Element;
      return !!(
        el.getAttribute("width") ||
        el.getAttribute("data-width") ||
        (el as HTMLElement).style?.width
      );
    },
    replacement: (_content, node) => {
      const el = node as Element;
      const src = el.getAttribute("src") || "";
      const alt = el.getAttribute("alt") || "";
      const raw =
        el.getAttribute("width") ||
        el.getAttribute("data-width") ||
        ((el as HTMLElement).style?.width || "").replace(/px$/i, "") ||
        "";
      const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)$/);
      const w = m ? Math.round(Number(m[1])) : null;
      const wAttr = w && w > 0 ? ` width="${w}"` : "";
      return `<img src="${src.replace(/"/g, "&quot;")}" alt="${alt.replace(/"/g, "&quot;")}"${wAttr} />`;
    },
  });

  // 下划线保持 HTML（MD 原生不支持，且 Turndown 默认会丢 <u>）
  td.addRule("underline", {
    filter: ["u"] as any,
    replacement: (content) => `<u>${content}</u>`,
  });

  /**
   * 行内字号 / 前景色：Tiptap 的 TextStyle + Color + FontSize 会渲染成
   *   <span style="font-size:20px;color:#ef4444">…</span>
   * Markdown 原生没有字号/前景色语法。Turndown 默认会丢掉 <span> 标签，
   * 用户切到 MD 编辑器或导出 .md 后颜色/字号就消失了。
   *
   * 折中：CommonMark 允许 inline HTML，因此把这种 span **原样保留**为
   * inline HTML。下游 markdownToHtml(@lezer/markdown) 遇到 `<span>` 会作为
   * HTMLTag 透传，generateJSON 时 TextStyleKit 又能从 style 还原属性，
   * 实现 RTE → MD → RTE 的颜色/字号无损往返。
   *
   * 安全考量：只透传 font-size / color / background-color 三个属性，
   * 其它 style 一律丢弃，避免 onclick / expression() 等注入。
   */
  td.addRule("inlineTextStyle", {
    filter: (node) => {
      if (node.nodeName !== "SPAN") return false;
      const el = node as HTMLElement;
      const style = el.getAttribute("style") || "";
      return /font-size\s*:|(?<!background-)color\s*:/i.test(style);
    },
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const style = el.getAttribute("style") || "";
      const safe: string[] = [];
      const fs = style.match(/(?:^|;)\s*font-size\s*:\s*([^;]+)/i)?.[1]?.trim();
      const fg = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1]?.trim();
      if (fs) safe.push(`font-size:${fs}`);
      if (fg) safe.push(`color:${fg}`);
      if (!safe.length) return content;
      const escaped = safe.join(";").replace(/"/g, "&quot;");
      return `<span style="${escaped}">${content}</span>`;
    },
  });

  /**
   * 段落 / 标题的 TextAlign：
   *   Tiptap 的 TextAlign 扩展会在 <p> / <h1-3> 上渲染 style="text-align:center|right|justify"。
   *   Markdown 没有原生对齐语法；如果完全按默认规则 turndown 会把 style 丢掉。
   *   为了让 RTE→MD→RTE 回路能无损保留对齐，这里把带对齐的段落/标题"用 HTML 包一层"
   *   重新输出：
   *     - 标题：<h2 style="text-align:center">foo</h2>  —— Tiptap 的 HTML parser 会直接识别
   *     - 段落：<p style="text-align:center">foo</p>
   *   MD 渲染器（我们自己的 @lezer 解析 + markdownToHtml）遇到块级 HTML 会原样输出，
   *   Tiptap generateJSON 再解析时能恢复 textAlign 属性。
   *
   *   对齐值为 'left' 或为空时视作默认，不做任何包装（避免 MD 里全是 HTML 噪音）。
   */
  const alignOf = (node: Element): string => {
    const style = node.getAttribute("style") || "";
    const m = style.match(/text-align:\s*([a-z]+)/i);
    const v = (m?.[1] || "").toLowerCase();
    if (v === "center" || v === "right" || v === "justify") return v;
    return "";
  };

  td.addRule("alignedParagraph", {
    filter: (node) => {
      if (node.nodeName !== "P") return false;
      return !!alignOf(node as Element);
    },
    replacement: (content, node) => {
      const align = alignOf(node as Element);
      const inner = content.replace(/^\n+|\n+$/g, "");
      // 用块级 HTML 形式保留对齐；前后空行保证被 MD 解析器当作块级 HTML 而不是行内
      return `\n\n<p style="text-align:${align}">${inner}</p>\n\n`;
    },
  });

  td.addRule("alignedHeading", {
    filter: (node) => {
      if (!/^H[1-6]$/.test(node.nodeName)) return false;
      return !!alignOf(node as Element);
    },
    replacement: (content, node) => {
      const align = alignOf(node as Element);
      const tag = node.nodeName.toLowerCase();
      const inner = content.replace(/^\n+|\n+$/g, "");
      return `\n\n<${tag} style="text-align:${align}">${inner}</${tag}>\n\n`;
    },
  });

  /**
   * 数学公式：把 Tiptap 输出的 `<span data-math-inline data-latex="x^2">` 和
   * `<div data-math-block data-latex="\int_0^1 x\\,dx">` 转回 Markdown 的
   * `$x^2$` / `$$\int_0^1 x\,dx$$`。
   *
   * 关键点：
   *   - Turndown 默认会把这两种节点当成 inline/block HTML 处理，丢内容；
   *     必须显式 filter 它们，从 data-latex 属性取源码并按 MD 语法吐出。
   *   - 块级公式前后包两个换行确保被 MD 解析器当独立块（避免被并到上一段）。
   *   - 行内公式两侧加单空格防止被前后字符黏住影响识别；如果前后已经是空白
   *     字符 Turndown 在拼接时不会重复加。
   */
  td.addRule("mathInline", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node as Element).getAttribute("data-math-inline") != null,
    replacement: (_content, node) => {
      const latex = (node as Element).getAttribute("data-latex") || "";
      if (!latex) return "";
      return `$${latex}$`;
    },
  });

  td.addRule("mathBlock", {
    filter: (node) =>
      node.nodeName === "DIV" &&
      (node as Element).getAttribute("data-math-block") != null,
    replacement: (_content, node) => {
      const latex = (node as Element).getAttribute("data-latex") || "";
      if (!latex) return "";
      return `\n\n$$\n${latex}\n$$\n\n`;
    },
  });

  /**
   * 脚注引用：Tiptap 输出 `<sup data-footnote-ref="id" data-footnote-identifier="id">[^id]</sup>`
   * 反向为 `[^id]`。注意：renderHTML 已经把 `[^id]` 写进 textContent，所以
   * Turndown 默认会把这段文字原样输出（外面再加一层 sup 标签的话也会被默认
   * 规则处理）。这里显式 filter 接管，避免出双重 `[^id]` 或残留 `<sup>` 包装。
   */
  td.addRule("footnoteRef", {
    filter: (node) => {
      if (node.nodeName !== "SUP" && node.nodeName !== "SPAN") return false;
      return (node as Element).getAttribute("data-footnote-ref") != null;
    },
    replacement: (_content, node) => {
      const el = node as Element;
      const id =
        el.getAttribute("data-footnote-identifier") ||
        el.getAttribute("data-footnote-ref") ||
        "";
      if (!id) return "";
      return `[^${id}]`;
    },
  });

  /**
   * 脚注定义：Tiptap 输出 `<div data-footnote-def="id" data-footnote-identifier="id"
   * data-footnote-content="...">[^id]: content</div>`。反向为 `[^id]: content`。
   * 块级输出，前后空行保证被 MD 当作独立块。
   */
  td.addRule("footnoteDef", {
    filter: (node) =>
      node.nodeName === "DIV" &&
      (node as Element).getAttribute("data-footnote-def") != null,
    replacement: (_content, node) => {
      const el = node as Element;
      const id =
        el.getAttribute("data-footnote-identifier") ||
        el.getAttribute("data-footnote-def") ||
        "";
      const content = el.getAttribute("data-footnote-content") || "";
      if (!id) return "";
      // content 中的换行折成 markdown 的「续行缩进」（4 空格），符合 Pandoc 写法
      const escapedContent = content.replace(/\n/g, "\n    ");
      return `\n\n[^${id}]: ${escapedContent}\n\n`;
    },
  });

  /**
   * 视频节点：Tiptap renderHTML 输出
   *   <div data-video-platform="..." data-kind="..." data-src="..." data-original-url="...">
   *     <iframe|video src="..." .../>
   *   </div>
   * Turndown 默认会递归处理该 div 并丢掉所有子节点。
   * 这里接管：当检测到 data-video-platform 时，调 videoNodeToMarkdown 产出
   *   - HTML 块（支持原样播放）
   *   - + 一行 [🎬 视频链接](url) 兼容不能渲染 HTML 的 MD 场景
   * 返回的块前后带空行，MD 解析器会当作独立块级 HTML 处理。
   */
  td.addRule("videoEmbed", {
    filter: (node) =>
      node.nodeName === "DIV" &&
      (node as Element).getAttribute("data-video-platform") != null,
    replacement: (_content, node) => {
      const el = node as Element;
      return videoNodeToMarkdown({
        src: el.getAttribute("data-src") || "",
        kind: (el.getAttribute("data-kind") as any) || "iframe",
        platform: (el.getAttribute("data-video-platform") as any) || "unknown",
        originalUrl: el.getAttribute("data-original-url") || "",
      });
    },
  });

  _turndown = td;
  return td;
}

/**
 * Tiptap JSON 字符串 -> Markdown
 * 转换链路：JSON -> (generateHTML) -> HTML -> (turndown) -> MD
 * 失败时返回空串。
 */
export function tiptapJsonToMarkdown(jsonOrString: unknown): string {
  try {
    const json =
      typeof jsonOrString === "string" ? JSON.parse(jsonOrString) : jsonOrString;
    if (!json || typeof json !== "object") return "";
    const html = generateHTML(json as any, getTiptapExtensions());
    if (!html) return "";
    return getTurndown().turndown(html).trim();
  } catch (err) {
    console.warn("[contentFormat] tiptapJsonToMarkdown failed:", err);
    return "";
  }
}

/**
 * 把任意格式的 note.content 规范化为 Markdown。
 * MD 编辑器在**打开**笔记时调用；打开后用户编辑保存的就是纯 MD。
 *
 * - md        -> 原样返回
 * - tiptap-json -> 走 tiptapJsonToMarkdown
 * - html      -> 用 Turndown 直接转（极少见路径）
 * - empty     -> 空串
 */
export function normalizeToMarkdown(
  content: string | null | undefined,
  fallbackText?: string
): string {
  const fmt = detectFormat(content);
  switch (fmt) {
    case "empty":
      return "";
    case "md":
      return content as string;
    case "tiptap-json": {
      const md = tiptapJsonToMarkdown(content as string);
      // 转换结果为空但原内容有文本时，优雅降级为 contentText
      if (!md && fallbackText) return fallbackText;
      return md;
    }
    case "html": {
      try {
        return getTurndown().turndown(content as string).trim();
      } catch {
        return fallbackText || "";
      }
    }
  }
}

/**
 * 从 Markdown 提取纯文本（用于写入 note.contentText，供全文搜索 / 摘要显示使用）。
 *
 * 规则（简化版，不依赖完整的 MD 解析器，保持性能）：
 *   - 去掉代码围栏 ``` 及其内部（搜索不索引代码块）
 *   - 去掉行内代码反引号
 *   - 去掉 #、>、*、_、~ 等标记
 *   - 去掉图片 ![alt](url) 只保留 alt
 *   - 去掉链接 [text](url) 只保留 text
 *   - 去掉 HTML 标签
 *   - 合并多余空白
 */
export function markdownToPlainText(md: string): string {
  if (!md) return "";
  let text = md;

  // 围栏代码块
  text = text.replace(/```[\s\S]*?```/g, "");
  // 行内代码
  text = text.replace(/`([^`]+)`/g, "$1");
  // 图片
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // 链接
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // HTML 标签（含 <span style="color/font-size"> 这类 inline 样式包装：
  // 仅剥标签，保留内部文字，避免全文搜索因为外观格式而漏命中）
  text = text.replace(/<[^>]+>/g, "");
  // 标题井号、引用符号、列表标记
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  // 行内格式标记
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/_([^_]+)_/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  text = text.replace(/==([^=]+)==/g, "$1");
  // 水平线
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, "");
  // 表格分隔
  text = text.replace(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/gm, "");
  // 脚注：定义行 `[^id]: 内容` → 保留内容文本；引用 `[^id]` → 去掉
  // 全文搜索语义化更合理（脚注内容应该可被搜到，引用标记本身不重要）
  text = text.replace(/^\[\^[A-Za-z0-9_-]+\]:\s?/gm, "");
  text = text.replace(/\[\^[A-Za-z0-9_-]+\]/g, "");
  // 合并多余空白
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// ---------- Markdown → HTML / Tiptap JSON（MD → 富文本 回路） ----------
//
// 作用：
//   当用户在 MD 编辑器保存了纯 Markdown，后又切到 Tiptap 时，需要把 MD
//   "还原"为富文本可解析的结构。之前 TiptapEditor 里的 `parseContent`
//   对非 JSON、非 HTML 字符串只会塞进一个段落，导致标题/列表/代码块等
//   结构全部塌缩，表现为"切到富文本后修改的内容丢失"（实际是渲染前就已失去结构）。
//
// 实现思路：
//   1. 用 @lezer/markdown + GFM 扩展把 MD 解析成语法树
//   2. 遍历语法树递归渲染成 HTML 字符串
//   3. 把 HTML 交给 Tiptap 的 generateJSON（已在上面配好的 extensions）
//      → 产出标准 ProseMirror JSON
//
// 范围：
//   覆盖 StarterKit + 我们自定义的所有节点（含 GFM 表格/任务列表/删除线）。
//   不支持的边缘语法直接以原文 escape 后落入段落，不会崩。

/**
 * 获取共享的 lezer-markdown GFM parser（惰性）
 */
let _mdParser: ReturnType<typeof baseMdParser.configure> | null = null;
function getMdParser() {
  if (_mdParser) return _mdParser;
  _mdParser = baseMdParser.configure([GFM]);
  return _mdParser;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(str: string): string {
  return str.replace(/"/g, "&quot;").replace(/\n/g, " ");
}

/**
 * 取某节点在原文里覆盖的文本
 */
function sliceText(src: string, node: { from: number; to: number }): string {
  return src.slice(node.from, node.to);
}

/**
 * 取节点的"有效子节点"（跳过 mark 类）
 */
function childrenOf(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  let c = node.firstChild;
  while (c) {
    out.push(c);
    c = c.nextSibling;
  }
  return out;
}

/**
 * 判断是否为"标记"类节点（不参与文本渲染，如 `**` / `#` / `>` / `` ` `` 等）
 */
function isMarkNode(name: string): boolean {
  return (
    name === "HeaderMark" ||
    name === "EmphasisMark" ||
    name === "CodeMark" ||
    name === "LinkMark" ||
    name === "ListMark" ||
    name === "QuoteMark" ||
    name === "URL" ||
    name === "LinkLabel" ||
    name === "LinkTitle" ||
    name === "CodeInfo" ||
    name === "TaskMarker" ||
    name === "TableDelimiter" ||
    // GFM Strikethrough 的 `~~` 标记节点名（@lezer/markdown GFM 扩展）
    name === "StrikethroughMark"
  );
}

/**
 * 渲染 inline 节点序列为 HTML 片段
 *
 * 策略：
 *   - 把所有直接子节点（含 HeaderMark / EmphasisMark 等 mark 类）纳入
 *     "已覆盖区间"，mark 区间跳过不输出（`**` / `#` 只是语法标记，不是内容）；
 *   - 非 mark 的 child 走 renderInlineNode 产出 HTML；
 *   - 区间之外的"gap"（通常只是空格）作为普通文本转义输出。
 *
 * 关键修正：以前用"已过滤掉 mark 的 child 列表"来推游标，会把 mark 节点覆盖
 * 的 `**` / `# ` 原文当成 gap escapeHtml 出来，表现为：
 *   "# H1"  → "<h1># H1</h1>"      （# 漏出）
 *   "**bold**" → "<strong>**bold**</strong>" （** 漏出）
 */
function renderInlineChildren(src: string, parent: SyntaxNode): string {
  const allKids = childrenOf(parent);
  let out = "";
  let cursor = parent.from;
  for (const child of allKids) {
    if (child.from > cursor) {
      out += escapeHtml(src.slice(cursor, child.from));
    }
    if (isMarkNode(child.name)) {
      // 跳过标记符（`**`、`#`、`` ` `` 等），不输出
    } else {
      out += renderInlineNode(src, child);
    }
    cursor = child.to;
  }
  if (cursor < parent.to) {
    out += escapeHtml(src.slice(cursor, parent.to));
  }
  return out;
}

function renderInlineNode(src: string, node: SyntaxNode): string {
  const name = node.name;
  switch (name) {
    case "Emphasis":
      return `<em>${renderInlineChildren(src, node)}</em>`;
    case "StrongEmphasis":
      return `<strong>${renderInlineChildren(src, node)}</strong>`;
    case "Strikethrough":
      return `<s>${renderInlineChildren(src, node)}</s>`;
    case "InlineCode": {
      // 去掉首尾的反引号；lezer 里 InlineCode 包含 CodeMark 子节点
      // 这里直接提取中间的代码文本
      const inner = extractInlineCodeText(src, node);
      return `<code>${escapeHtml(inner)}</code>`;
    }
    case "Link": {
      // 结构：Link [ LinkMark "[" , inline... , LinkMark "]" , LinkMark "(", URL, LinkMark ")" ]
      const url = findChildText(src, node, "URL");
      const inner = renderInlineChildren(src, node);
      if (!url) return inner;
      return `<a href="${escapeAttr(url)}">${inner}</a>`;
    }
    case "Image": {
      // 结构：Image [ "!", "[", alt..., "]", "(", URL, ")" ]
      const url = findChildText(src, node, "URL");
      const alt = extractImageAlt(src, node);
      if (!url) return escapeHtml(sliceText(src, node));
      return `<img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}">`;
    }
    case "Autolink":
    case "URL": {
      const text = sliceText(src, node).replace(/^[<]|[>]$/g, "");
      return `<a href="${escapeAttr(text)}">${escapeHtml(text)}</a>`;
    }
    case "HardBreak":
      return "<br>";
    case "HTMLTag":
    case "HTMLBlock":
      // 原样输出 HTML 片段（让 Tiptap 自己决定如何 parse）
      return sliceText(src, node);
    case "Entity":
      return sliceText(src, node);
    default:
      // 兜底：含子节点则递归，否则作为纯文本 escape
      if (node.firstChild) return renderInlineChildren(src, node);
      return escapeHtml(sliceText(src, node));
  }
}

function extractInlineCodeText(src: string, node: SyntaxNode): string {
  // lezer InlineCode 通常含两个 CodeMark（前后反引号），中间是 text
  const marks: SyntaxNode[] = [];
  let c = node.firstChild;
  while (c) {
    if (c.name === "CodeMark") marks.push(c);
    c = c.nextSibling;
  }
  if (marks.length >= 2) {
    const start = marks[0].to;
    const end = marks[marks.length - 1].from;
    return src.slice(start, end);
  }
  // 没有 mark 子节点就裸取
  return sliceText(src, node).replace(/^`+|`+$/g, "");
}

function extractImageAlt(src: string, node: SyntaxNode): string {
  // Image 子节点模式：? LinkMark("!") LinkMark("[") <inline...> LinkMark("]") LinkMark("(") URL LinkMark(")")
  // alt 就是在第一个 "[" 与对应 "]" 之间的原文
  const kids = childrenOf(node);
  const openIdx = kids.findIndex(
    (k) => k.name === "LinkMark" && sliceText(src, k) === "["
  );
  const closeIdx = kids.findIndex(
    (k, i) => i > openIdx && k.name === "LinkMark" && sliceText(src, k) === "]"
  );
  if (openIdx >= 0 && closeIdx > openIdx) {
    return src.slice(kids[openIdx].to, kids[closeIdx].from);
  }
  return "";
}

function findChildText(
  src: string,
  node: SyntaxNode,
  childName: string
): string | null {
  let c = node.firstChild;
  while (c) {
    if (c.name === childName) return sliceText(src, c).trim();
    c = c.nextSibling;
  }
  return null;
}

/**
 * 渲染块级节点为 HTML
 */
function renderBlock(src: string, node: SyntaxNode): string {
  const name = node.name;

  // 标题
  const atx = name.match(/^ATXHeading([1-6])$/);
  if (atx) {
    const level = parseInt(atx[1], 10);
    // heading 的 child 里除了 HeaderMark 都是 inline
    // 但 HeaderMark 可能在首尾（`### foo ###`）
    const inner = renderInlineChildren(src, node).trim();
    return `<h${level}>${inner}</h${level}>`;
  }
  const setext = name.match(/^SetextHeading([1-2])$/);
  if (setext) {
    const level = parseInt(setext[1], 10);
    const inner = renderInlineChildren(src, node).trim();
    return `<h${level}>${inner}</h${level}>`;
  }

  switch (name) {
    case "Paragraph":
      return `<p>${renderInlineChildren(src, node)}</p>`;

    case "Blockquote": {
      const inner = childrenOf(node)
        .filter((c) => !isMarkNode(c.name))
        .map((c) => renderBlock(src, c))
        .join("");
      return `<blockquote>${inner}</blockquote>`;
    }

    case "BulletList":
    case "OrderedList": {
      const items = childrenOf(node).filter((c) => c.name === "ListItem");
      // GFM 任务列表：ListItem 下的第一个 Paragraph 第一 child 可能是 Task
      const isTaskList = items.length > 0 && items.every((it) => hasTask(it));
      if (isTaskList) {
        const lis = items.map((it) => renderTaskItem(src, it)).join("");
        return `<ul data-type="taskList">${lis}</ul>`;
      }
      const tag = name === "BulletList" ? "ul" : "ol";
      const lis = items.map((it) => renderListItem(src, it)).join("");
      // 有序列表的起始编号
      if (tag === "ol") {
        const first = items[0];
        if (first) {
          const markerMatch = src.slice(first.from, first.to).match(/^\s*(\d+)/);
          if (markerMatch) {
            const start = parseInt(markerMatch[1], 10);
            if (start !== 1) return `<ol start="${start}">${lis}</ol>`;
          }
        }
      }
      return `<${tag}>${lis}</${tag}>`;
    }

    case "FencedCode":
    case "CodeBlock": {
      const info = findChildText(src, node, "CodeInfo") || "";
      const code = extractCodeText(src, node);
      const langAttr = info ? ` class="language-${escapeAttr(info)}"` : "";
      return `<pre><code${langAttr}>${escapeHtml(code)}</code></pre>`;
    }

    case "HorizontalRule":
      return "<hr>";

    case "HTMLBlock":
      return sliceText(src, node);

    case "Table":
      return renderTable(src, node);

    default:
      // 兜底：作为段落输出，escape 原文
      return `<p>${escapeHtml(sliceText(src, node))}</p>`;
  }
}

function hasTask(listItem: SyntaxNode): boolean {
  // ListItem → Paragraph → Task (GFM)
  let c = listItem.firstChild;
  while (c) {
    if (c.name === "Task") return true;
    if (c.name === "Paragraph") {
      let cc = c.firstChild;
      while (cc) {
        if (cc.name === "Task") return true;
        cc = cc.nextSibling;
      }
    }
    c = c.nextSibling;
  }
  return false;
}

function renderListItem(src: string, item: SyntaxNode): string {
  const inner = childrenOf(item)
    .filter((c) => !isMarkNode(c.name))
    .map((c) => {
      // 行内内容以 Paragraph 包着就直接渲染段落；若是嵌套 List 就递归 block
      if (
        c.name === "BulletList" ||
        c.name === "OrderedList" ||
        c.name === "Blockquote" ||
        c.name === "FencedCode" ||
        c.name === "CodeBlock"
      ) {
        return renderBlock(src, c);
      }
      if (c.name === "Paragraph") {
        return `<p>${renderInlineChildren(src, c)}</p>`;
      }
      return renderBlock(src, c);
    })
    .join("");
  return `<li>${inner}</li>`;
}

function renderTaskItem(src: string, item: SyntaxNode): string {
  // 找到 Task 节点，判断 [x] 还是 [ ]
  let checked = false;
  let taskNode: SyntaxNode | null = null;
  let c = item.firstChild;
  while (c && !taskNode) {
    if (c.name === "Task") taskNode = c;
    else if (c.name === "Paragraph") {
      let cc = c.firstChild;
      while (cc && !taskNode) {
        if (cc.name === "Task") taskNode = cc;
        cc = cc.nextSibling;
      }
    }
    c = c.nextSibling;
  }
  if (taskNode) {
    const text = sliceText(src, taskNode);
    checked = /\[[xX]\]/.test(text);
  }

  // 渲染 item 内容（去掉 Task 节点本身）
  const inner = childrenOf(item)
    .filter((c) => !isMarkNode(c.name))
    .map((c) => {
      if (c.name === "Paragraph") {
        // 跳过 Task 子节点
        let html = "";
        let cursor = c.from;
        let cc = c.firstChild;
        while (cc) {
          if (cc.from > cursor) {
            html += escapeHtml(src.slice(cursor, cc.from));
          }
          if (cc.name === "Task") {
            // 跳过
          } else if (!isMarkNode(cc.name)) {
            html += renderInlineNode(src, cc);
          }
          cursor = cc.to;
          cc = cc.nextSibling;
        }
        if (cursor < c.to) {
          html += escapeHtml(src.slice(cursor, c.to));
        }
        return `<p>${html.trim()}</p>`;
      }
      return renderBlock(src, c);
    })
    .join("");

  return `<li data-type="taskItem" data-checked="${checked}">${inner}</li>`;
}

function extractCodeText(src: string, node: SyntaxNode): string {
  // 找 CodeText 子节点；若没有就去掉首尾的 ``` 围栏
  let c = node.firstChild;
  const parts: string[] = [];
  while (c) {
    if (c.name === "CodeText") parts.push(sliceText(src, c));
    c = c.nextSibling;
  }
  if (parts.length > 0) return parts.join("");
  // 兜底：剥围栏
  const raw = sliceText(src, node);
  return raw.replace(/^```[^\n]*\n?/, "").replace(/```\s*$/, "");
}

function renderTable(src: string, node: SyntaxNode): string {
  // GFM Table 结构：
  //   Table
  //     TableHeader
  //       TableRow → TableCell*
  //     TableDelimiter
  //     TableRow*
  //       TableCell*
  let header: SyntaxNode | null = null;
  const rows: SyntaxNode[] = [];
  let c = node.firstChild;
  while (c) {
    if (c.name === "TableHeader") header = c;
    else if (c.name === "TableRow") rows.push(c);
    c = c.nextSibling;
  }

  const renderRow = (row: SyntaxNode, tag: "th" | "td") => {
    const cells: string[] = [];
    let cc = row.firstChild;
    while (cc) {
      if (cc.name === "TableCell") {
        cells.push(`<${tag}>${renderInlineChildren(src, cc)}</${tag}>`);
      }
      cc = cc.nextSibling;
    }
    return `<tr>${cells.join("")}</tr>`;
  };

  let html = "<table>";
  if (header) {
    // TableHeader 下可能就是一堆 TableCell 直接挂着（lezer 实现差异），
    // 这里兼容两种：先试找 TableRow，没有就把 header 自己当 row
    const headerRow = (() => {
      let cc = header.firstChild;
      while (cc) {
        if (cc.name === "TableRow") return cc;
        cc = cc.nextSibling;
      }
      return header;
    })();
    html += `<thead>${renderRow(headerRow, "th")}</thead>`;
  }
  if (rows.length) {
    html += "<tbody>";
    for (const r of rows) html += renderRow(r, "td");
    html += "</tbody>";
  }
  html += "</table>";
  return html;
}

/**
 * Markdown 字符串 → HTML 字符串
 *
 * 依赖 @lezer/markdown + GFM，覆盖所有 StarterKit 支持的语法。
 * 出现任意异常时兜底为 `<p>…</p>`，保证不会整段丢内容。
 *
 * 数学公式处理：lezer/markdown 不识别 `$...$` / `$$...$$`，会把它们当成
 * 普通文本，导致下游 generateJSON 时丢失公式语义。这里在解析前先把所有
 * 公式段提取出来用占位符替换，渲染完 HTML 再回填为 `<span data-math-inline>`
 * 或 `<div data-math-block>`，让 Tiptap 的 MathInline/MathBlock parseHTML
 * 能识别。占位符用 NUL 字符 + 自增 id，保证不会与正文冲突。
 */
function extractMathPlaceholders(md: string): {
  text: string;
  blocks: string[];
  inlines: string[];
} {
  const blocks: string[] = [];
  const inlines: string[] = [];

  // 先抽块级 `$$...$$`（支持跨行；非贪婪；要求两侧都是 `$$`）
  // 注意：必须先于 inline，否则 `$$x$$` 会被 inline 规则错切。
  let text = md.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body) => {
    const idx = blocks.push(body.trim()) - 1;
    return `\u0000MATHBLOCK${idx}\u0000`;
  });

  // 再抽行内 `$...$`：
  //   - 内部不能含 `$` 或换行
  //   - 前一个字符不是 `\`（避免 `\$` 转义美元符）
  //   - 前后边界：左侧不是数字或字母（避免 `a$b$c` 这种货币写法误判过宽，但
  //     公式场景里通常会有空白；放宽则可能误伤金额，权衡下选择保守边界）
  //   - 这种正则不能 100% 完美（KaTeX 自己的判断同样基于启发式），覆盖绝大多
  //     数日常场景即可
  text = text.replace(
    /(^|[^\\$\w])\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$(?=$|[^\w$])/g,
    (_m, pre, body) => {
      const idx = inlines.push(body) - 1;
      return `${pre}\u0000MATHINLINE${idx}\u0000`;
    }
  );

  return { text, blocks, inlines };
}

function restoreMathPlaceholders(
  html: string,
  blocks: string[],
  inlines: string[]
): string {
  // 行内：放到 <span data-math-inline data-latex="...">，文本内容不重要，
  // Tiptap parseHTML 会优先读 data-latex
  let out = html.replace(/\u0000MATHINLINE(\d+)\u0000/g, (_m, idx) => {
    const latex = inlines[Number(idx)] || "";
    const enc = escapeAttr(latex);
    return `<span data-math-inline="true" data-latex="${enc}">$${escapeHtml(latex)}$</span>`;
  });
  // 块级：放到 <div data-math-block>，外面通常被 renderBlock 包了 <p>，
  // 这里需要把"包着公式占位的段落"剥掉 <p>，否则 Tiptap parseHTML 会把
  // mathBlock 嵌进段落（block-in-inline）而被丢弃。
  out = out.replace(
    /<p>\s*\u0000MATHBLOCK(\d+)\u0000\s*<\/p>/g,
    (_m, idx) => {
      const latex = blocks[Number(idx)] || "";
      const enc = escapeAttr(latex);
      return `<div data-math-block="true" data-latex="${enc}">$$${escapeHtml(latex)}$$</div>`;
    }
  );
  // 兜底：如果块级占位没被段落包住（例如出现在表格里）
  out = out.replace(/\u0000MATHBLOCK(\d+)\u0000/g, (_m, idx) => {
    const latex = blocks[Number(idx)] || "";
    const enc = escapeAttr(latex);
    return `<div data-math-block="true" data-latex="${enc}">$$${escapeHtml(latex)}$$</div>`;
  });
  return out;
}

/**
 * 脚注预处理：lezer/markdown 不识别 GFM/Pandoc 风格的 `[^id]` 引用与
 * `[^id]: ...` 定义，会把它们整段当普通文本。我们在 lezer 解析前先把：
 *   - 行首 `[^id]: 内容` 抽走（支持续行缩进），放到 defs 数组
 *   - 行内 `[^id]` 换成占位符，放到 refs 数组
 *
 * 占位策略：与 math 一致，用 NUL + 自增 id，避免与正文冲突。最后再把占位
 * 还原成 `<sup data-footnote-ref>` / `<div data-footnote-def>` HTML。
 *
 * 兼容性：在围栏代码块 / 行内代码内不识别脚注，避免代码示例里的 `[^x]`
 * 被误识别（lezer 解析 fenced code 时会把整段当 code，但我们这里在解析前
 * 做替换，无法依赖 lezer 的边界，需要手动跳过 fenced code）。
 */
function extractFootnotePlaceholders(md: string): {
  text: string;
  refs: string[];
  defs: Array<{ id: string; content: string }>;
} {
  const refs: string[] = [];
  const defs: Array<{ id: string; content: string }> = [];

  // Step 1: 把围栏代码块抠出来用占位保存，处理完脚注再还原。
  // 避免代码示例里的 `[^x]` 被误识别。
  const codeStash: string[] = [];
  let text = md.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => {
    const idx = codeStash.push(m) - 1;
    return `\u0000FNCODE${idx}\u0000`;
  });

  // Step 2: 抽脚注 *定义*。
  // 格式：`[^id]: 内容`（行首），后续以 4 空格缩进的行属于同一脚注内容。
  // 我们按行扫描，发现一行匹配 `^\[\^id\]:` 就开始收集后续缩进续行。
  const lines = text.split("\n");
  const outLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\[\^([A-Za-z0-9_-]+)\]:\s?(.*)$/);
    if (m) {
      const id = m[1];
      const parts: string[] = [m[2] || ""];
      // 收集续行：以 4 空格 / 1 tab 开头的非空行视为续行
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        if (/^(\s{4}|\t)/.test(nxt)) {
          parts.push(nxt.replace(/^(\s{4}|\t)/, ""));
          j++;
        } else if (nxt.trim() === "") {
          // 空行不算结束，下一行如果还是缩进就继续；否则结束
          if (j + 1 < lines.length && /^(\s{4}|\t)/.test(lines[j + 1])) {
            parts.push("");
            j++;
          } else {
            break;
          }
        } else {
          break;
        }
      }
      const content = parts.join("\n").trim();
      const idx = defs.push({ id, content }) - 1;
      // 用块级占位符占一整行，避免被合到上下文段落里
      outLines.push(`\u0000FNDEF${idx}\u0000`);
      i = j - 1;
    } else {
      outLines.push(line);
    }
  }
  text = outLines.join("\n");

  // Step 3: 抽脚注 *引用* `[^id]`。
  // 行内代码块也要避开：先用占位把行内代码段保护起来
  const inlineCodeStash: string[] = [];
  text = text.replace(/`[^`\n]+`/g, (m) => {
    const idx = inlineCodeStash.push(m) - 1;
    return `\u0000FNICODE${idx}\u0000`;
  });

  text = text.replace(/\[\^([A-Za-z0-9_-]+)\]/g, (_m, id) => {
    const idx = refs.push(id) - 1;
    return `\u0000FNREF${idx}\u0000`;
  });

  // 还原行内代码
  text = text.replace(/\u0000FNICODE(\d+)\u0000/g, (_m, idx) => inlineCodeStash[Number(idx)] || "");

  // 还原围栏代码块
  text = text.replace(/\u0000FNCODE(\d+)\u0000/g, (_m, idx) => codeStash[Number(idx)] || "");

  return { text, refs, defs };
}

function restoreFootnotePlaceholders(
  html: string,
  refs: string[],
  defs: Array<{ id: string; content: string }>
): string {
  // 引用：换成 <sup data-footnote-ref="id" data-footnote-identifier="id">[^id]</sup>
  let out = html.replace(/\u0000FNREF(\d+)\u0000/g, (_m, idx) => {
    const id = refs[Number(idx)] || "";
    if (!id) return "";
    const enc = escapeAttr(id);
    return `<sup data-footnote-ref="${enc}" data-footnote-identifier="${enc}">[^${escapeHtml(id)}]</sup>`;
  });
  // 定义：占位通常被 renderBlock 包了 <p>，需要剥掉 <p>，否则 Tiptap
  // parseHTML 会把 footnoteDefinition 嵌进段落而被丢弃。
  out = out.replace(/<p>\s*\u0000FNDEF(\d+)\u0000\s*<\/p>/g, (_m, idx) => {
    const def = defs[Number(idx)];
    if (!def) return "";
    const encId = escapeAttr(def.id);
    const encContent = escapeAttr(def.content);
    return `<div data-footnote-def="${encId}" data-footnote-identifier="${encId}" data-footnote-content="${encContent}">[^${escapeHtml(def.id)}]: ${escapeHtml(def.content)}</div>`;
  });
  // 兜底：未被段落包住的情况
  out = out.replace(/\u0000FNDEF(\d+)\u0000/g, (_m, idx) => {
    const def = defs[Number(idx)];
    if (!def) return "";
    const encId = escapeAttr(def.id);
    const encContent = escapeAttr(def.content);
    return `<div data-footnote-def="${encId}" data-footnote-identifier="${encId}" data-footnote-content="${encContent}">[^${escapeHtml(def.id)}]: ${escapeHtml(def.content)}</div>`;
  });
  return out;
}

export function markdownToHtml(md: string): string {
  if (!md) return "";
  try {
    // 第 1 步：抽离数学公式
    const { text: afterMath, blocks, inlines } = extractMathPlaceholders(md);
    // 第 2 步：抽离脚注（在 math 之后做，避免 `$..$` 内的 `[^x]` 被当成 ref）
    const { text: preprocessed, refs, defs } = extractFootnotePlaceholders(afterMath);

    const tree = getMdParser().parse(preprocessed);
    // Document 是根节点；它的直接子就是块级节点
    let out = "";
    const doc = tree.topNode;
    let c = doc.firstChild;
    while (c) {
      out += renderBlock(preprocessed, c);
      c = c.nextSibling;
    }
    const html = out || `<p>${escapeHtml(preprocessed)}</p>`;
    // 第 3 步：还原 math + footnote 占位
    return restoreFootnotePlaceholders(
      restoreMathPlaceholders(html, blocks, inlines),
      refs,
      defs
    );
  } catch (err) {
    console.warn("[contentFormat] markdownToHtml failed:", err);
    return `<p>${escapeHtml(md)}</p>`;
  }
}

/**
 * Markdown 字符串 → Tiptap ProseMirror JSON
 *
 * 链路：MD → HTML → Tiptap generateJSON（用和 Tiptap 编辑器完全一致的 extensions）
 */
export function markdownToTiptapJSON(md: string): any {
  const html = markdownToHtml(md);
  try {
    return generateJSON(html || "<p></p>", getTiptapExtensions());
  } catch (err) {
    console.warn("[contentFormat] markdownToTiptapJSON failed:", err);
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
}
