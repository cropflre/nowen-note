/**
 * HTML 安全清洗工具（前端）
 * ---------------------------------------------------------------------------
 * SEC-XSS-01-B：统一管理前端 HTML 清洗逻辑。
 *
 * 基于 DOMPurify（已安装 ^3.4.1），为不同场景提供分级清洗配置。
 *
 * 当前未直接接入渲染链路（本轮只做工具 + 后端 URL 导入清洗），后续 PR 将
 * 按以下分级接入：
 *
 *   sanitizeForImport  — URL 导入 / HTML 文件导入（入库前或渲染前）
 *   sanitizeForPaste   — 剪贴板粘贴（ProseMirror 解析前）
 *   sanitizeForShare   — 分享页渲染（dangerouslySetInnerHTML 前）
 *   sanitizeSvg        — SVG 附件预览（已有使用点，统一入口）
 */
import DOMPurify from "dompurify";

// ── 白名单标签 ──────────────────────────────────────────────────────────────

/** 基础富文本结构标签 */
const STRUCTURE_TAGS = [
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "code",
  "ul", "ol", "li", "hr",
  "div", "span", "section", "article",
  "details", "summary", "figure", "figcaption",
  "time", "address", "dl", "dt", "dd",
];

/** 内联格式标签 */
const INLINE_TAGS = [
  "a", "strong", "em", "b", "i", "u", "s", "sub", "sup",
  "mark", "small", "abbr", "del", "ins", "kbd", "var", "samp",
];

/** 媒体标签 */
const MEDIA_TAGS = ["img", "video", "source", "audio", "picture"];

/** 表格标签 */
const TABLE_TAGS = ["table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col"];

/** 所有允许的标签 */
const ALLOWED_TAGS = [...STRUCTURE_TAGS, ...INLINE_TAGS, ...MEDIA_TAGS, ...TABLE_TAGS];

// ── 白名单属性 ──────────────────────────────────────────────────────────────

const ALLOWED_ATTR = [
  // 通用
  "class", "id", "dir", "lang", "title",
  // 链接
  "href", "target", "rel", "name",
  // 图片
  "src", "alt", "width", "height", "style", "loading", "referrerpolicy",
  // 视频
  "controls", "preload", "poster",
  // 表格
  "colspan", "rowspan", "scope",
  // 引用
  "cite",
  // 代码
  "type",
  // 时间
  "datetime",
];

// ── 协议白名单 ──────────────────────────────────────────────────────────────

/** 允许的 URI 协议 */
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|note):|\/api\/attachments\/|data:image\/)/i;

// ── DOMPurify 配置 ──────────────────────────────────────────────────────────

interface SanitizeConfig {
  ALLOWED_TAGS: string[];
  ALLOWED_ATTR: string[];
  ALLOW_DATA_ATTR: boolean;
  ALLOWED_URI_REGEXP: RegExp;
  ADD_ATTR?: string[];
  FORBID_TAGS?: string[];
  FORBID_ATTR?: string[];
}

/** 通用基础配置 */
const BASE_CONFIG: SanitizeConfig = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_DATA_ATTR: true,
  ALLOWED_URI_REGEXP,
};

// ── 清洗函数 ────────────────────────────────────────────────────────────────

/**
 * 清洗外部导入的 HTML 内容（URL 导入、HTML 文件导入）。
 * 最严格的配置，仅保留白名单标签和属性。
 */
export function sanitizeForImport(html: string): string {
  return DOMPurify.sanitize(html, {
    ...BASE_CONFIG,
    FORBID_TAGS: ["style"],
  }) as string;
}

/**
 * 清洗剪贴板粘贴的 HTML。
 * 允许更多属性（如 style），保留图片 data: URL。
 */
export function sanitizeForPaste(html: string): string {
  return DOMPurify.sanitize(html, {
    ...BASE_CONFIG,
    ADD_ATTR: ["style"],
  }) as string;
}

/**
 * 清洗分享页渲染的 HTML。
 * 在 dangerouslySetInnerHTML 前调用，防止 stored XSS。
 */
export function sanitizeForShare(html: string): string {
  return DOMPurify.sanitize(html, {
    ...BASE_CONFIG,
    ADD_ATTR: ["style"],
    FORBID_TAGS: ["form", "input", "textarea", "select", "button", "style"],
  }) as string;
}

/**
 * 清洗 SVG 内容（附件预览）。
 * 使用 DOMPurify 的 SVG profile。
 */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  }) as string;
}
