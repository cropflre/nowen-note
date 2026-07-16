import JSZip from "jszip";
import { saveAs } from "file-saver";
import { common, createLowlight } from "lowlight";
import {
  inlineRemoteImages,
  noteContentToExportHtml,
  type ImgStats,
} from "@/lib/exportService";
import {
  isAndroidNative,
  saveImageToGalleryDetailed,
  saveBlobToSystemFile,
  shareNativeFiles,
} from "@/lib/nativeImageSave";
import type {
  ExportableNoteImageSource,
  NoteImageExportDestination,
  NoteImageExportFormat,
  NoteImageExportLayout,
  NoteImageExportTheme,
} from "@/lib/noteImageExportBridge";
import {
  findOverflowingExportTables,
  normalizeExportTables,
} from "@/lib/noteImageExportTables";

const EXPORT_WIDTH = 794;
const EXPORT_HORIZONTAL_PADDING = 56;
const EXPORT_CONTENT_WIDTH = EXPORT_WIDTH - EXPORT_HORIZONTAL_PADDING * 2;
const PAGE_SLICE_HEIGHT = 1400;
const MAX_CANVAS_DIMENSION = 16_384;
const MAX_CANVAS_PIXELS = 64 * 1024 * 1024;
const RESOURCE_TIMEOUT_MS = 10_000;

export interface NoteImageExportProgress {
  phase: "prepare" | "assets" | "render" | "save";
  current: number;
  total: number;
  message: string;
}

export interface NoteImageExportOptions {
  format: NoteImageExportFormat;
  quality?: number;
  pixelRatio?: number;
  layout?: NoteImageExportLayout;
  theme?: NoteImageExportTheme;
  destination: NoteImageExportDestination;
  onProgress?: (progress: NoteImageExportProgress) => void;
}

export interface NoteImageExportResourceFailure {
  src: string;
  reason: string;
}

export interface NoteImageExportFile {
  blob: Blob;
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
  uri?: string;
  displayPath?: string;
}

export interface NoteImageExportResult {
  ok: boolean;
  canceled?: boolean;
  format: NoteImageExportFormat;
  destination: NoteImageExportDestination;
  files: NoteImageExportFile[];
  warnings: string[];
  failedResources: NoteImageExportResourceFailure[];
  paginated: boolean;
  displayPath?: string;
  openUri?: string;
  error?: string;
}

interface PreparedHost {
  host: HTMLDivElement;
  article: HTMLElement;
  styleText: string;
  background: string;
  width: number;
  height: number;
  failedResources: NoteImageExportResourceFailure[];
  cleanup: () => void;
}

export interface RasterPlan {
  mode: "long" | "pages";
  scale: number;
  slices: Array<{ offset: number; height: number }>;
  warning?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeFilename(value: string): string {
  return (value || "note")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "note";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("BLOB_READ_FAILED"));
    reader.readAsDataURL(blob);
  });
}

function failedImagePlaceholder(src: string): string {
  const label = src.length > 72 ? `${src.slice(0, 69)}...` : src;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="160" viewBox="0 0 760 160">
    <rect width="760" height="160" rx="12" fill="#f3f4f6"/>
    <path d="M48 111l34-38 27 29 22-25 43 48H48z" fill="#cbd5e1"/>
    <circle cx="140" cy="55" r="12" fill="#cbd5e1"/>
    <text x="205" y="70" font-family="Arial, sans-serif" font-size="18" fill="#475569">图片加载失败</text>
    <text x="205" y="101" font-family="Arial, sans-serif" font-size="13" fill="#64748b">${escapeHtml(label)}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function inlineRemainingImages(
  html: string,
  failures: NoteImageExportResourceFailure[],
): Promise<string> {
  if (!/<img\b/i.test(html)) return html;

  const template = document.createElement("template");
  template.innerHTML = html;
  const images = Array.from(template.content.querySelectorAll("img"));
  const cache = new Map<string, string>();
  let cursor = 0;

  async function worker() {
    while (cursor < images.length) {
      const image = images[cursor++];
      const src = image.getAttribute("src") || "";
      if (!src || /^data:/i.test(src)) continue;

      try {
        let dataUri = cache.get(src);
        if (!dataUri) {
          const absolute = new URL(src, window.location.href);
          const controller = new AbortController();
          const timer = window.setTimeout(() => controller.abort(), RESOURCE_TIMEOUT_MS);
          try {
            const response = await fetch(absolute.toString(), {
              credentials: absolute.origin === window.location.origin ? "include" : "omit",
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            if (!blob.size) throw new Error("empty body");
            if (!/^image\//i.test(blob.type || "")) throw new Error(`unexpected MIME ${blob.type || "unknown"}`);
            dataUri = await blobToDataUri(blob);
            cache.set(src, dataUri);
          } finally {
            window.clearTimeout(timer);
          }
        }
        image.setAttribute("src", dataUri);
      } catch (error) {
        failures.push({
          src,
          reason: error instanceof Error ? error.message : String(error),
        });
        image.setAttribute("src", failedImagePlaceholder(src));
        image.setAttribute("alt", `图片加载失败：${src}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, images.length) }, () => worker()));
  return template.innerHTML;
}

function hastToHtml(node: any): string {
  if (!node) return "";
  if (node.type === "text") return escapeHtml(String(node.value || ""));
  if (node.type !== "element") return Array.isArray(node.children) ? node.children.map(hastToHtml).join("") : "";
  const tag = /^[a-z][a-z0-9-]*$/i.test(node.tagName || "") ? node.tagName : "span";
  const classes = Array.isArray(node.properties?.className)
    ? node.properties.className.join(" ")
    : String(node.properties?.className || "");
  const classAttr = classes ? ` class="${escapeHtml(classes)}"` : "";
  return `<${tag}${classAttr}>${(node.children || []).map(hastToHtml).join("")}</${tag}>`;
}

function highlightCodeBlocks(root: ParentNode): void {
  const lowlight = createLowlight(common);
  root.querySelectorAll("pre > code").forEach((code) => {
    const element = code as HTMLElement;
    const languageClass = Array.from(element.classList).find((name) => name.startsWith("language-"));
    const language = languageClass?.slice("language-".length) || "";
    const source = element.textContent || "";
    const alreadyHighlighted = !!element.querySelector("[class^='hljs-'], [class*=' hljs-']");

    if (!alreadyHighlighted && source.trim()) {
      try {
        const tree = language
          ? lowlight.highlight(language, source)
          : lowlight.highlightAuto(source);
        element.innerHTML = (tree.children || []).map(hastToHtml).join("");
      } catch {
        // Unknown language: keep escaped plain code.
      }
    }

    element.classList.add("hljs");
    const pre = element.parentElement;
    if (pre && language) pre.setAttribute("data-language", language.toUpperCase());
  });
}

function currentTheme(theme: NoteImageExportTheme): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  const root = document.documentElement;
  return root.classList.contains("dark") || root.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function buildStyle(theme: "light" | "dark", fontFamily: string, lineHeight: string): string {
  const dark = theme === "dark";
  const bg = dark ? "#111318" : "#ffffff";
  const fg = dark ? "#e7e9ee" : "#1f2328";
  const muted = dark ? "#9299a8" : "#6b7280";
  const border = dark ? "#343943" : "#d0d7de";
  const soft = dark ? "#1b1f27" : "#f6f8fa";
  const codeBg = dark ? "#0b0e14" : "#0d1117";

  return `
    .nowen-note-image-export-host, .nowen-note-image-export-host * { box-sizing: border-box; }
    .nowen-note-image-export-host { width: ${EXPORT_WIDTH}px; background: ${bg}; color: ${fg}; }
    .nowen-note-image-export-page {
      width: ${EXPORT_WIDTH}px; min-height: 120px; padding: 48px 56px 56px;
      background: ${bg}; color: ${fg}; font-family: ${fontFamily};
      font-size: 15px; line-height: ${lineHeight}; overflow-wrap: anywhere;
      -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    }
    .nowen-note-image-export-title { margin: 0 0 8px; font-size: 30px; line-height: 1.28; font-weight: 750; letter-spacing: -0.02em; color: ${fg}; }
    .nowen-note-image-export-meta { margin: 0 0 30px; color: ${muted}; font-size: 12px; line-height: 1.5; }
    .nowen-note-image-export-body { color: ${fg}; }
    .nowen-note-image-export-body > :first-child { margin-top: 0 !important; }
    .nowen-note-image-export-body > :last-child { margin-bottom: 0 !important; }
    .nowen-note-image-export-body h1 { margin: 30px 0 12px; font-size: 25px; line-height: 1.35; font-weight: 720; }
    .nowen-note-image-export-body h2 { margin: 26px 0 10px; font-size: 21px; line-height: 1.4; font-weight: 700; }
    .nowen-note-image-export-body h3 { margin: 22px 0 8px; font-size: 18px; line-height: 1.45; font-weight: 680; }
    .nowen-note-image-export-body p { margin: 9px 0; white-space: normal; }
    .nowen-note-image-export-body a { color: ${dark ? "#79b8ff" : "#0969da"}; text-decoration: none; }
    .nowen-note-image-export-body strong { font-weight: 700; }
    .nowen-note-image-export-body ul, .nowen-note-image-export-body ol { margin: 10px 0; padding-left: 1.65em; }
    .nowen-note-image-export-body li { margin: 4px 0; }
    .nowen-note-image-export-body li > p { margin: 2px 0; }
    .nowen-note-image-export-body ul[data-type="taskList"] { padding-left: 0; list-style: none; }
    .nowen-note-image-export-body li[data-type="taskItem"], .nowen-note-image-export-body ul[data-type="taskList"] > li { display: flex; gap: 9px; align-items: flex-start; list-style: none; }
    .nowen-note-image-export-body input[type="checkbox"] { width: 15px; height: 15px; margin: 5px 0 0; accent-color: #4f7cff; }
    .nowen-note-image-export-body blockquote { margin: 14px 0; padding: 10px 16px; color: ${muted}; background: ${soft}; border-left: 4px solid ${border}; border-radius: 0 8px 8px 0; }
    .nowen-note-image-export-body hr { margin: 24px 0; border: 0; border-top: 1px solid ${border}; }
    .nowen-note-image-export-body table { width: 100% !important; max-width: 100% !important; min-width: 0 !important; margin: 16px 0; border-collapse: collapse; table-layout: fixed; font-size: 14px; overflow-wrap: anywhere; }
    .nowen-note-image-export-body col { min-width: 0 !important; max-width: none !important; }
    .nowen-note-image-export-body th, .nowen-note-image-export-body td { width: auto; min-width: 0 !important; max-width: none !important; border: 1px solid ${border}; padding: 8px 10px; vertical-align: top; white-space: normal !important; overflow-wrap: anywhere !important; word-break: break-word; }
    .nowen-note-image-export-body th > *, .nowen-note-image-export-body td > * { max-width: 100% !important; min-width: 0 !important; overflow-wrap: anywhere !important; }
    .nowen-note-image-export-body th { background: ${soft}; font-weight: 650; }
    .nowen-note-image-export-body img { display: block; max-width: 100%; height: auto; margin: 14px auto; border-radius: 8px; object-fit: contain; }
    .nowen-note-image-export-body img[align="left"], .nowen-note-image-export-body img[data-align="left"] { margin-left: 0; margin-right: auto; }
    .nowen-note-image-export-body img[align="right"], .nowen-note-image-export-body img[data-align="right"] { margin-left: auto; margin-right: 0; }
    .nowen-note-image-export-body figure { margin: 16px 0; }
    .nowen-note-image-export-body figcaption { margin-top: 6px; color: ${muted}; font-size: 12px; text-align: center; }
    .nowen-note-image-export-body code { padding: 2px 5px; border-radius: 4px; background: ${soft}; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: .91em; }
    .nowen-note-image-export-body pre { position: relative; margin: 16px 0; padding: 18px 18px 16px; overflow: hidden; border-radius: 10px; background: ${codeBg}; color: #e6edf3; white-space: pre-wrap; overflow-wrap: anywhere; }
    .nowen-note-image-export-body pre[data-language] { padding-top: 32px; }
    .nowen-note-image-export-body pre[data-language]::before { content: attr(data-language); position: absolute; top: 9px; right: 13px; color: #8b949e; font: 600 10px/1.2 ui-monospace, monospace; letter-spacing: .08em; }
    .nowen-note-image-export-body pre code { padding: 0; border-radius: 0; background: transparent; color: inherit; font-size: 12.5px; line-height: 1.6; }
    .nowen-note-image-export-body mark { padding: 0 2px; border-radius: 3px; background: ${dark ? "#5c4b14" : "#fff3a3"}; color: inherit; }
    .nowen-note-image-export-body .hljs-comment, .nowen-note-image-export-body .hljs-quote { color: #8b949e; }
    .nowen-note-image-export-body .hljs-keyword, .nowen-note-image-export-body .hljs-selector-tag, .nowen-note-image-export-body .hljs-type { color: #ff7b72; }
    .nowen-note-image-export-body .hljs-string, .nowen-note-image-export-body .hljs-attr, .nowen-note-image-export-body .hljs-template-tag { color: #a5d6ff; }
    .nowen-note-image-export-body .hljs-number, .nowen-note-image-export-body .hljs-literal { color: #79c0ff; }
    .nowen-note-image-export-body .hljs-title, .nowen-note-image-export-body .hljs-section, .nowen-note-image-export-body .hljs-function { color: #d2a8ff; }
    .nowen-note-image-export-body .hljs-variable, .nowen-note-image-export-body .hljs-params, .nowen-note-image-export-body .hljs-property { color: #ffa657; }
    .nowen-note-image-export-body .hljs-built_in, .nowen-note-image-export-body .hljs-symbol { color: #f2cc60; }
    .nowen-note-image-export-body .katex-display { overflow: hidden; margin: 16px 0; }
  `;
}

async function waitForHostAssets(host: HTMLElement, failures: NoteImageExportResourceFailure[]): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts?.ready) await timeout(Promise.resolve(fonts.ready).then(() => undefined), 8_000, undefined);

  const images = Array.from(host.querySelectorAll("img"));
  await Promise.all(images.map(async (image) => {
    try {
      if (typeof image.decode === "function") {
        await timeout(image.decode(), 8_000, undefined);
      } else if (!image.complete) {
        await timeout(new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }), 8_000, undefined);
      }
      if (!image.complete || image.naturalWidth === 0) {
        const src = image.getAttribute("src") || "unknown";
        if (!src.startsWith("data:image/svg+xml")) failures.push({ src, reason: "image decode failed" });
      }
    } catch (error) {
      failures.push({
        src: image.getAttribute("src") || "unknown",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

async function prepareHost(
  note: ExportableNoteImageSource,
  themeOption: NoteImageExportTheme,
  progress?: (progress: NoteImageExportProgress) => void,
): Promise<PreparedHost> {
  progress?.({ phase: "prepare", current: 0, total: 1, message: "正在生成最终预览…" });

  let bodyHtml = noteContentToExportHtml(note.content || "", note.contentText || "", note.contentFormat);
  const attachmentStats: ImgStats = { ok: 0, failed: 0, failures: [] };
  bodyHtml = await inlineRemoteImages(bodyHtml, attachmentStats, { noteId: note.id, noteTitle: note.title });

  const failedResources: NoteImageExportResourceFailure[] = attachmentStats.failures.map((failure) => ({
    src: failure.src,
    reason: failure.error,
  }));

  const DOMPurify = (await import("dompurify")).default;
  bodyHtml = DOMPurify.sanitize(bodyHtml, {
    ADD_TAGS: ["img", "figure", "figcaption", "input"],
    ADD_ATTR: [
      "src", "alt", "title", "width", "height", "style", "class", "align",
      "data-align", "data-type", "data-checked", "checked", "disabled", "colspan", "rowspan",
      "colwidth", "data-colwidth", "span",
    ],
  });

  progress?.({ phase: "assets", current: 0, total: 1, message: "正在加载图片和字体…" });
  bodyHtml = await inlineRemainingImages(bodyHtml, failedResources);

  const theme = currentTheme(themeOption);
  const bodyStyle = getComputedStyle(document.body);
  const fontFamily = bodyStyle.fontFamily || '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  const lineHeight = Number.parseFloat(bodyStyle.lineHeight) > 1.2 ? bodyStyle.lineHeight : "1.75";
  const styleText = buildStyle(theme, fontFamily, lineHeight);
  const background = theme === "dark" ? "#111318" : "#ffffff";

  const host = document.createElement("div");
  host.className = "nowen-note-image-export-host";
  Object.assign(host.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${EXPORT_WIDTH}px`,
    background,
    pointerEvents: "none",
    zIndex: "-1",
  });

  const style = document.createElement("style");
  style.textContent = styleText;
  host.appendChild(style);

  const article = document.createElement("article");
  article.className = "nowen-note-image-export-page";

  const title = document.createElement("h1");
  title.className = "nowen-note-image-export-title";
  title.textContent = note.title || "无标题笔记";
  article.appendChild(title);

  if (note.createdAt || note.updatedAt) {
    const meta = document.createElement("div");
    meta.className = "nowen-note-image-export-meta";
    const parts: string[] = [];
    if (note.createdAt) parts.push(`创建：${new Date(note.createdAt).toLocaleString()}`);
    if (note.updatedAt) parts.push(`更新：${new Date(note.updatedAt).toLocaleString()}`);
    meta.textContent = parts.join("  ·  ");
    article.appendChild(meta);
  }

  const body = document.createElement("div");
  body.className = "nowen-note-image-export-body";
  body.innerHTML = bodyHtml || "";
  normalizeExportTables(body, EXPORT_CONTENT_WIDTH);
  highlightCodeBlocks(body);
  article.appendChild(body);
  host.appendChild(article);
  document.body.appendChild(host);

  await waitForHostAssets(host, failedResources);
  const overflowingTables = findOverflowingExportTables(body, EXPORT_CONTENT_WIDTH);
  if (overflowingTables.length > 0) {
    throw new Error(`有 ${overflowingTables.length} 个表格仍超出导出画布，已停止生成可能缺列的图片`);
  }
  const height = Math.max(120, Math.ceil(article.scrollHeight));
  progress?.({ phase: "assets", current: 1, total: 1, message: "图片和字体已准备完成" });

  return {
    host,
    article,
    styleText,
    background,
    width: EXPORT_WIDTH,
    height,
    failedResources,
    cleanup: () => {
      try { host.remove(); } catch { /* noop */ }
    },
  };
}

function collectBlockBottoms(article: HTMLElement): number[] {
  const articleRect = article.getBoundingClientRect();
  const selector = [
    ":scope > *", "h1", "h2", "h3", "p", "li", "pre", "table", "blockquote", "figure", "img", "hr",
  ].join(",");
  return Array.from(article.querySelectorAll(selector))
    .map((element) => Math.ceil((element as HTMLElement).getBoundingClientRect().bottom - articleRect.top))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
}

export function computePageSlices(
  totalHeight: number,
  pageHeight = PAGE_SLICE_HEIGHT,
  blockBottoms: number[] = [],
): Array<{ offset: number; height: number }> {
  if (totalHeight <= pageHeight) return [{ offset: 0, height: totalHeight }];

  const slices: Array<{ offset: number; height: number }> = [];
  let offset = 0;
  while (offset < totalHeight) {
    const target = Math.min(totalHeight, offset + pageHeight);
    if (target === totalHeight) {
      slices.push({ offset, height: totalHeight - offset });
      break;
    }

    const minimumUsefulBreak = offset + Math.floor(pageHeight * 0.58);
    const candidates = blockBottoms.filter((bottom) => bottom >= minimumUsefulBreak && bottom <= target);
    const end = candidates.length ? candidates[candidates.length - 1] : target;
    const safeEnd = end <= offset ? target : end;
    slices.push({ offset, height: safeEnd - offset });
    offset = safeEnd;
  }
  return slices;
}

export function chooseRasterPlan(args: {
  width: number;
  height: number;
  requestedScale: number;
  layout: NoteImageExportLayout;
  blockBottoms?: number[];
}): RasterPlan {
  const requestedScale = clamp(args.requestedScale || 1, 1, 3);
  const dimensionScale = Math.min(
    requestedScale,
    MAX_CANVAS_DIMENSION / Math.max(1, args.width),
    MAX_CANVAS_DIMENSION / Math.max(1, args.height),
  );
  const areaScale = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, args.width * args.height));
  const safeScale = Math.min(dimensionScale, areaScale);
  const longIsSafe = safeScale >= 0.85 && args.height * safeScale <= MAX_CANVAS_DIMENSION;

  if (args.layout === "pages" || !longIsSafe || (args.layout === "auto" && args.height > 9_000)) {
    return {
      mode: "pages",
      scale: Math.min(requestedScale, 2),
      slices: computePageSlices(args.height, PAGE_SLICE_HEIGHT, args.blockBottoms || []),
      warning: args.layout !== "pages"
        ? "内容超过浏览器安全 Canvas 尺寸，已自动改为分页图片，避免生成空白图。"
        : undefined,
    };
  }

  return {
    mode: "long",
    scale: clamp(safeScale, 0.85, requestedScale),
    slices: [{ offset: 0, height: args.height }],
    warning: safeScale < requestedScale
      ? `为避免 Canvas 超限，导出倍率已自动调整为 ${safeScale.toFixed(2)}x。`
      : undefined,
  };
}

async function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
  if (blob) return blob;
  const response = await fetch(canvas.toDataURL(mimeType, quality));
  return response.blob();
}

async function renderSlice(
  prepared: PreparedHost,
  slice: { offset: number; height: number },
  scale: number,
): Promise<HTMLCanvasElement> {
  const clone = prepared.host.cloneNode(true) as HTMLDivElement;
  clone.style.left = "-100000px";
  clone.style.width = `${prepared.width}px`;
  clone.style.height = `${slice.height}px`;
  clone.style.overflow = "hidden";
  clone.style.zIndex = "-1";
  const article = clone.querySelector(".nowen-note-image-export-page") as HTMLElement | null;
  if (!article) throw new Error("EXPORT_ARTICLE_MISSING");
  article.style.transform = `translateY(-${slice.offset}px)`;
  article.style.transformOrigin = "top left";
  document.body.appendChild(clone);

  try {
    await waitForHostAssets(clone, []);
    const html2canvas = (await import("html2canvas")).default;
    return await html2canvas(clone, {
      backgroundColor: prepared.background,
      scale,
      useCORS: true,
      allowTaint: false,
      logging: false,
      width: prepared.width,
      height: slice.height,
      windowWidth: prepared.width,
      windowHeight: slice.height,
      scrollX: 0,
      scrollY: 0,
      imageTimeout: RESOURCE_TIMEOUT_MS,
    });
  } finally {
    clone.remove();
  }
}

function createSvgBlob(prepared: PreparedHost): Blob {
  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const xhtmlDoc = document.implementation.createDocument(XHTML_NS, "html", null);
  const body = xhtmlDoc.createElementNS(XHTML_NS, "body");
  xhtmlDoc.documentElement.appendChild(body);
  const imported = xhtmlDoc.importNode(prepared.article, true) as Element;
  body.appendChild(imported);
  const serialized = new XMLSerializer().serializeToString(imported);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${prepared.width}" height="${prepared.height}" viewBox="0 0 ${prepared.width} ${prepared.height}">
      <foreignObject width="100%" height="100%">
        <div xmlns="${XHTML_NS}" style="width:${prepared.width}px;height:${prepared.height}px;background:${prepared.background};">
          <style><![CDATA[${prepared.styleText}]]></style>${serialized}
        </div>
      </foreignObject>
    </svg>`;
  return new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
}

async function zipFiles(files: NoteImageExportFile[], baseName: string): Promise<{ blob: Blob; name: string }> {
  const zip = new JSZip();
  for (const file of files) zip.file(file.fileName, file.blob);
  zip.file("README.txt", "该压缩包由 Nowen Note 分页图片导出生成。按文件名序号从上到下阅读。\n");
  return {
    blob: await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } }),
    name: `${baseName}-pages.zip`,
  };
}

async function saveFiles(
  files: NoteImageExportFile[],
  destination: NoteImageExportDestination,
  baseName: string,
  warnings: string[],
): Promise<{ displayPath?: string; openUri?: string; files: NoteImageExportFile[]; canceled?: boolean }> {
  if (destination === "gallery") {
    if (!isAndroidNative()) throw new Error("当前平台不支持直接保存到系统相册");
    for (const file of files) {
      if (file.mimeType === "image/svg+xml") throw new Error("SVG 不能直接保存到 Android 相册，请选择“系统文件”或“分享”");
      const saved = await saveImageToGalleryDetailed({ blob: file.blob, fileName: file.fileName, mimeType: file.mimeType });
      file.uri = saved.uri;
      file.displayPath = saved.displayPath;
    }
    return {
      displayPath: files.length === 1 ? files[0].displayPath : `Pictures/Nowen Note（${files.length} 张）`,
      openUri: files[0]?.uri,
      files,
    };
  }

  if (destination === "files") {
    if (isAndroidNative()) {
      const target = files.length === 1
        ? { blob: files[0].blob, name: files[0].fileName, mime: files[0].mimeType }
        : { ...(await zipFiles(files, baseName)), mime: "application/zip" };
      const saved = await saveBlobToSystemFile({ blob: target.blob, fileName: target.name, mimeType: target.mime });
      if (saved.canceled) return { files, canceled: true };
      return { displayPath: saved.displayPath || saved.uri, openUri: saved.uri, files };
    }
    const target = files.length === 1
      ? { blob: files[0].blob, name: files[0].fileName }
      : await zipFiles(files, baseName);
    saveAs(target.blob, target.name);
    return { displayPath: "浏览器下载目录（具体位置由浏览器设置决定）", files };
  }

  if (destination === "share") {
    if (isAndroidNative()) {
      await shareNativeFiles(files.map((file) => ({ blob: file.blob, fileName: file.fileName, mimeType: file.mimeType })));
      return { displayPath: "已打开 Android 系统分享面板", files };
    }

    const shareFiles = files.map((file) => new File([file.blob], file.fileName, { type: file.mimeType }));
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: shareFiles }))) {
      await navigator.share({ files: shareFiles, title: baseName });
      return { displayPath: "已打开系统分享面板", files };
    }
    warnings.push("当前浏览器不支持文件分享，已改为下载。 ");
  }

  const target = files.length === 1
    ? { blob: files[0].blob, name: files[0].fileName }
    : await zipFiles(files, baseName);
  saveAs(target.blob, target.name);
  return { displayPath: "浏览器下载目录（具体位置由浏览器设置决定）", files };
}

export async function exportNoteImageDetailed(
  note: ExportableNoteImageSource,
  options: NoteImageExportOptions,
): Promise<NoteImageExportResult> {
  const format = options.format || "png";
  const destination = options.destination || (isAndroidNative() ? "gallery" : "download");
  const warnings: string[] = [];
  let prepared: PreparedHost | null = null;

  try {
    prepared = await prepareHost(note, options.theme || "current", options.onProgress);
    const baseName = sanitizeFilename(note.title || "note");
    let files: NoteImageExportFile[] = [];
    let paginated = false;

    if (format === "svg") {
      options.onProgress?.({ phase: "render", current: 0, total: 1, message: "正在生成 SVG…" });
      const blob = createSvgBlob(prepared);
      files = [{
        blob,
        fileName: `${baseName}.svg`,
        mimeType: "image/svg+xml",
        width: prepared.width,
        height: prepared.height,
      }];
      options.onProgress?.({ phase: "render", current: 1, total: 1, message: "SVG 已生成" });
    } else {
      const plan = chooseRasterPlan({
        width: prepared.width,
        height: prepared.height,
        requestedScale: options.pixelRatio || Math.min(window.devicePixelRatio || 1, 2),
        layout: options.layout || "auto",
        blockBottoms: collectBlockBottoms(prepared.article),
      });
      if (plan.warning) warnings.push(plan.warning);
      paginated = plan.mode === "pages";
      const mimeType = format === "jpg" ? "image/jpeg" : "image/png";
      const quality = clamp(options.quality ?? 0.9, 0.55, 0.98);

      for (let index = 0; index < plan.slices.length; index += 1) {
        options.onProgress?.({
          phase: "render",
          current: index,
          total: plan.slices.length,
          message: plan.slices.length > 1 ? `正在渲染第 ${index + 1}/${plan.slices.length} 页…` : "正在渲染高清图片…",
        });
        const canvas = await renderSlice(prepared, plan.slices[index], plan.scale);
        const blob = await canvasToBlob(canvas, mimeType, quality);
        const suffix = plan.slices.length > 1 ? `-${String(index + 1).padStart(2, "0")}` : "";
        files.push({
          blob,
          fileName: `${baseName}${suffix}.${format === "jpg" ? "jpg" : "png"}`,
          mimeType,
          width: canvas.width,
          height: canvas.height,
        });
      }
      options.onProgress?.({ phase: "render", current: plan.slices.length, total: plan.slices.length, message: "图片渲染完成" });
    }

    options.onProgress?.({ phase: "save", current: 0, total: files.length, message: "正在保存导出结果…" });
    const saved = await saveFiles(files, destination, baseName, warnings);
    if (saved.canceled) {
      return {
        ok: false,
        canceled: true,
        format,
        destination,
        files,
        warnings,
        failedResources: prepared.failedResources,
        paginated,
      };
    }
    options.onProgress?.({ phase: "save", current: files.length, total: files.length, message: "导出完成" });

    if (prepared.failedResources.length) {
      warnings.push(`有 ${prepared.failedResources.length} 张图片或资源加载失败，导出结果中已放置占位图。`);
    }

    return {
      ok: true,
      format,
      destination,
      files: saved.files,
      warnings,
      failedResources: prepared.failedResources,
      paginated,
      displayPath: saved.displayPath,
      openUri: saved.openUri,
    };
  } catch (error) {
    return {
      ok: false,
      format,
      destination,
      files: [],
      warnings,
      failedResources: prepared?.failedResources || [],
      paginated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    prepared?.cleanup();
  }
}
