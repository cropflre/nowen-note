import { Readability } from "@mozilla/readability";
import JSDOMParser from "@mozilla/readability/JSDOMParser.js";
import sanitize from "sanitize-html";
import { getDb } from "../db/schema.js";
import { hasPermission, resolveNotebookPermission } from "../middleware/acl.js";
import { sanitizeForImport } from "../lib/sanitizeHtml.js";
import { sniffRemoteImageMime } from "../lib/remote-image-security.js";
import { securePublicFetch } from "../plugins/secureRegistryFetch.js";
import type { PluginExecutionContext } from "../plugins/types.js";
import { ApplicationCommandGateway } from "./applicationCommandGateway.js";
import { saveDownloadedRemoteImageForNote } from "./remote-image-import.js";
import { extractWeixinContent, extractWeixinTitle, isWeixinVerificationPage } from "./wechat-article-extractor.js";

function invalid(message: string, code = "INVALID_ARGUMENT"): never {
  throw Object.assign(new Error(message), { code });
}

async function fetchCapture(url: string, maxBytes: number, timeoutMs: number) {
  try { return await securePublicFetch(url, maxBytes, { timeoutMs }); }
  catch (error) {
    const code = (error as { code?: string }).code;
    invalid("网页采集请求失败", code === "REGISTRY_URL_DENIED" ? "CAPTURE_URL_DENIED" : code === "REGISTRY_PAYLOAD_TOO_LARGE" ? "CAPTURE_TOO_LARGE" : "CAPTURE_FETCH_FAILED");
  }
}

export function extractArticle(html: string, url: string): { title: string; content: string } {
  let article: { title?: string | null; content?: string | null } | null;
  if (new URL(url).hostname === "mp.weixin.qq.com") {
    if (isWeixinVerificationPage(html, url)) invalid("微信要求完成访问验证，当前请求未取得文章正文。请在本人微信内打开文章并完成验证", "CAPTURE_EXTRACTION_FAILED");
    const content = extractWeixinContent(html);
    if (!content.trim()) invalid("微信未返回文章正文，请确认文章可打开且未被删除", "CAPTURE_EXTRACTION_FAILED");
    article = { title: extractWeixinTitle(html), content };
  } else {
    // Normalize HTML void tags for Readability's inert, standalone DOM parser.
    const normalized = sanitize(html, { allowedTags: false, allowedAttributes: false, allowVulnerableTags: true, exclusiveFilter: (frame) => ["script", "style", "noscript", "iframe", "object", "embed", "form", "base"].includes(frame.tag) });
    const document = new JSDOMParser().parse(normalized, url);
    article = new Readability(document, { maxElemsToParse: 25000 }).parse();
  }
  if (!article?.content) invalid("未找到可导入的文章正文", "CAPTURE_EXTRACTION_FAILED");
  const content = sanitizeForImport(sanitize(article.content, {
    allowedTags: false, allowedAttributes: false, allowVulnerableTags: true,
    transformTags: {
      img: (tagName, attribs) => {
        const source = attribs["data-src"] || attribs.src;
        try { if (source) attribs.src = new URL(source, url).href; else delete attribs.src; } catch { delete attribs.src; }
        return { tagName, attribs };
      },
      a: (tagName, attribs) => {
        if (attribs.href) { try { attribs.href = new URL(attribs.href, url).href; } catch { delete attribs.href; } }
        return { tagName, attribs };
      },
    },
  }));
  if (!sanitize(content, { allowedTags: [], allowedAttributes: {} }).trim()) invalid("文章正文为空", "CAPTURE_EXTRACTION_FAILED");
  if (Buffer.byteLength(content) > 512 * 1024) invalid("提取后的正文超过 512KB", "CAPTURE_TOO_LARGE");
  return { title: String(article.title || new URL(url).hostname).slice(0, 300), content };
}

export async function importArticleUrl(context: PluginExecutionContext, input: Record<string, unknown>) {
  if (typeof input.url !== "string" || typeof input.notebookId !== "string") invalid("url / notebookId 必须是字符串");
  const access = resolveNotebookPermission(input.notebookId, context.userId);
  if (!hasPermission(access.permission, "write")) invalid("无权在目标笔记本创建笔记", "RESOURCE_FORBIDDEN");
  const notebook = getDb().prepare("SELECT workspaceId FROM notebooks WHERE id=?").get(input.notebookId) as { workspaceId: string | null };
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 20 || tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 100)) invalid("tags 必须是最多 20 个标签名称");
  if (input.comment !== undefined && (typeof input.comment !== "string" || input.comment.length > 5000)) invalid("comment 最多 5000 字符");
  const response = await fetchCapture(input.url, 2 * 1024 * 1024, 10000);
  if (response.contentType && !/^text\/html\b|^application\/xhtml\+xml\b/i.test(response.contentType)) invalid("URL 不是 HTML 网页", "CAPTURE_EXTRACTION_FAILED");
  const article = extractArticle(response.body.toString("utf8"), response.finalUrl);
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const footer = `<p><a href="${escape(response.finalUrl)}">${escape(response.finalUrl)}</a></p>${input.comment ? `<p>${escape(String(input.comment))}</p>` : ""}`;
  const sources = new Set<string>();
  sanitize(article.content, { allowedTags: ["img"], allowedAttributes: { img: ["src"] }, transformTags: { img: (tagName, attribs) => { if (attribs.src) sources.add(attribs.src); return { tagName, attribs }; } } });
  // Fetch every image through the same pinned public transport. No DOM/network loader.
  const images = new Map<string, { buffer: Buffer; mimeType: string; filename: string; finalUrl: string }>();
  const candidates = [...sources].slice(0, 10);
  await Promise.all(candidates.map(async (url) => {
    try {
      const result = await fetchCapture(url, 2 * 1024 * 1024, 3000);
      const mimeType = sniffRemoteImageMime(result.body);
      if (mimeType) images.set(url, { buffer: result.body, mimeType, filename: "article-image", finalUrl: result.finalUrl });
    } catch { /* Keep readable text if a remote image is unavailable or denied. */ }
  }));
  const commands = new ApplicationCommandGateway();
  const user = getDb().prepare("SELECT isDisabled FROM users WHERE id=?").get(context.userId) as { isDisabled: number } | undefined;
  if (!user || user.isDisabled) invalid("用户已禁用或不存在", "RESOURCE_FORBIDDEN");
  const withoutRemoteImages = (content: string, replacements = new Map<string, string>()) => sanitizeForImport(sanitize(content, {
    allowedTags: false, allowedAttributes: false, allowVulnerableTags: true,
    transformTags: { "*": (tagName, attribs) => { delete attribs.style; for (const key of Object.keys(attribs)) if (key.startsWith("data-")) delete attribs[key]; return { tagName, attribs }; },
      img: (tagName, attribs) => ({ tagName, attribs: { alt: attribs.alt || "", ...(replacements.has(attribs.src) ? { src: replacements.get(attribs.src)! } : {}) } }),
      video: () => ({ tagName: "span", attribs: {} }), audio: () => ({ tagName: "span", attribs: {} }), source: () => ({ tagName: "span", attribs: {} }) },
  }));
  const note = await commands.createNote(context.userId, { notebookId: input.notebookId, title: article.title, contentFormat: "html", content: withoutRemoteImages(article.content) + footer }, context);
  const replacements = new Map<string, string>();
  for (const [url, downloaded] of images) {
    try {
      const image = await saveDownloadedRemoteImageForNote({ downloaded, sourceUrl: url, noteId: note.id, userId: context.userId, workspaceId: notebook.workspaceId, uploadSource: "capture" });
      replacements.set(url, image.url);
    } catch { /* A failed image must not lose the captured text. */ }
  }
  if (replacements.size) await commands.updateNote(context.userId, note.id, { content: withoutRemoteImages(article.content, replacements) + footer, contentFormat: "html", version: note.version, writeSource: "plugin-capture" }, context);
  for (const name of new Set(tags.map((tag) => String(tag).trim()))) {
    const tag = getDb().prepare("SELECT id FROM tags WHERE userId=? AND workspaceId IS ? AND name=?").get(context.userId, notebook.workspaceId, name) as { id: string } | undefined;
    const created = tag || await commands.createTag(context.userId, { name, workspaceId: notebook.workspaceId }, context);
    await commands.setNoteTag(context.userId, note.id, created.id, true, context);
  }
  return { id: note.id, title: article.title, imagesImported: replacements.size, imagesSkipped: sources.size - replacements.size };
}
