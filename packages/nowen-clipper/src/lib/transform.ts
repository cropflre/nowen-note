/**
 * 内容变换：HTML → Markdown、图片 URL → base64。
 *
 * 运行在 background service worker 中（而不是 content script），原因：
 *   - service worker 有更大的内存预算，适合下载图片
 *   - 不同站点的 CSP 不允许 content script 里 fetch 跨域（background 豁免）
 *   - turndown 包体积不小（~35KB），只打一次
 */

import TurndownService from "turndown";
import { gfm, strikethrough, tables, taskListItems } from "turndown-plugin-gfm";

/** 初始化 turndown（单例） */
let td: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (td) return td;
  td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    hr: "---",
    linkStyle: "inlined",
  });
  td.use(gfm);
  td.use([strikethrough, tables, taskListItems]);
  // 自定义 <img> 处理：
  //   - src 以 data: 开头 → 保留原 HTML <img> 标签。
  //     原因：后端 extractInlineBase64Images 的正则只匹配引号包裹的 src="data:...",
  //     Markdown 形式 ![](data:...) 不带引号无法被抽到 attachments。
  //   - 其它（http/https 外链、相对路径等）→ 转 Markdown 语法，保持行内美观
  td.addRule("imgBase64Keep", {
    filter: (node) => node.nodeName === "IMG",
    replacement: (_content, node) => {
      const el = node as HTMLImageElement;
      const src = el.getAttribute("src") || "";
      if (!src) return "";
      if (src.startsWith("data:")) {
        // 保留原 HTML。turndown 中 return 一段 HTML 会被原样嵌入 markdown，
        // 解析 MD 时这段 raw HTML 会被保留到最终 AST（GFM 支持 raw HTML）。
        const alt = escapeAttr(el.getAttribute("alt") || "");
        return `<img src="${src}" alt="${alt}" />`;
      }
      const alt = el.getAttribute("alt") || "";
      const title = el.getAttribute("title");
      return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
    },
  });
  return td;
}

/** HTML → Markdown */
export function htmlToMarkdown(html: string): string {
  return getTurndown().turndown(html);
}

/** 估算文本长度（剔除 HTML 标签） */
export function countText(html: string): number {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
}

/**
 * 下载 html 中所有 <img src="http..."> 并替换为 data URI。
 *
 * - 只处理 http/https 开头的 src；data: / blob: / 相对路径跳过
 * - 并发上限 4，避免大站被临时限流
 * - 每张图有 5s 超时；失败则保留原链接（由后端或用户浏览器再去加载）
 * - 返回处理后的 html + 统计信息
 *
 * 注意：不在此处做 referer 欺骗。跨站盗链防护是站点侧的事，未来可通过
 * declarativeNetRequest 做"为剪藏请求加 Referer"的规则集。
 */
export async function inlineImages(
  html: string,
  opts: { concurrency?: number; maxSizeBytes?: number; timeoutMs?: number } = {},
): Promise<{ html: string; ok: number; failed: number; skipped: number }> {
  const concurrency = opts.concurrency ?? 4;
  const maxSize = opts.maxSizeBytes ?? 5 * 1024 * 1024; // 5MB 单图
  const timeoutMs = opts.timeoutMs ?? 8000;

  // 用正则提取所有 <img> 标签的 src
  // 注意：service worker 环境不保证有 DOMParser，因此使用正则方式解析。
  const imgRegex = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)>/gi;
  const imgEntries: Array<{ fullMatch: string; src: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1] ?? match[2] ?? "";
    imgEntries.push({ fullMatch: match[0], src });
  }

  // 收集需要下载的唯一 URL
  const queue: string[] = [];
  const seen = new Set<string>();
  for (const entry of imgEntries) {
    if (/^https?:\/\//i.test(entry.src) && !seen.has(entry.src)) {
      seen.add(entry.src);
      queue.push(entry.src);
    }
  }

  const fetchOne = async (src: string): Promise<string | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(src, {
        credentials: "omit",
        signal: ctrl.signal,
        // 明确不发 cookie，避免把用户会话带进备份里
      });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxSize) return null;
      const mime = res.headers.get("content-type")?.split(";")[0].trim() || guessMime(src);
      if (!mime.startsWith("image/")) return null;
      return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // 并发池
  const results = new Map<string, string | null>();
  let idx = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (idx < queue.length) {
          const my = idx++;
          const src = queue[my];
          const data = await fetchOne(src);
          results.set(src, data);
        }
      })(),
    );
  }
  await Promise.all(workers);

  // 统计并替换
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let resultHtml = html;

  for (const entry of imgEntries) {
    if (!/^https?:\/\//i.test(entry.src)) {
      skipped++;
      continue;
    }
    const data = results.get(entry.src);
    if (data) {
      // 将 src 替换为 data URI
      const newTag = entry.fullMatch.replace(entry.src, data);
      resultHtml = resultHtml.replace(entry.fullMatch, newTag);
      ok++;
    } else {
      failed++;
    }
  }

  return { html: resultHtml, ok, failed, skipped };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // 分片避免 apply 栈溢出
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

function guessMime(url: string): string {
  const m = url.toLowerCase().match(/\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/);
  if (!m) return "image/png";
  const ext = m[1];
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "svg") return "image/svg+xml";
  return `image/${ext}`;
}

/**
 * 拼装最终入库的 content / contentText。
 *
 * 当 outputFormat=markdown：
 *   - content 字段填 markdown（后端 contentFormat 会把 MD 识别出来并存 JSON AST）
 *     **但** extractInlineBase64Images 只匹配 content 里的 <img src="data:...">，所以
 *     为了让图片仍能抽到 attachments，我们把 markdown 里的 ![alt](data:...) 转回 <img>
 *     语法，这样后端抽图路径仍然走通。后端不会因此把 MD 当 HTML 对待，因为 MD 解析
 *     遇到 <img> 这种 raw HTML 会原样保留。
 */
export function buildContentBundle(params: {
  title: string;
  html: string;
  sourceUrl: string;
  siteName: string;
  format: "markdown" | "html";
  includeSource: boolean;
  tags: string[];
  /** 用户附加的评论 */
  comment?: string;
}): { content: string; contentText: string } {
  const { title, html, sourceUrl, siteName, format, includeSource, tags, comment } = params;

  // 评论区块（放在标题后、正文前）
  const commentHtml = comment?.trim()
    ? `<blockquote><p>💬 ${escapeText(comment.trim())}</p></blockquote>\n`
    : "";

  // 附录：来源 + 标签
  const footerParts: string[] = [];
  if (includeSource) {
    footerParts.push(
      `<hr/>\n<p><small>📎 来源：<a href="${escapeAttr(sourceUrl)}">${escapeText(siteName || sourceUrl)}</a></small></p>`,
    );
  }
  if (tags.length > 0) {
    footerParts.push(
      `<p><small>🏷️ ${tags.map((t) => `#${escapeText(t)}`).join(" ")}</small></p>`,
    );
  }
  const footer = footerParts.join("\n");

  const fullHtml = `<h1>${escapeText(title)}</h1>\n${commentHtml}${html}\n${footer}`;

  if (format === "html") {
    const text = fullHtml.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    return { content: fullHtml, contentText: text };
  }

  // format === "markdown"
  const md = htmlToMarkdown(fullHtml);
  // 纯文本直接用去标签后的结果
  const text = md.replace(/[#*>`_~\[\]\(\)!-]/g, "").replace(/\s+/g, " ").trim();
  return { content: md, contentText: text };
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
