import { generateJSON } from "@tiptap/core";
import type { Note } from "@/types";
import { api, getBaseUrl, getCurrentWorkspace } from "@/lib/api";
import { getTiptapExtensions } from "@/lib/contentFormat";
import {
  DOCX_IMPORT_LIMITS,
  getDocxFileViolation,
  getImportedNoteIntegrityError,
  getImportedNoteSemanticError,
  type DocxArchiveStats,
} from "@/lib/docxImportSafety";
import type {
  DocxImportMetrics,
  DocxImportProgressUpdate,
} from "@/lib/docxImportProgress";

export type DocxImportErrorCode =
  | "IMPORT_CANCELLED"
  | "DOCX_INVALID"
  | "DOCX_UNSAFE"
  | "DOCX_PARSE_FAILED"
  | "DOCX_EMPTY"
  | "DOCX_HTML_TOO_LARGE"
  | "DOCX_TEXT_TOO_LARGE"
  | "DOCX_CONVERT_FAILED"
  | "DOCX_CONTENT_TOO_LARGE"
  | "NOTE_CREATE_FAILED"
  | "ATTACHMENT_UPLOAD_FAILED"
  | "SAVE_TIMEOUT"
  | "SAVE_CONFLICT"
  | "SAVE_PAYLOAD_TOO_LARGE"
  | "SAVE_FAILED"
  | "SAVE_INTEGRITY_FAILED"
  | "VERIFY_FAILED";

export class DocxImportError extends Error {
  readonly code: DocxImportErrorCode;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DocxImportErrorCode,
    message: string,
    options?: { status?: number; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DocxImportError";
    this.code = code;
    this.status = options?.status;
    this.details = options?.details;
  }
}

export interface ImportDocxAsNoteParams {
  notebookId: string;
  file: File;
  signal?: AbortSignal;
  onProgress?: (update: DocxImportProgressUpdate) => void;
}

export interface ImportDocxAsNoteResult {
  note: Note;
  previewText: string;
  metrics: DocxImportMetrics;
  warnings: string[];
}

interface WorkerImage {
  id: string;
  contentType: string;
  buffer: ArrayBuffer;
}

interface WorkerParseResult {
  html: string;
  images: WorkerImage[];
  archiveStats: DocxArchiveStats;
  mammothWarnings: string[];
  parseDurationMs: number;
}

interface ConfirmedRequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function createAbortError(): DocxImportError {
  const error = new DocxImportError("IMPORT_CANCELLED", "Word 文档导入已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function report(
  callback: ImportDocxAsNoteParams["onProgress"],
  update: DocxImportProgressUpdate,
): void {
  callback?.(update);
}

function getAuthHeaders(): Record<string, string> {
  const token = typeof localStorage !== "undefined" ? localStorage.getItem("nowen-token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function confirmedJson<T>(
  path: string,
  options: ConfirmedRequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const timeoutMs = options.timeoutMs ?? 120_000;
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${getBaseUrl()}${path}`, {
      method: options.method || "GET",
      credentials: "include",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload: Record<string, unknown> = await response.json().catch(() => ({}));
    if (!response.ok) {
      const status = response.status;
      const message = typeof payload.error === "string" ? payload.error : `HTTP ${status}`;
      if (status === 409) {
        throw new DocxImportError("SAVE_CONFLICT", `保存时检测到版本冲突：${message}`, {
          status,
          details: payload,
        });
      }
      if (status === 413) {
        throw new DocxImportError(
          "SAVE_PAYLOAD_TOO_LARGE",
          "转换后的文档仍超过服务器请求上限。请压缩文档、拆分章节或减少超大对象后重试。",
          { status, details: payload },
        );
      }
      throw new DocxImportError("SAVE_FAILED", message, { status, details: payload });
    }
    return payload as T;
  } catch (error) {
    if (externalSignal?.aborted) throw createAbortError();
    if (timedOut) {
      throw new DocxImportError(
        "SAVE_TIMEOUT",
        `服务器在 ${Math.round(timeoutMs / 1000)} 秒内未确认写入，导入已停止并尝试回滚。`,
        { cause: error },
      );
    }
    if (error instanceof DocxImportError) throw error;
    throw new DocxImportError(
      "SAVE_FAILED",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

function workerErrorCode(code: string | undefined): DocxImportErrorCode {
  if (code === "DOCX_EMPTY") return "DOCX_EMPTY";
  if (code && [
    "TOO_MANY_ENTRIES",
    "UNCOMPRESSED_TOO_LARGE",
    "XML_TOO_LARGE",
    "TOO_MANY_IMAGES",
    "IMAGE_TOO_LARGE",
    "EXPANSION_RATIO_TOO_HIGH",
  ].includes(code)) return "DOCX_UNSAFE";
  return "DOCX_PARSE_FAILED";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function readWorkerImages(value: unknown): WorkerImage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is WorkerImage => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<WorkerImage>;
    return typeof candidate.id === "string"
      && typeof candidate.contentType === "string"
      && candidate.buffer instanceof ArrayBuffer;
  });
}

async function parseDocxInWorker(
  file: File,
  signal: AbortSignal | undefined,
  onProgress: ImportDocxAsNoteParams["onProgress"],
): Promise<WorkerParseResult> {
  throwIfAborted(signal);
  report(onProgress, {
    stage: "read",
    percent: 5,
    message: "正在异步读取 DOCX 文件…",
    metrics: { originalBytes: file.size },
  });
  const buffer = await file.arrayBuffer();
  throwIfAborted(signal);

  return new Promise<WorkerParseResult>((resolve, reject) => {
    const worker = new Worker(new URL("../workers/docxImport.worker.ts", import.meta.url), {
      type: "module",
      name: "nowen-docx-import",
    });
    const requestId = crypto.randomUUID();
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const finishResolve = (value: WorkerParseResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => finishReject(createAbortError());
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.onerror = (event) => {
      finishReject(new DocxImportError(
        "DOCX_PARSE_FAILED",
        event.message || "Word 解析 Worker 异常退出",
      ));
    };
    worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      const message = event.data;
      if (message.requestId !== requestId) return;
      if (message.type === "progress") {
        report(onProgress, {
          stage: String(message.stage || "parse") as DocxImportProgressUpdate["stage"],
          percent: Number(message.percent || 0),
          message: String(message.message || "正在解析 Word 文档…"),
          metrics: {
            archiveStats: message.archiveStats as DocxArchiveStats | undefined,
            imageCount: typeof message.imageCount === "number" ? message.imageCount : undefined,
          },
        });
        return;
      }
      if (message.type === "error") {
        finishReject(new DocxImportError(
          workerErrorCode(typeof message.code === "string" ? message.code : undefined),
          String(message.message || "Word 文档解析失败"),
          {
            details: {
              workerCode: message.code,
              archiveStats: message.archiveStats,
            },
          },
        ));
        return;
      }
      if (message.type === "result") {
        const archiveStats = message.archiveStats as DocxArchiveStats | undefined;
        if (!archiveStats) {
          finishReject(new DocxImportError("DOCX_PARSE_FAILED", "Worker 未返回 DOCX 预检结果"));
          return;
        }
        finishResolve({
          html: String(message.html || ""),
          images: readWorkerImages(message.images),
          archiveStats,
          mammothWarnings: readStringArray(message.mammothWarnings),
          parseDurationMs: Number(message.parseDurationMs || 0),
        });
      }
    };

    worker.postMessage({
      type: "parse",
      requestId,
      fileName: file.name,
      originalBytes: file.size,
      buffer,
    }, [buffer]);
  });
}

export function extractTitleFromDocxHtml(html: string, fallback: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const heading = template.content.querySelector("h1, h2");
  const paragraph = template.content.querySelector("p");
  const value = (heading?.textContent || paragraph?.textContent || fallback || "导入的 Word 文档")
    .replace(/\s+/g, " ")
    .trim();
  return (value || "导入的 Word 文档").slice(0, heading ? 120 : 60);
}

export function docxHtmlToPlainText(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  return (template.content.textContent || "").replace(/\s+/g, " ").trim();
}

export function replaceDocxImagePlaceholders(
  html: string,
  urls: ReadonlyMap<string, string> | Record<string, string>,
): string {
  const lookup = urls instanceof Map ? urls : new Map(Object.entries(urls));
  const template = document.createElement("template");
  template.innerHTML = html;
  const images = Array.from(template.content.querySelectorAll<HTMLImageElement>("img"));
  for (const image of images) {
    const attributeId = image.getAttribute("data-docx-image-id") || "";
    const source = image.getAttribute("src") || "";
    const protocolId = source.startsWith("nowen-docx-image://")
      ? source.slice("nowen-docx-image://".length).replace(/^\/+/, "")
      : "";
    const id = attributeId || protocolId;
    if (!id) continue;
    const url = lookup.get(id);
    if (!url) {
      throw new DocxImportError(
        "ATTACHMENT_UPLOAD_FAILED",
        `图片 ${id} 没有对应的附件地址，已停止保存以避免正文缺图`,
      );
    }
    image.setAttribute("src", url);
    image.removeAttribute("data-docx-image-id");
  }
  if (/nowen-docx-image:\/\//i.test(template.innerHTML)) {
    throw new DocxImportError("ATTACHMENT_UPLOAD_FAILED", "仍有 Word 图片未完成附件上传");
  }
  return template.innerHTML;
}

export function convertDocxHtmlToTiptap(html: string): string {
  try {
    const json = generateJSON(html, getTiptapExtensions());
    const content = Array.isArray(json?.content) ? json.content : [];
    const sourceText = docxHtmlToPlainText(html);
    const looksEmpty = content.length === 0 || (
      content.length === 1
      && content[0]?.type === "paragraph"
      && !content[0]?.content
    );
    if (looksEmpty && sourceText.length > 0) throw new Error("Tiptap 转换结果为空");
    const serialized = JSON.stringify(json);
    if (!serialized || serialized === "{}") throw new Error("Tiptap JSON 无效");
    return serialized;
  } catch (error) {
    if (error instanceof DocxImportError) throw error;
    throw new DocxImportError(
      "DOCX_CONVERT_FAILED",
      `Word 正文无法转换为可编辑富文本：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function extensionForContentType(contentType: string): string {
  const normalized = contentType.toLowerCase().split(";")[0].trim();
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/x-emf": "emf",
    "image/x-wmf": "wmf",
  };
  return map[normalized] || "bin";
}

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function uploadImages(
  noteId: string,
  images: WorkerImage[],
  signal: AbortSignal | undefined,
  onProgress: ImportDocxAsNoteParams["onProgress"],
  uploadedIds: string[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  let cursor = 0;
  let completed = 0;
  const concurrency = Math.min(2, Math.max(1, images.length));

  const uploadWorker = async () => {
    while (cursor < images.length) {
      throwIfAborted(signal);
      const index = cursor;
      cursor += 1;
      const image = images[index];
      const extension = extensionForContentType(image.contentType);
      const file = new File(
        [image.buffer],
        `${image.id}.${extension}`,
        { type: image.contentType || "application/octet-stream" },
      );
      try {
        const uploaded = await api.attachments.upload(noteId, file);
        uploadedIds.push(uploaded.id);
        urls.set(image.id, uploaded.url);
      } catch (error) {
        throw new DocxImportError(
          "ATTACHMENT_UPLOAD_FAILED",
          `第 ${index + 1}/${images.length} 张图片上传失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error, details: { imageIndex: index, contentType: image.contentType } },
        );
      }
      completed += 1;
      report(onProgress, {
        stage: "upload",
        percent: 50 + Math.round((completed / Math.max(1, images.length)) * 25),
        message: `正在保存 Word 图片 ${completed}/${images.length}…`,
        metrics: { uploadedImages: completed, imageCount: images.length },
      });
      throwIfAborted(signal);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => uploadWorker()));
  return urls;
}

async function rollbackImport(noteId: string | null, attachmentIds: string[]): Promise<void> {
  if (!noteId) return;
  try {
    await confirmedJson(`/notes/${encodeURIComponent(noteId)}`, {
      method: "DELETE",
      timeoutMs: 30_000,
    });
    return;
  } catch {
    // Workspace editors may not have permanent-delete permission.
  }
  await Promise.allSettled(attachmentIds.map((id) => api.attachments.remove(id)));
  try {
    await confirmedJson(`/notes/${encodeURIComponent(noteId)}`, {
      method: "PUT",
      timeoutMs: 30_000,
      body: { isTrashed: 1 },
    });
  } catch {
    // Best-effort rollback; diagnostics deliberately exclude note content.
  }
}

function enrichError(error: unknown, metrics: DocxImportMetrics): Error {
  if (error instanceof DocxImportError) {
    return new DocxImportError(error.code, error.message, {
      status: error.status,
      cause: error,
      details: {
        ...(error.details || {}),
        originalBytes: metrics.originalBytes,
        imageCount: metrics.imageCount,
        uploadedImages: metrics.uploadedImages,
        htmlChars: metrics.htmlChars,
        contentChars: metrics.contentChars,
        contentTextChars: metrics.contentTextChars,
      },
    });
  }
  return new DocxImportError(
    "SAVE_FAILED",
    error instanceof Error ? error.message : String(error || "Word 文档导入失败"),
    { cause: error },
  );
}

export async function importDocxAsNoteSafe(
  params: ImportDocxAsNoteParams,
): Promise<ImportDocxAsNoteResult> {
  const startedAt = performance.now();
  const violation = getDocxFileViolation(params.file);
  if (violation) {
    throw new DocxImportError(
      violation.code === "UNSUPPORTED_FILE" || violation.code === "FILE_TOO_LARGE"
        ? "DOCX_INVALID"
        : "DOCX_UNSAFE",
      violation.message,
    );
  }
  if (!params.notebookId) throw new DocxImportError("DOCX_INVALID", "未指定目标笔记本");

  const metrics: DocxImportMetrics = { originalBytes: params.file.size };
  const warnings: string[] = [];
  let noteId: string | null = null;
  const uploadedAttachmentIds: string[] = [];

  try {
    const parsed = await parseDocxInWorker(params.file, params.signal, params.onProgress);
    metrics.archiveStats = parsed.archiveStats;
    metrics.imageCount = parsed.images.length;
    metrics.parseDurationMs = parsed.parseDurationMs;
    metrics.mammothWarnings = parsed.mammothWarnings;
    metrics.htmlChars = parsed.html.length;
    warnings.push(...parsed.mammothWarnings);

    if (parsed.html.length > DOCX_IMPORT_LIMITS.maxHtmlChars) {
      throw new DocxImportError(
        "DOCX_HTML_TOO_LARGE",
        `Word 转换后的 HTML 过大（${parsed.html.length.toLocaleString()} 字符），请拆分文档后重试。`,
      );
    }
    const title = extractTitleFromDocxHtml(
      parsed.html,
      params.file.name.replace(/\.docx$/i, ""),
    );
    const initialText = docxHtmlToPlainText(parsed.html);
    if (!initialText && parsed.images.length === 0) {
      throw new DocxImportError("DOCX_EMPTY", "文档内容为空或无法解析出正文");
    }
    if (initialText.length > DOCX_IMPORT_LIMITS.maxPlainTextChars) {
      throw new DocxImportError(
        "DOCX_TEXT_TOO_LARGE",
        `文档纯文本超过安全上限（${initialText.length.toLocaleString()} 字符），请拆分后重试。`,
      );
    }

    report(params.onProgress, {
      stage: "create",
      percent: 47,
      message: "解析完成，正在创建可回滚的导入事务…",
      metrics,
    });
    throwIfAborted(params.signal);
    noteId = crypto.randomUUID();
    const emptyContent = JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] });
    const workspaceId = getCurrentWorkspace();
    let baseNote: Note;
    try {
      baseNote = await confirmedJson<Note>("/notes", {
        method: "POST",
        signal: params.signal,
        timeoutMs: 120_000,
        body: {
          id: noteId,
          notebookId: params.notebookId,
          title,
          content: emptyContent,
          contentText: "",
          contentFormat: "tiptap-json",
          ...(workspaceId && workspaceId !== "personal" ? { workspaceId } : {}),
        },
      });
    } catch (error) {
      if (error instanceof DocxImportError) throw error;
      throw new DocxImportError("NOTE_CREATE_FAILED", "无法创建导入目标笔记", { cause: error });
    }

    let html = parsed.html;
    let imageUrls = new Map<string, string>();
    if (parsed.images.length > 0) {
      report(params.onProgress, {
        stage: "upload",
        percent: 50,
        message: `正在把 ${parsed.images.length} 张图片存入附件库…`,
        metrics: { imageCount: parsed.images.length, uploadedImages: 0 },
      });
      imageUrls = await uploadImages(
        noteId,
        parsed.images,
        params.signal,
        params.onProgress,
        uploadedAttachmentIds,
      );
      metrics.uploadedImages = uploadedAttachmentIds.length;
      html = replaceDocxImagePlaceholders(html, imageUrls);
    }

    report(params.onProgress, {
      stage: "convert",
      percent: 80,
      message: "正在转换为可编辑富文本…",
      metrics: { uploadedImages: uploadedAttachmentIds.length },
    });
    await yieldToBrowser();
    throwIfAborted(params.signal);
    const contentText = docxHtmlToPlainText(html);
    const content = convertDocxHtmlToTiptap(html);
    metrics.contentChars = content.length;
    metrics.contentTextChars = contentText.length;
    if (content.length > DOCX_IMPORT_LIMITS.maxContentChars) {
      throw new DocxImportError(
        "DOCX_CONTENT_TOO_LARGE",
        `转换后的富文本正文过大（${content.length.toLocaleString()} 字符），请拆分文档后重试。`,
      );
    }

    report(params.onProgress, {
      stage: "save",
      percent: 88,
      message: "正在等待服务器确认完整正文写入…",
      metrics,
    });
    throwIfAborted(params.signal);
    const updated = await confirmedJson<Note>(`/notes/${encodeURIComponent(noteId)}`, {
      method: "PUT",
      signal: params.signal,
      timeoutMs: 180_000,
      body: {
        title,
        content,
        contentText,
        contentFormat: "tiptap-json",
        version: baseNote.version,
      },
    });
    const responseIntegrityError = getImportedNoteSemanticError({
      expectedId: noteId,
      expectedContentText: contentText,
      expectedContentFormat: "tiptap-json",
      expectedAttachmentUrls: Array.from(imageUrls.values()),
      minimumVersion: baseNote.version + 1,
      actual: updated,
    });
    if (responseIntegrityError) {
      throw new DocxImportError("SAVE_INTEGRITY_FAILED", responseIntegrityError);
    }

    report(params.onProgress, {
      stage: "verify",
      percent: 96,
      message: "正在重新读取服务器数据并校验刷新后完整性…",
      metrics,
    });
    const persisted = await confirmedJson<Note>(`/notes/${encodeURIComponent(noteId)}`, {
      signal: params.signal,
      timeoutMs: 180_000,
    });
    const persistedIntegrityError = getImportedNoteIntegrityError({
      expectedId: noteId,
      expectedContent: updated.content,
      expectedContentText: updated.contentText,
      expectedContentFormat: updated.contentFormat,
      minimumVersion: updated.version,
      actual: persisted,
    });
    if (persistedIntegrityError) {
      throw new DocxImportError("VERIFY_FAILED", persistedIntegrityError);
    }

    metrics.totalDurationMs = Math.round(performance.now() - startedAt);
    report(params.onProgress, {
      stage: "complete",
      percent: 100,
      message: "导入完成，刷新后内容校验通过",
      metrics,
    });
    return {
      note: persisted,
      previewText: contentText.slice(0, 200),
      metrics,
      warnings,
    };
  } catch (error) {
    await rollbackImport(noteId, uploadedAttachmentIds);
    throw enrichError(error, metrics);
  }
}
