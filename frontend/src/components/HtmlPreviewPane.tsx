/**
 * HtmlPreviewPane — 只读 HTML 预览面板
 *
 * 两种渲染策略：
 *   1. **完整 HTML 文档**（以 `<!DOCTYPE` 或 `<html` 开头）：
 *      使用 `<iframe srcdoc>` 渲染，完全隔离样式，1:1 还原原始页面。
 *      这通常是 nowen-clipper 的「完全克隆」模式产出的内容。
 *
 *   2. **HTML 片段**（普通 clipper 剪藏）：
 *      使用 DOMPurify + `dangerouslySetInnerHTML` 渲染，
 *      配合 Tailwind prose 样式。
 *
 * 安全：
 *   - iframe 模式使用 sandbox 属性限制脚本执行
 *   - 片段模式通过 DOMPurify 清洗 XSS
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import DOMPurify from "dompurify";
import { useTranslation } from "react-i18next";
import { Eye } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { NoteEditorHandle, NoteEditorProps } from "@/components/editors/types";

/**
 * DOMPurify 配置：保留常见剪藏标签 & 属性（图片、链接、样式），
 * 但移除 <script>、<iframe>、onXxx 事件属性等。
 */
const PURIFY_CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS: [
    // 文本 & 格式
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr",
    "strong", "b", "em", "i", "u", "s", "del", "ins", "mark",
    "sub", "sup", "small", "abbr", "time", "code", "kbd", "samp", "var",
    // 块级结构
    "div", "span", "section", "article", "aside", "header", "footer",
    "nav", "main", "figure", "figcaption", "details", "summary",
    "blockquote", "pre", "address",
    // 列表
    "ul", "ol", "li", "dl", "dt", "dd",
    // 表格
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    // 媒体
    "img", "picture", "source", "video", "audio",
    // 链接
    "a",
    // 样式（完全克隆模式需要）
    "style",
  ],
  ALLOWED_ATTR: [
    "href", "src", "alt", "title", "width", "height",
    "class", "id", "style", "target", "rel",
    "colspan", "rowspan", "scope", "headers",
    "controls", "autoplay", "loop", "muted", "poster", "preload",
    "datetime", "open", "loading", "decoding",
    "data-*",
  ],
  ALLOW_DATA_ATTR: true,
};

/** 清洗 HTML：移除 XSS 向量，保留排版 */
function sanitize(html: string): string {
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/** 检测是否为完整 HTML 文档（包含 DOCTYPE 或 <html> 标签）
 *  兼容旧数据：早期 fullpage 模式可能在文档前面拼了 HTML 注释（<!-- clipper-xxx -->），
 *  需要先跳过这些注释再检测。
 */
export function isFullHtmlDocument(content: string): boolean {
  // 跳过开头的 HTML 注释
  const stripped = content.trimStart().replace(/^(\s*<!--[\s\S]*?-->\s*)+/, "");
  const lower = stripped.slice(0, 30).toLowerCase();
  return lower.startsWith("<!doctype") || lower.startsWith("<html");
}

/**
 * 为 iframe srcdoc 准备安全的 HTML 文档：
 * - 移除所有 <script> 标签
 * - 移除所有 onXxx 事件属性
 * - 注入链接拦截脚本（在新窗口打开外部链接）
 * - 注入自动高度上报脚本
 */
function prepareIframeHtml(html: string): string {
  // 移除 <script> 标签
  let safe = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

  // 移除内联事件属性（onclick, onload 等）
  safe = safe.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "");

  // 在 </body> 前注入：
  //   1. 链接拦截（所有 <a> 在新窗口打开）
  //   2. 高度上报（通知父窗口 iframe 内容高度，实现自适应）
  const injectedScript = `
<script>
  // 链接在新窗口打开
  document.addEventListener('click', function(e) {
    var a = e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    e.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
  }, true);

  // 上报内容高度给父窗口
  function reportHeight() {
    var h = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    window.parent.postMessage({ type: '__nowen_iframe_height__', height: h }, '*');
  }
  // 初始 + 图片加载后 + resize
  window.addEventListener('load', function() { setTimeout(reportHeight, 100); });
  window.addEventListener('resize', reportHeight);
  new MutationObserver(reportHeight).observe(document.body || document.documentElement, { childList: true, subtree: true });
  // 图片加载完后再报一次
  document.querySelectorAll('img').forEach(function(img) {
    if (!img.complete) img.addEventListener('load', reportHeight);
  });
  setTimeout(reportHeight, 50);
  setTimeout(reportHeight, 500);
  setTimeout(reportHeight, 2000);
</script>`;

  // 注入到 </body> 前，如果没有 </body> 就追加到末尾
  if (safe.includes("</body>")) {
    safe = safe.replace("</body>", injectedScript + "\n</body>");
  } else {
    safe += injectedScript;
  }

  return safe;
}

// ─────────────────────────────────────────────────────────────────────────────

const HtmlPreviewPane = forwardRef<NoteEditorHandle, NoteEditorProps>(
  function HtmlPreviewPane({ note, onUpdate, onHeadingsChange }, ref) {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const iframeRef = useRef<HTMLIFrameElement>(null);

    const isFullDoc = isFullHtmlDocument(note.content);

    // ── NoteEditorHandle：只读模式下大部分操作是 no-op ──
    useImperativeHandle(
      ref,
      () => ({
        flushSave: async () => {
          /* 只读预览——无待存数据 */
        },
        discardPending: () => {},
        getSnapshot: () => note.content,
        isReady: () => true,
      }),
      [note.content],
    );

    // ── 从 HTML 提取标题供大纲面板使用（仅片段模式） ──
    useEffect(() => {
      if (!onHeadingsChange) return;

      if (isFullDoc) {
        // 完整文档模式：从 iframe 内容中解析标题
        const parser = new DOMParser();
        const doc = parser.parseFromString(note.content, "text/html");
        const hNodes = doc.querySelectorAll("h1, h2, h3");
        const items = Array.from(hNodes).map((node, idx) => ({
          level: parseInt(node.tagName[1], 10) as 1 | 2 | 3,
          text: (node as HTMLElement).textContent?.trim() || "",
          pos: idx,
        }));
        onHeadingsChange(items);
        return;
      }

      if (!containerRef.current) return;
      const el = containerRef.current;
      const hNodes = el.querySelectorAll("h1, h2, h3");
      const items = Array.from(hNodes).map((node, idx) => ({
        level: parseInt(node.tagName[1], 10) as 1 | 2 | 3,
        text: (node as HTMLElement).textContent?.trim() || "",
        pos: idx,
      }));
      onHeadingsChange(items);
    }, [note.content, onHeadingsChange, isFullDoc]);

    // ── 链接在新窗口打开（仅片段模式） ──
    const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
      const target = (e.target as HTMLElement).closest("a");
      if (!target) return;
      e.preventDefault();
      const href = target.getAttribute("href");
      if (href) window.open(href, "_blank", "noopener,noreferrer");
    }, []);

    // ── 完整 HTML 文档模式：iframe srcdoc 渲染 ──
    // iframe 直接占满剩余高度，由 iframe 内部自行滚动，
    // 不再套 ScrollArea，避免出现双重滚动条。
    if (isFullDoc) {
      const iframeSrc = prepareIframeHtml(note.content);
      return (
        <div className="flex flex-col h-full overflow-hidden">
          {/* 提示条 */}
          <div className="shrink-0 mx-2 mt-2 mb-1 md:mx-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-xs text-blue-700 dark:text-blue-300">
            <Eye size={14} className="shrink-0" />
            <span>{t("editor.htmlPreview.fullPageBanner", t("editor.htmlPreview.banner"))}</span>
          </div>

          {/* iframe 渲染完整页面 — 占满剩余空间，内部自行滚动 */}
          <iframe
            ref={iframeRef}
            srcDoc={iframeSrc}
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            className="flex-1 w-full border-0 bg-white"
            title="HTML Preview"
          />
        </div>
      );
    }

    // ── HTML 片段模式：dangerouslySetInnerHTML 渲染 ──
    const cleanHtml = sanitize(note.content);

    return (
      <ScrollArea className="h-full">
        <div className="max-w-4xl mx-auto px-6 py-8 md:px-10">
          {/* 提示条 */}
          <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-xs text-blue-700 dark:text-blue-300">
            <Eye size={14} className="shrink-0" />
            <span>{t("editor.htmlPreview.banner")}</span>
          </div>

          {/* HTML 内容渲染 */}
          <div
            ref={containerRef}
            className="html-preview-content prose prose-sm dark:prose-invert max-w-none
              prose-headings:text-zinc-800 dark:prose-headings:text-zinc-200
              prose-p:text-zinc-600 dark:prose-p:text-zinc-300
              prose-a:text-indigo-500
              prose-code:text-indigo-600 dark:prose-code:text-indigo-400
              prose-blockquote:border-indigo-300 dark:prose-blockquote:border-indigo-700
              prose-pre:bg-zinc-900 prose-pre:text-zinc-100
              prose-img:rounded-lg prose-img:border prose-img:border-zinc-200 dark:prose-img:border-zinc-800"
            onClick={handleClick}
            dangerouslySetInnerHTML={{ __html: cleanHtml }}
          />
        </div>
      </ScrollArea>
    );
  },
);

export default HtmlPreviewPane;
