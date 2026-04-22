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

import { generateHTML, generateJSON } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { common, createLowlight } from "lowlight";
import TurndownService from "turndown";
import { parser as baseMdParser } from "@lezer/markdown";
import { GFM } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";

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

  // HTML 特征：以 `<tagname` 开头，且整体必须看起来像一个标签
  //   正确：<p>…   <div class="x">…   <br/>
  //   错误：<3 i love md   <= 5 items   < space
  // 之前只用 `<\w` 检测首字符 + 全局查 `<\/?\w+[\s>]`，后者会把
  // "<3 i love md" 里 " md" 部分误识为标签；这里改为只检查"开头是否
  // 紧挨 tagname（直到遇到空白 / >、/）"是否合法，再要求整串至少含
  // 一个完整标签（`<tag>` 或 `</tag>`），避免 heuristic 漂移。
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
    Image.configure({ inline: false, allowBase64: true }),
    CodeBlockLowlight.configure({ lowlight }),
    Underline,
    Highlight.configure({ multicolor: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    // TextAlign 必须与 TiptapEditor 的 extensions 对齐，否则 generateHTML 时
    // `textAlign` 属性会被 Tiptap schema 过滤掉 → Turndown 拿不到 style
    // → RTE→MD 时段落对齐被静默丢失。markdownToTiptapJSON 反向也靠它识别 align 属性。
    TextAlign.configure({ types: ["heading", "paragraph"] }),
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

  // 下划线保持 HTML（MD 原生不支持，且 Turndown 默认会丢 <u>）
  td.addRule("underline", {
    filter: ["u"] as any,
    replacement: (content) => `<u>${content}</u>`,
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
  // HTML 标签
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
 */
export function markdownToHtml(md: string): string {
  if (!md) return "";
  try {
    const tree = getMdParser().parse(md);
    // Document 是根节点；它的直接子就是块级节点
    let out = "";
    const doc = tree.topNode;
    let c = doc.firstChild;
    while (c) {
      out += renderBlock(md, c);
      c = c.nextSibling;
    }
    return out || `<p>${escapeHtml(md)}</p>`;
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
