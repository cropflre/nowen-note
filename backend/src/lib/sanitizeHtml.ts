/**
 * HTML 安全清洗工具（后端）
 * ---------------------------------------------------------------------------
 * SEC-XSS-01-B：统一管理后端 HTML 清洗逻辑。
 *
 * 使用 sanitize-html 库（Node.js 兼容），对从外部获取的 HTML 内容在入库前
 * 进行白名单清洗，剥离危险标签和属性，防止 stored XSS。
 *
 * 当前接入点：
 *   - URL 导入（url-import.ts）：微信文章入库前清洗
 *
 * 后续可扩展到：
 *   - Guest 编辑入库清洗
 *   - 其他外部 HTML 内容入库场景
 */
import sanitize from "sanitize-html";

/**
 * 剥离所有 on* 事件属性的转换函数。
 */
function stripEventHandlers(
  tagName: string,
  attribs: sanitize.Attributes,
): sanitize.Tag {
  const clean: sanitize.Attributes = {};
  for (const [key, val] of Object.entries(attribs)) {
    if (!key.startsWith("on")) {
      clean[key] = val;
    }
  }
  return { tagName, attribs: clean };
}

/**
 * 清洗 img 标签的 data: URL：
 *   - data:image/* → 保留
 *   - 其他 data: → 移除 src
 *   - 非 data: URL → 保留（由 allowedSchemes 控制）
 *
 * 注意：transformTags 在 allowedSchemes 之前执行。
 * 非法 data: URL 被移除后，allowedSchemes 不再拦截（无 src 属性）。
 */
function sanitizeImageDataUrl(
  _tagName: string,
  attribs: sanitize.Attributes,
): sanitize.Tag {
  const src = attribs.src || "";
  if (src.startsWith("data:")) {
    if (src.startsWith("data:image/")) {
      return { tagName: "img", attribs };
    }
    // 非图片 data: URL → 移除 src
    const { src: _removed, ...rest } = attribs;
    return { tagName: "img", attribs: rest };
  }
  return { tagName: "img", attribs };
}

/**
 * 清洗 a 标签：确保 href 不使用 data: 协议（仅允许 http/https/mailto/note）。
 */
function sanitizeAnchorHref(
  _tagName: string,
  attribs: sanitize.Attributes,
): sanitize.Tag {
  const href = attribs.href || "";
  if (href.startsWith("data:")) {
    const { href: _removed, ...rest } = attribs;
    return { tagName: "a", attribs: rest };
  }
  return { tagName: "a", attribs };
}

/**
 * URL 导入 / 外部 HTML 内容清洗配置。
 *
 * 白名单策略：
 *   - 允许基础富文本标签（结构 + 内联 + 媒体 + 表格）
 *   - 允许 img/video/audio 的 http(s)/data:image 来源
 *   - 允许 a 标签的 http(s)/mailto/note: 协议
 *   - 禁止 script/style/object/embed/form 等危险标签
 *   - 禁止所有 on* 事件属性
 *   - 禁止 javascript:/vbscript:/file: 协议
 */
const IMPORT_SANITIZE_OPTIONS: sanitize.IOptions = {
  allowedTags: [
    // 结构
    "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "code",
    "ul", "ol", "li", "hr",
    "div", "span", "section", "article",
    // 表格
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col",
    // 内联
    "a", "strong", "em", "b", "i", "u", "s", "sub", "sup",
    "mark", "small", "abbr", "del", "ins", "kbd", "var", "samp",
    // 媒体
    "img", "video", "source", "audio", "picture",
    // 其他
    "details", "summary", "figure", "figcaption",
    "time", "address", "dl", "dt", "dd",
  ],
  allowedAttributes: {
    "*": ["class", "id", "dir", "lang", "title", "style", "data-*"],
    "a": ["href", "target", "rel", "title", "name"],
    "img": ["src", "alt", "width", "height", "style", "loading", "referrerpolicy"],
    "video": ["src", "controls", "width", "height", "preload", "poster"],
    "source": ["src", "type"],
    "audio": ["src", "controls", "preload"],
    "td": ["colspan", "rowspan", "style"],
    "th": ["colspan", "rowspan", "style", "scope"],
    "blockquote": ["cite"],
    "code": ["class"],
    "time": ["datetime"],
  },
  // 全局协议白名单（data: 允许后由 transformTags 按标签精确控制）
  allowedSchemes: ["http", "https", "mailto", "data"],
  // a 标签额外允许 note: 协议（内部笔记链接）
  allowedSchemesByTag: {
    a: ["http", "https", "mailto", "note"],
  },
  // 转换标签：清理危险属性 + 按标签控制 data: URL
  transformTags: {
    "*": stripEventHandlers,
    "img": sanitizeImageDataUrl,
    "a": sanitizeAnchorHref,
  },
};

/**
 * 清洗外部导入的 HTML 内容（URL 导入、HTML 文件导入等）。
 * 用于入库前清洗，防止 stored XSS。
 */
export function sanitizeForImport(html: string): string {
  return sanitize(html, IMPORT_SANITIZE_OPTIONS);
}
