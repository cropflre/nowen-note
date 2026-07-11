import "../lib/sw-polyfill";
import "./index";

import { getConfig, isConfigured, setAccountState } from "../lib/storage";
import {
  buildNoteUrl,
  enhanceClip,
  ensureNoteTags,
  importNote,
  setNotePinned,
} from "../lib/api";
import { buildContentBundle } from "../lib/transform";
import { localizeRemoteImages } from "../lib/image-localizer";
import type {
  AIEnhanceMode,
  AIEnhanceTasks,
  EnhancedClipRequest,
  EnhancedClipResponse,
  ExtractRequest,
  ExtractResponse,
  ImageProgressStats,
} from "../lib/protocol";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "ENHANCED_CLIP_REQUEST") return undefined;
  void runEnhancedClip(message as EnhancedClipRequest)
    .then(sendResponse)
    .catch((error: any) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

async function runEnhancedClip(req: EnhancedClipRequest): Promise<EnhancedClipResponse> {
  const cfg = await getConfig();
  if (!isConfigured(cfg)) return { ok: false, error: "未配置服务器地址或登录已失效" };

  await setAccountState(cfg, {
    clipMode: req.mode,
    workspaceId: req.targetWorkspaceId || "personal",
    notebookId: req.targetNotebookId || "",
    notebookLabel: req.targetNotebookName || "",
    imageMode: req.imageMode,
    outputFormat: req.outputFormat,
    isPinned: !!req.isPinned,
  }).catch(() => undefined);

  if (req.mode === "quickNote") return saveQuickNote(cfg, req);
  if (req.mode === "screenshot" || req.mode === "fullScreenshot") {
    return { ok: false, error: "截图模式请使用右键菜单或快捷键；统一入口当前聚焦速记、正文和选区剪藏" };
  }
  if (!req.tabId) return { ok: false, error: "未找到当前标签页" };

  const prepareScroll = cfg.lazyLoadScroll && (req.mode === "article" || req.mode === "fullpage");
  sendProgress("prepare-lazy", prepareScroll ? "正在触发并收集懒加载图片..." : "正在解析页面图片来源...");
  try {
    await prepareLazyAssets(req.tabId, {
      scroll: prepareScroll,
      maxImages: cfg.maxImageCount,
      maxBackgrounds: Math.min(40, Math.max(10, Math.floor(cfg.maxImageCount / 3))),
      timeoutMs: Math.min(8_000, Math.max(2_000, cfg.imageTimeoutMs)),
    });
  } catch (error) {
    console.warn("[nowen-clipper enhanced] lazy prepare failed:", error);
  }

  sendProgress("extract", "正在抽取页面内容...");
  const extractMode = req.mode === "simplified"
    ? "simplified"
    : req.mode === "selection"
      ? "selection"
      : req.mode === "fullpage"
        ? "fullpage"
        : "article";

  let extracted: ExtractResponse;
  try {
    extracted = await requestExtract(req.tabId, extractMode);
  } finally {
    void cleanupLazyAssets(req.tabId);
  }

  if (!extracted.ok || !extracted.data) {
    return { ok: false, error: extracted.error || "内容抽取失败" };
  }

  const data = extracted.data;
  let html = data.html;
  let images: ImageProgressStats = { ok: 0, failed: 0, skipped: 0, failures: [] };

  if (req.mode !== "simplified") {
    if (req.imageMode === "inline") {
      sendProgress("download-images", "正在下载远程图片并保存到 Nowen...");
      const localized = await localizeRemoteImages(html, {
        maxImages: cfg.maxImageCount,
        maxSingleBytes: cfg.maxSingleImageBytes,
        maxTotalBytes: cfg.maxTotalImageBytes,
        timeoutMs: cfg.imageTimeoutMs,
        concurrency: 4,
      });
      html = localized.html;
      images = {
        ok: localized.ok,
        failed: localized.failed,
        skipped: localized.skipped,
        bytes: localized.bytes,
        failures: localized.failures,
      };
    } else if (req.imageMode === "skip") {
      html = html.replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, "").replace(/<img\b[^>]*>/gi, "");
    }
  }

  let title = data.title || "无标题剪藏";
  let tags = normalizeTags(req.tags || []);
  let aiBlock = "";
  let aiMode: AIEnhanceMode = req.aiMode || cfg.aiEnhanceMode;

  if (req.aiEnhance && hasAnyTask(req.aiTasks || cfg.aiEnhanceTasks) && data.text.trim().length >= 20) {
    sendProgress("ai-enhance", "AI 正在整理剪藏内容...");
    try {
      const ai = await enhanceClip(cfg, {
        title,
        url: data.url,
        siteName: data.siteName,
        contentText: data.text,
        tasks: req.aiTasks || cfg.aiEnhanceTasks,
        language: cfg.aiEnhanceLanguage,
        customInstruction: cfg.aiCustomInstruction || undefined,
        maxInputChars: cfg.aiMaxInputChars,
      });
      if (ai.ok && ai.enhanced) {
        if (ai.enhanced.title) title = ai.enhanced.title;
        tags = normalizeTags([...tags, ...(ai.enhanced.tags || [])]);
        aiBlock = composeAiBlock(ai.enhanced, req.outputFormat);
      } else if (cfg.aiFailureStrategy === "fail") {
        return { ok: false, error: `AI 优化失败：${ai.error || "未知错误"}` };
      }
    } catch (error: any) {
      if (cfg.aiFailureStrategy === "fail") {
        return { ok: false, error: `AI 优化失败：${String(error?.message || error)}` };
      }
    }
  }

  sendProgress("transform", "正在生成笔记内容...");
  let content: string;
  let contentText: string;
  let contentFormat: "markdown" | "tiptap-json";

  if (req.mode === "fullpage") {
    content = injectFullPageMetadata(html, {
      sourceUrl: data.url,
      comment: req.comment,
      tags,
    });
    contentText = data.text.slice(0, 20_000);
    contentFormat = "tiptap-json";
  } else {
    const bundle = buildContentBundle({
      title,
      html,
      sourceUrl: data.url,
      siteName: data.siteName,
      format: req.outputFormat,
      includeSource: cfg.includeSource,
      tags,
      comment: req.comment,
    });
    content = applyAiBlock(bundle.content, aiBlock, aiMode, req.outputFormat);
    contentText = `${aiBlock ? stripMarkup(aiBlock) + " " : ""}${bundle.contentText}`.trim();
    contentFormat = req.outputFormat === "markdown" ? "markdown" : "tiptap-json";
  }

  return saveNote(cfg, req, {
    title,
    content,
    contentText,
    contentFormat,
    tags,
    images,
  });
}

async function saveQuickNote(
  cfg: Awaited<ReturnType<typeof getConfig>>,
  req: EnhancedClipRequest,
): Promise<EnhancedClipResponse> {
  const body = req.quickNote?.content?.trim() || "";
  const title = req.quickNote?.title?.trim() || firstMeaningfulLine(body) || `速记 ${formatNow()}`;
  if (!body && !req.quickNote?.title?.trim()) return { ok: false, error: "请输入速记标题或正文" };

  return saveNote(cfg, req, {
    title,
    content: body,
    contentText: stripMarkup(body),
    contentFormat: "markdown",
    tags: normalizeTags(req.tags || []),
    images: { ok: 0, failed: 0, skipped: 0, failures: [] },
  });
}

async function saveNote(
  cfg: Awaited<ReturnType<typeof getConfig>>,
  req: EnhancedClipRequest,
  note: {
    title: string;
    content: string;
    contentText: string;
    contentFormat: "markdown" | "tiptap-json";
    tags: string[];
    images: ImageProgressStats;
  },
): Promise<EnhancedClipResponse> {
  sendProgress("upload", "正在保存到目标笔记本...");
  try {
    const response = await importNote(cfg, {
      title: note.title,
      content: note.content,
      contentText: note.contentText,
      contentFormat: note.contentFormat,
      workspaceId: req.targetWorkspaceId,
      notebookId: req.targetNotebookId,
      notebookName: req.targetNotebookId ? undefined : (req.targetNotebookName || cfg.defaultNotebook || "Web 剪藏"),
    });
    const noteId = response.notes?.[0]?.id;
    if (!noteId) return { ok: false, error: "服务器未返回新笔记 ID" };

    const warnings: string[] = [];
    if (req.isPinned) {
      try {
        await setNotePinned(cfg, noteId, true);
      } catch (error: any) {
        warnings.push(`置顶失败：${String(error?.message || error)}`);
      }
    }

    const tagFailures = await ensureNoteTags(cfg, noteId, note.tags, req.targetWorkspaceId).catch((error: any) => [
      String(error?.message || error),
    ]);
    if (tagFailures.length) warnings.push(`标签未完全保存：${tagFailures.join("；")}`);

    const noteUrl = buildNoteUrl(cfg, noteId);
    sendProgress("done", `已保存「${note.title}」`, note.images);
    notify("保存成功", warnings.length ? `笔记已保存，${warnings.length} 项附加操作未完成` : `已保存到 Nowen Note`);
    return {
      ok: true,
      noteId,
      noteTitle: note.title,
      noteUrl,
      images: note.images,
      warnings,
    };
  } catch (error: any) {
    const message = String(error?.message || error || "保存失败");
    sendProgress("error", message);
    notify("保存失败", message);
    return { ok: false, error: message };
  }
}

async function requestExtract(
  tabId: number,
  mode: ExtractRequest["mode"],
): Promise<ExtractResponse> {
  const message: ExtractRequest = { type: "EXTRACT_REQUEST", mode };
  try {
    return await chrome.tabs.sendMessage(tabId, message) as ExtractResponse;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await sleep(120);
    return await chrome.tabs.sendMessage(tabId, message) as ExtractResponse;
  }
}

async function prepareLazyAssets(
  tabId: number,
  options: { scroll: boolean; maxImages: number; maxBackgrounds: number; timeoutMs: number },
): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [options],
    func: async (opts) => {
      const marker = "data-nowen-clipper-generated";
      document.querySelectorAll(`[${marker}]`).forEach((node) => node.remove());
      const startedAt = Date.now();
      const originalY = window.scrollY;
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const bestSrcset = (value: string): string => {
        const candidates = value.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
        return candidates[candidates.length - 1] || "";
      };
      const absolute = (value: string): string => {
        try { return new URL(value, location.href).href; } catch { return ""; }
      };
      const isPlaceholder = (value: string): boolean => {
        const lower = value.toLowerCase();
        return !value || lower.startsWith("data:image/gif") || lower.startsWith("data:image/svg") || lower.includes("placeholder") || lower.includes("loading") || lower === "about:blank";
      };

      const normalize = () => {
        const images = Array.from(document.images).slice(0, opts.maxImages);
        for (const img of images) {
          const picture = img.closest("picture");
          const source = picture?.querySelector("source");
          const attrs = [
            img.currentSrc,
            img.getAttribute("src") || "",
            img.getAttribute("data-src") || "",
            img.getAttribute("data-original") || "",
            img.getAttribute("data-lazy-src") || "",
            img.getAttribute("data-url") || "",
            bestSrcset(img.getAttribute("data-srcset") || ""),
            bestSrcset(img.getAttribute("srcset") || ""),
            bestSrcset(source?.getAttribute("data-srcset") || ""),
            bestSrcset(source?.getAttribute("srcset") || ""),
          ].map(absolute).filter(Boolean);
          const current = absolute(img.getAttribute("src") || "");
          const preferred = attrs.find((value) => !isPlaceholder(value)) || attrs[0];
          if (preferred && (isPlaceholder(current) || preferred !== current)) img.setAttribute("src", preferred);
          if (preferred) {
            img.removeAttribute("srcset");
            img.removeAttribute("loading");
          }
        }

        let backgrounds = 0;
        const elements = Array.from(document.querySelectorAll<HTMLElement>("body *")).slice(0, 2500);
        for (const element of elements) {
          if (backgrounds >= opts.maxBackgrounds) break;
          if (element.querySelector(`:scope > img[${marker}]`)) continue;
          const css = getComputedStyle(element).backgroundImage || "";
          const match = css.match(/url\((['"]?)(.*?)\1\)/i);
          if (!match?.[2]) continue;
          const url = absolute(match[2]);
          if (!url || url.startsWith("data:")) continue;
          const rect = element.getBoundingClientRect();
          if (rect.width < 80 || rect.height < 60) continue;
          const img = document.createElement("img");
          img.setAttribute(marker, "1");
          img.src = url;
          img.alt = element.getAttribute("aria-label") || element.getAttribute("title") || "背景图片";
          img.style.maxWidth = "100%";
          img.style.height = "auto";
          element.appendChild(img);
          backgrounds++;
        }
      };

      normalize();
      if (opts.scroll) {
        let lastHeight = 0;
        for (let step = 0; step < 24; step++) {
          if (Date.now() - startedAt >= opts.timeoutMs) break;
          const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
          const y = Math.min(height, step * Math.max(400, Math.floor(window.innerHeight * 0.8)));
          window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
          await pause(140);
          normalize();
          if (y + window.innerHeight >= height && height === lastHeight) break;
          lastHeight = height;
        }
      }
      window.scrollTo({ top: originalY, behavior: "instant" as ScrollBehavior });
      await pause(80);
      normalize();
    },
  });
}

async function cleanupLazyAssets(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        document.querySelectorAll('[data-nowen-clipper-generated="1"]').forEach((node) => node.remove());
      },
    });
  } catch {
    /* 页面关闭或导航时无需处理 */
  }
}

function applyAiBlock(
  content: string,
  block: string,
  mode: AIEnhanceMode,
  format: "markdown" | "html",
): string {
  if (!block) return content;
  if (mode === "replace") return block;
  if (format === "html") return mode === "prepend" ? `${block}\n${content}` : `${content}\n${block}`;
  return mode === "prepend" ? `${block}\n\n${content}` : `${content}\n\n${block}`;
}

function composeAiBlock(
  enhanced: NonNullable<Awaited<ReturnType<typeof enhanceClip>>["enhanced"]>,
  format: "markdown" | "html",
): string {
  const sections: Array<{ title: string; body: string }> = [];
  if (enhanced.summary) sections.push({ title: "AI 摘要", body: enhanced.summary });
  if (enhanced.outline) sections.push({ title: "AI 大纲", body: enhanced.outline });
  if (enhanced.highlights?.length) sections.push({ title: "重点", body: enhanced.highlights.map((item) => `- ${item}`).join("\n") });
  if (enhanced.translation) sections.push({ title: "翻译", body: enhanced.translation });
  if (!sections.length) return "";
  if (format === "html") {
    return `<section data-nowen-ai="1">${sections.map((section) => `<h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.body).replace(/\n/g, "<br>")}</p>`).join("")}</section>`;
  }
  return sections.map((section) => `## ${section.title}\n\n${section.body}`).join("\n\n");
}

function injectFullPageMetadata(
  html: string,
  meta: { sourceUrl: string; comment?: string; tags: string[] },
): string {
  const comments = [
    `<!-- nowen-clipper-source: ${meta.sourceUrl.replace(/-->/g, "--&gt;")} -->`,
    meta.comment ? `<!-- nowen-clipper-comment: ${meta.comment.replace(/-->/g, "--&gt;")} -->` : "",
    meta.tags.length ? `<!-- nowen-clipper-tags: ${meta.tags.join(",").replace(/-->/g, "--&gt;")} -->` : "",
  ].filter(Boolean).join("\n");
  return html.replace(/<head([^>]*)>/i, `<head$1>\n${comments}`);
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.flatMap((tag) => tag.split(/[，,]/)).map((tag) => tag.trim()).filter(Boolean))).slice(0, 20);
}

function hasAnyTask(tasks: AIEnhanceTasks): boolean {
  return Object.values(tasks).some(Boolean);
}

function firstMeaningfulLine(content: string): string {
  return content.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean)?.slice(0, 80) || "";
}

function stripMarkup(content: string): string {
  return content
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[#>*_`~-]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatNow(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sendProgress(
  phase: "prepare-lazy" | "extract" | "download-images" | "transform" | "ai-enhance" | "upload" | "done" | "error",
  message: string,
  images?: ImageProgressStats,
): void {
  void chrome.runtime.sendMessage({ type: "CLIP_PROGRESS", phase, message, images }).catch(() => undefined);
}

function notify(title: string, message: string): void {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title,
      message: message.slice(0, 240),
    });
  } catch {
    /* ignore */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
