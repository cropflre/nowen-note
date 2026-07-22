import type { Context } from "hono";
import {
  handleReliableExportDownload,
  MAX_MARKDOWN_EXPORT_REQUEST_BYTES,
  ReliableExportBusyError,
  ReliableExportPayloadTooLargeError,
  reliableExportTestUtils,
  ReliableExportValidationError,
  stageReliableGeneratedExport,
  validatePreparedMarkdownNotes,
  type PreparedMarkdownAsset,
  type PreparedMarkdownNote,
  type ReliableExportJobSnapshot,
} from "./reliableExportJobs";
import {
  createRoundTripMarkdownExportJob,
  getRoundTripMarkdownExportJob,
  handleRoundTripMarkdownDownload,
} from "./roundTripMarkdownExportJobs";

export type { PreparedMarkdownAsset, PreparedMarkdownNote };
export type MarkdownExportJobSnapshot = ReliableExportJobSnapshot;
export const markdownExportTestUtils = reliableExportTestUtils;

const REQUEST_JSON_PATCH_FLAG = Symbol.for("nowen.reliableExport.requestJsonPatched");
const globalFlags = globalThis as typeof globalThis & Record<symbol, boolean>;

async function readRequestJsonWithLimit(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ReliableExportPayloadTooLargeError(
      `导出请求体超过 ${Math.floor(maxBytes / 1024 / 1024)}MB`,
      "MARKDOWN_EXPORT_REQUEST_TOO_LARGE",
    );
  }
  const body = request.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("export request too large").catch(() => undefined);
        throw new ReliableExportPayloadTooLargeError(
          `导出请求体超过 ${Math.floor(maxBytes / 1024 / 1024)}MB`,
          "MARKDOWN_EXPORT_REQUEST_TOO_LARGE",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8"));
    if (Array.isArray(parsed?.notes)) validatePreparedMarkdownNotes(parsed.notes);
    return parsed;
  } catch (error) {
    if (
      error instanceof ReliableExportPayloadTooLargeError ||
      error instanceof ReliableExportValidationError
    ) throw error;
    throw new ReliableExportValidationError("导出请求 JSON 无效", "INVALID_EXPORT_JSON");
  }
}

if (typeof Request !== "undefined" && !globalFlags[REQUEST_JSON_PATCH_FLAG]) {
  globalFlags[REQUEST_JSON_PATCH_FLAG] = true;
  const nativeJson = Request.prototype.json;
  Request.prototype.json = async function patchedJson(): Promise<any> {
    let pathname = "";
    try { pathname = new URL(this.url).pathname; } catch { /* use native parser */ }
    if (this.method.toUpperCase() === "POST" && pathname.endsWith("/api/export/markdown-package/jobs")) {
      return readRequestJsonWithLimit(this, MAX_MARKDOWN_EXPORT_REQUEST_BYTES);
    }
    return nativeJson.call(this);
  };
}

export class MarkdownExportBusyError extends Error {
  code: string;
  constructor(message = "已有导出任务正在生成，请等待当前任务完成", code = "EXPORT_JOB_BUSY") {
    super(message);
    this.code = code;
  }
}

function translateError(error: unknown): never {
  if (
    error instanceof ReliableExportBusyError ||
    error instanceof ReliableExportPayloadTooLargeError ||
    error instanceof ReliableExportValidationError
  ) {
    throw new MarkdownExportBusyError(error.message, error.code);
  }
  throw error;
}

export function createMarkdownExportJob(params: {
  userId: string;
  notes: PreparedMarkdownNote[];
  inlineImages: boolean;
  layout?: "notebooks" | "flat";
  filenameBase?: string;
}): MarkdownExportJobSnapshot {
  try {
    return createRoundTripMarkdownExportJob(params);
  } catch (error) {
    return translateError(error);
  }
}

export function getMarkdownExportJob(jobId: string, userId: string): MarkdownExportJobSnapshot | null {
  return getRoundTripMarkdownExportJob(jobId, userId);
}

function inferContentType(filename: string, fallback: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return fallback;
}

export async function stageGeneratedExport(params: {
  userId: string;
  filename: string;
  contentType: string;
  body: ReadableStream<Uint8Array>;
  contentLength?: number;
}): Promise<{ downloadToken: string; filename: string; size: number }> {
  return stageReliableGeneratedExport({
    ...params,
    contentType: inferContentType(params.filename, params.contentType),
  });
}

export function handleMarkdownExportDownload(c: Context): Response {
  return handleRoundTripMarkdownDownload(c) || handleReliableExportDownload(c);
}
