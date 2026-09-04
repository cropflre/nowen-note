/**
 * Yuque 导出 markdown → Nowen 兼容 HTML（导入专用）。
 *
 * Yuque 网页端 /markdown 导出端点返回标准 Markdown（latexcode=true 时公式为
 * LaTeX 源码）。此处把 `$$...$$` / `$...$` 公式先提取为占位符，用 marked
 * 转 HTML 后回填为项目公式节点（<span data-math-inline> / <div data-math-block>），
 * 与前端 contentFormat.ts 的公式管线保持一致。
 */
import { marked } from "marked";
import { sanitizeForImport } from "./sanitizeHtml";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/** 提取 `$$...$$` / `$...$` 公式为 NUL 占位符（先块级后行内，防止 `$$x$$` 被行内规则切坏）。 */
function extractMathPlaceholders(md: string): {
  text: string;
  blocks: string[];
  inlines: string[];
} {
  const blocks: string[] = [];
  const inlines: string[] = [];

  let text = md.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body) => {
    const idx = blocks.push(body.trim()) - 1;
    return `\u0000MATHBLOCK${idx}\u0000`;
  });

  // 行内公式：Yuque导出允许 `$ c $`（内部带空格），故放宽为「不含 $ 与换行即可」。
  text = text.replace(
    /(^|[^\\$\w])\$([^$\n]+?)\$(?=$|[^\w$])/g,
    (_m, pre, body) => {
      const idx = inlines.push(body.trim()) - 1;
      return `${pre}\u0000MATHINLINE${idx}\u0000`;
    },
  );

  return { text, blocks, inlines };
}

function restoreMathPlaceholders(html: string, blocks: string[], inlines: string[]): string {
  let out = html.replace(/\u0000MATHINLINE(\d+)\u0000/g, (_m, idx) => {
    const latex = inlines[Number(idx)] || "";
    return `<span data-math-inline="true" data-latex="${escapeAttr(latex)}">$${escapeHtml(latex)}$</span>`;
  });
  out = out.replace(/\u0000MATHBLOCK(\d+)\u0000/g, (_m, idx) => {
    const latex = blocks[Number(idx)] || "";
    return `<div data-math-block="true" data-latex="${escapeAttr(latex)}">$${escapeHtml(latex)}$</div>`;
  });
  return out;
}

const CALLOUT_TYPES = new Set([
  "success", "warning", "danger", "info", "note", "tip", "error", "default",
]);

/**
 * Yuque导出的 Admonition 类型 → 本项目高亮块配色类型。
 * Yuque用 success/warning/danger/info/note/tip/error/default，
 * 本项目 CalloutView + CSS 只识别 gray/blue/cyan/green/yellow/orange/red/pink/purple，
 * 不映射会导致导入的高亮块没有任何底色（无匹配的 data-callout-type 规则）。
 */
const CALLOUT_TYPE_MAP: Record<string, string> = {
  success: "green",
  warning: "yellow",
  danger: "red",
  error: "pink",
  info: "blue",
  note: "blue",
  tip: "cyan",
  default: "gray",
};

/**
 * 提取 `:::type\n...\n:::` 高亮块（Yuque导出的 Admonition 容器）为占位符。
 * body 原样保留，回填时再单独走一遍 markdown→HTML。
 */
function extractCalloutPlaceholders(md: string): {
  text: string;
  callouts: Array<{ type: string; body: string }>;
} {
  const callouts: Array<{ type: string; body: string }> = [];
  const re = /^:::\s*([A-Za-z][\w-]*)\s*\n([\s\S]*?)\n:::\s*$/gm;
  const text = md.replace(re, (_m, type: string, body: string) => {
    const idx = callouts.length;
    const normalizedType = type.toLowerCase();
    callouts.push({
      type: CALLOUT_TYPES.has(normalizedType) ? normalizedType : "info",
      body,
    });
    return `\u0000CALLOUT${idx}\u0000`;
  });
  return { text, callouts };
}

function restoreCalloutPlaceholders(html: string, callouts: Array<{ type: string; body: string }>): string {
  return html.replace(/\u0000CALLOUT(\d+)\u0000/g, (_m, idx) => {
    const c = callouts[Number(idx)];
    if (!c) return "";
    // body 仍是 markdown，单独转换（公式/加粗变体同样处理，不递归 callout）
    const { text: bodyText, blocks, inlines } = extractMathPlaceholders(c.body);
    let bodyHtml: string;
    try {
      bodyHtml = marked.parse(normalizeBoldSyntax(bodyText), { gfm: true, breaks: false }) as string;
    } catch {
      bodyHtml = `<p>${escapeHtml(c.body)}</p>`;
    }
    bodyHtml = restoreMathPlaceholders(bodyHtml, blocks, inlines);
    const mappedType = CALLOUT_TYPE_MAP[c.type] || "gray";
    return `<div data-type="callout" data-callout-type="${escapeAttr(mappedType)}">${bodyHtml}</div>`;
  });
}

/**
 * 修正 Yuque 导出 markdown 的加粗/行内代码语法，使其能被本编辑器 ProseMirror schema 正确解析。
 *
 * 核心约束：本编辑器 schema 不允许 strong 与 code 互相嵌套/并存（任一方 excludes 另一方）。
 * 因此凡出现「加粗包裹行内代码」或「行内代码包裹加粗」（bold+code 共存）的情形，统一策略为：
 *   - 优先保留行内代码（`` `...` ``）；
 *   - 剥离加粗定界符 `**`，绝不在结果中残留 `**内容**`（否则导入会解析异常）。
 * 纯加粗（不含行内代码）保持不变，仍渲染为 <strong>。
 */
function normalizeBoldSyntax(md: string): string {
  let out = md;
  // 1) 行内代码包裹加粗：`**text**` → `text`（去掉加粗符号，保留 code）
  out = out.replace(/`\*\*([^*`\n]+)\*\*`/g, (_m, inner) => `\`${inner}\``);
  // 2) 加粗包裹行内代码：**...** 内部含反引号时，去掉 ** 仅保留 code（绝不留 **内容**）
  //    同时覆盖 **text `code` text** / ** `code` ** / **`code`** 等所有变体
  out = out.replace(/\*\*([^\n]*?)\*\*/g, (whole, inner: string) => {
    return inner.includes("`") ? inner : whole;
  });
  // 3) 纯加粗（无 code）closing ** 前有尾随空白 → 去尾随空白使 strong 合法
  out = out.replace(/\*\*([^*\n]+?)[ \t]+\*\*/g, (_m, inner) => `**${inner.trim()}**`);
  return out;
}

/** Yuque 导出 markdown → 可入库的通用 HTML（公式/高亮块保留、XSS 清洗）。 */
export function yuqueMarkdownToHtml(input: string): string {
  if (!input || typeof input !== "string") return "";

  const { text: mdWithoutCallouts, callouts } = extractCalloutPlaceholders(input);
  const { text, blocks, inlines } = extractMathPlaceholders(mdWithoutCallouts);
  let html: string;
  try {
    html = marked.parse(normalizeBoldSyntax(text), { gfm: true, breaks: false }) as string;
  } catch {
    html = `<p>${escapeHtml(input)}</p>`;
  }
  html = restoreMathPlaceholders(html, blocks, inlines);
  html = restoreCalloutPlaceholders(html, callouts);
  return sanitizeForImport(html);
}
