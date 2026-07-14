import archiver from "archiver";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import {
  getAttachmentStorageInfo,
  getLocalAttachmentPath,
  readAttachmentObject,
} from "./attachment-storage";

const EXPORT_TMP_PREFIX = "nowen-reliable-export-";
const EXPORT_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export const MAX_MARKDOWN_EXPORT_REQUEST_BYTES = 256 * 1024 * 1024;
export const MAX_MARKDOWN_EXPORT_NOTES = 10_000;
export const MAX_MARKDOWN_TEXT_BYTES = 64 * 1024 * 1024;
export const MAX_INLINE_ASSET_BYTES = 128 * 1024 * 1024;
export const MAX_STAGED_EXPORT_BYTES = 512 * 1024 * 1024;
const MAX_STAGED_EXPORTS_PER_USER = 5;

export interface PreparedMarkdownAsset {
  relPath: string;
  base64: string;
}

export interface PreparedMarkdownNote {
  id: string;
  title: string;
  notebookName: string | null;
  createdAt: string;
  updatedAt: string;
  contentFormat?: string;
  markdown: string;
  inlineAssets?: PreparedMarkdownAsset[];
}

export interface ReliableExportJobSnapshot {
  id: string;
  state: "queued" | "building" | "ready" | "error";
  current: number;
  total: number;
  message: string;
  filename?: string;
  downloadToken?: string;
  warnings: number;
}

export class ReliableExportBusyError extends Error {
  readonly code = "EXPORT_JOB_BUSY";
  readonly status = 409;

  constructor() {
    super("已有导出任务正在生成，请等待当前任务完成");
  }
}

export class ReliableExportPayloadTooLargeError extends Error {
  readonly status = 413;

  constructor(
    message: string,
    readonly code = "EXPORT_PAYLOAD_TOO_LARGE",
  ) {
    super(message);
  }
}

export class ReliableExportValidationError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly code = "INVALID_EXPORT_PAYLOAD",
  ) {
    super(message);
  }
}

interface ReliableExportJob extends ReliableExportJobSnapshot {
  kind: "markdown" | "staged";
  userId: string;
  contentType: string;
  tmpDir: string;
  tmpPath: string;
  createdAt: number;
  expiresAt: number;
}

interface AttachmentRow {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  path: string;
}

const jobs = new Map<string, ReliableExportJob>();
const downloadTokens = new Map<string, string>();
let lastCleanupAt = 0;

function sanitizeFilename(value: string): string {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "") || "未命名";
}

function normalizeAssetRelPath(value: string): string | null {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/")) return null;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return segments.map(sanitizeFilename).join("/");
}

function decodedBase64Bytes(value: string): number {
  const clean = String(value || "").replace(/\s+/g, "");
  if (!clean) return 0;
  if (clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new ReliableExportValidationError("内联资源包含无效 Base64 数据", "INVALID_INLINE_ASSET_BASE64");
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

export function validatePreparedMarkdownNotes(
  notes: PreparedMarkdownNote[],
  limits: {
    maxNotes?: number;
    maxMarkdownBytes?: number;
    maxInlineAssetBytes?: number;
  } = {},
): { markdownBytes: number; inlineAssetBytes: number } {
  const maxNotes = limits.maxNotes ?? MAX_MARKDOWN_EXPORT_NOTES;
  const maxMarkdownBytes = limits.maxMarkdownBytes ?? MAX_MARKDOWN_TEXT_BYTES;
  const maxInlineAssetBytes = limits.maxInlineAssetBytes ?? MAX_INLINE_ASSET_BYTES;

  if (!Array.isArray(notes) || notes.length === 0) {
    throw new ReliableExportValidationError("没有可导出的笔记", "NO_NOTES");
  }
  if (notes.length > maxNotes) {
    throw new ReliableExportPayloadTooLargeError(
      `单次最多导出 ${maxNotes} 篇笔记`,
      "TOO_MANY_EXPORT_NOTES",
    );
  }

  let markdownBytes = 0;
  let inlineAssetBytes = 0;
  const noteIds = new Set<string>();

  for (const note of notes) {
    if (!note || typeof note.id !== "string" || !note.id.trim()) {
      throw new ReliableExportValidationError("导出笔记包含无效 ID", "INVALID_NOTE_ID");
    }
    if (noteIds.has(note.id)) {
      throw new ReliableExportValidationError("导出笔记列表包含重复 ID", "DUPLICATE_NOTE_ID");
    }
    noteIds.add(note.id);

    if (typeof note.markdown !== "string") {
      throw new ReliableExportValidationError("导出笔记正文格式无效", "INVALID_MARKDOWN_CONTENT");
    }
    markdownBytes += Buffer.byteLength(note.markdown, "utf8");
    if (markdownBytes > maxMarkdownBytes) {
      throw new ReliableExportPayloadTooLargeError(
        `Markdown 正文累计超过 ${Math.floor(maxMarkdownBytes / 1024 / 1024)}MB`,
        "MARKDOWN_TEXT_TOO_LARGE",
      );
    }

    if (note.inlineAssets !== undefined && !Array.isArray(note.inlineAssets)) {
      throw new ReliableExportValidationError("内联资源列表格式无效", "INVALID_INLINE_ASSETS");
    }
    for (const asset of note.inlineAssets || []) {
      if (!asset || typeof asset.relPath !== "string" || typeof asset.base64 !== "string") {
        throw new ReliableExportValidationError("内联资源格式无效", "INVALID_INLINE_ASSET");
      }
      if (!normalizeAssetRelPath(asset.relPath)) {
        throw new ReliableExportValidationError("内联资源路径无效", "INVALID_INLINE_ASSET_PATH");
      }
      inlineAssetBytes += decodedBase64Bytes(asset.base64);
      if (inlineAssetBytes > maxInlineAssetBytes) {
        throw new ReliableExportPayloadTooLargeError(
          `内联资源累计超过 ${Math.floor(maxInlineAssetBytes / 1024 / 1024)}MB`,
          "INLINE_ASSETS_TOO_LARGE",
        );
      }
    }
  }

  return { markdownBytes, inlineAssetBytes };
}

function safeRemove(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // 下一轮清理继续兜底。
  }
}

function disposeJob(jobId: string, job: ReliableExportJob): void {
  jobs.delete(jobId);
  if (job.downloadToken) downloadTokens.delete(job.downloadToken);
  safeRemove(job.tmpDir);
}

export function cleanupExpiredReliableExports(force = false): void {
  const now = Date.now();
  if (!force && now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;

  for (const [jobId, job] of jobs) {
    if (job.expiresAt <= now) disposeJob(jobId, job);
  }

  try {
    for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(EXPORT_TMP_PREFIX)) continue;
      const abs = path.join(os.tmpdir(), entry.name);
      try {
        const stat = fs.statSync(abs);
        if (now - stat.mtimeMs > EXPORT_TTL_MS * 2) safeRemove(abs);
      } catch {
        safeRemove(abs);
      }
    }
  } catch {
    // 系统临时目录不可读时不阻断服务。
  }
}

const cleanupTimer = setInterval(() => cleanupExpiredReliableExports(true), CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();
cleanupExpiredReliableExports(true);

function publicSnapshot(job: ReliableExportJob): ReliableExportJobSnapshot {
  return {
    id: job.id,
    state: job.state,
    current: job.current,
    total: job.total,
    message: job.message,
    filename: job.filename,
    downloadToken: job.downloadToken,
    warnings: job.warnings,
  };
}

function attachmentIdsInMarkdown(markdown: string): string[] {
  const ids = new Set<string>();
  const re = /\/api\/attachments\/([^/?#\s)"'<>]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    try {
      ids.add(decodeURIComponent(match[1]));
    } catch {
      ids.add(match[1]);
    }
  }
  return Array.from(ids);
}

function replaceAttachmentUrl(markdown: string, attachmentId: string, replacement: string): string {
  const escaped = attachmentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return markdown.replace(
    new RegExp(`(?:https?:\\/\\/[^\\s)"'<>]+)?\\/api\\/attachments\\/${escaped}(?:\\?[^\\s)"'<>]*)?`, "gi"),
    replacement,
  );
}

async function readAttachment(row: AttachmentRow): Promise<Buffer | null> {
  const storage = getAttachmentStorageInfo();
  if (storage.driver === "local") {
    const abs = getLocalAttachmentPath(row.path);
    return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
  }
  return readAttachmentObject(row.path);
}

async function appendAttachment(
  archive: archiver.Archiver,
  row: AttachmentRow,
  zipPath: string,
  buffered?: Buffer,
): Promise<boolean> {
  const storage = getAttachmentStorageInfo();
  if (storage.driver === "local" && !buffered) {
    const abs = getLocalAttachmentPath(row.path);
    if (!fs.existsSync(abs)) return false;
    archive.file(abs, { name: zipPath, store: true } as archiver.ZipEntryData);
    return true;
  }

  const buffer = buffered || await readAttachmentObject(row.path);
  if (!buffer) return false;
  archive.append(buffer, { name: zipPath, store: true } as archiver.ZipEntryData);
  return true;
}

async function buildArchive(
  job: ReliableExportJob,
  notes: PreparedMarkdownNote[],
  inlineImages: boolean,
  layout: "notebooks" | "flat",
): Promise<void> {
  job.state = "building";
  job.message = "正在生成 ZIP";
  const warnings: Array<Record<string, unknown>> = [];
  const output = fs.createWriteStream(job.tmpPath);
  const archive = archiver("zip", { zlib: { level: 6 }, forceZip64: true });
  const completion = new Promise<void>((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
  });
  archive.on("warning", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      warnings.push({ type: "archive_source_missing", message: error.message });
      return;
    }
    archive.emit("error", error);
  });
  archive.pipe(output);

  const db = getDb();
  const getAttachment = db.prepare(
    `SELECT id, noteId, filename, mimeType, path
       FROM attachments
      WHERE id = ? AND userId = ? AND noteId = ?`,
  );
  const folderCounts = new Map<string, number>();
  const usedNotePaths = new Set<string>();
  const writtenAttachments = new Set<string>();
  let generatedInlineBytes = 0;

  for (let index = 0; index < notes.length; index++) {
    const note = notes[index];
    const folder = layout === "flat" ? "" : sanitizeFilename(note.notebookName || "未分类");
    const zipPrefix = folder ? `${folder}/` : "";
    if (folder) folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);

    const baseName = sanitizeFilename(note.title);
    let noteName = baseName;
    let suffix = 2;
    while (usedNotePaths.has(`${zipPrefix}${noteName}.md`)) noteName = `${baseName}_${suffix++}`;
    usedNotePaths.add(`${zipPrefix}${noteName}.md`);
    let markdown = note.markdown;

    for (const attachmentId of attachmentIdsInMarkdown(markdown)) {
      const row = getAttachment.get(attachmentId, job.userId, note.id) as AttachmentRow | undefined;
      if (!row) {
        warnings.push({ type: "attachment_missing", noteId: note.id, attachmentId });
        continue;
      }

      let buffered: Buffer | undefined;
      if (inlineImages && row.mimeType.startsWith("image/")) {
        const buffer = await readAttachment(row);
        if (!buffer) {
          warnings.push({ type: "attachment_file_missing", noteId: note.id, attachmentId });
          continue;
        }
        if (generatedInlineBytes + buffer.length <= MAX_INLINE_ASSET_BYTES) {
          generatedInlineBytes += buffer.length;
          markdown = replaceAttachmentUrl(
            markdown,
            attachmentId,
            `data:${row.mimeType};base64,${buffer.toString("base64")}`,
          );
          continue;
        }
        buffered = buffer;
        warnings.push({ type: "inline_attachment_budget_exceeded", noteId: note.id, attachmentId });
      }

      const assetName = `att-${sanitizeFilename(row.id)}-${sanitizeFilename(row.filename)}`;
      const relPath = `assets/${assetName}`;
      const zipPath = `${zipPrefix}${relPath}`;
      if (!writtenAttachments.has(zipPath)) {
        if (!await appendAttachment(archive, row, zipPath, buffered)) {
          warnings.push({ type: "attachment_file_missing", noteId: note.id, attachmentId });
          continue;
        }
        writtenAttachments.add(zipPath);
      }
      markdown = replaceAttachmentUrl(markdown, attachmentId, `./${relPath}`);
    }

    for (const asset of note.inlineAssets || []) {
      const relPath = normalizeAssetRelPath(asset.relPath);
      if (!relPath) continue;
      const zipPath = `${zipPrefix}${relPath}`;
      if (writtenAttachments.has(zipPath)) continue;
      archive.append(Buffer.from(asset.base64, "base64"), {
        name: zipPath,
        store: true,
      } as archiver.ZipEntryData);
      writtenAttachments.add(zipPath);
    }

    const frontmatter = [
      "---",
      `title: "${String(note.title || "").replace(/"/g, '\\"')}"`,
      `contentFormat: "${note.contentFormat || "tiptap-json"}"`,
      `created: ${note.createdAt}`,
      `updated: ${note.updatedAt}`,
      "---",
      "",
    ].join("\n");
    archive.append(frontmatter + markdown, { name: `${zipPrefix}${noteName}.md` });
    job.current = index + 1;
    job.message = `正在打包：${note.title}`;
  }

  archive.append(JSON.stringify({
    version: "2.1",
    app: "nowen-note",
    exportedAt: new Date().toISOString(),
    totalNotes: notes.length,
    notebooks: Array.from(folderCounts.entries()).map(([name, count]) => ({ name, count })),
    warnings: warnings.length,
  }, null, 2), { name: "metadata.json" });
  if (warnings.length > 0) {
    archive.append(JSON.stringify({ version: "1.0", items: warnings }, null, 2), {
      name: "export-warnings.json",
    });
  }

  job.message = "正在完成 ZIP 文件";
  await archive.finalize();
  await completion;
  job.warnings = warnings.length;
  job.state = "ready";
  job.current = job.total;
  job.message = warnings.length > 0 ? `导出完成，${warnings.length} 个附件需要检查` : "导出完成";
  job.downloadToken = crypto.randomBytes(32).toString("hex");
  downloadTokens.set(job.downloadToken, job.id);
}

export function createReliableMarkdownExportJob(params: {
  userId: string;
  notes: PreparedMarkdownNote[];
  inlineImages: boolean;
  layout?: "notebooks" | "flat";
  filenameBase?: string;
}): ReliableExportJobSnapshot {
  validatePreparedMarkdownNotes(params.notes);
  cleanupExpiredReliableExports();

  for (const [jobId, job] of jobs) {
    if (job.userId !== params.userId || job.kind !== "markdown") continue;
    if (job.state === "queued" || job.state === "building") throw new ReliableExportBusyError();
    disposeJob(jobId, job);
  }

  const id = crypto.randomUUID();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), EXPORT_TMP_PREFIX));
  const date = new Date().toISOString().slice(0, 10);
  const job: ReliableExportJob = {
    id,
    kind: "markdown",
    userId: params.userId,
    contentType: "application/zip",
    state: "queued",
    current: 0,
    total: params.notes.length,
    message: "等待生成 ZIP",
    filename: params.filenameBase
      ? `${sanitizeFilename(params.filenameBase)}.zip`
      : `nowen-note_backup_${date}.zip`,
    warnings: 0,
    tmpDir,
    tmpPath: path.join(tmpDir, "export.zip"),
    createdAt: Date.now(),
    expiresAt: Date.now() + EXPORT_TTL_MS,
  };
  jobs.set(id, job);

  void buildArchive(job, params.notes, params.inlineImages, params.layout || "notebooks").catch((error) => {
    console.error("[reliable-export] markdown build failed:", error);
    safeRemove(job.tmpDir);
    job.state = "error";
    job.message = error instanceof Error ? error.message : "生成 ZIP 失败";
    job.expiresAt = Date.now() + EXPORT_TTL_MS;
  });
  return publicSnapshot(job);
}

export async function stageReliableGeneratedExport(params: {
  userId: string;
  filename: string;
  contentType: string;
  body: ReadableStream<Uint8Array>;
  contentLength?: number;
}): Promise<{ downloadToken: string; filename: string; size: number }> {
  cleanupExpiredReliableExports();
  if (params.contentLength && params.contentLength > MAX_STAGED_EXPORT_BYTES) {
    throw new ReliableExportPayloadTooLargeError(
      "导出文件超过 512MB，无法通过临时下载中转",
      "STAGED_EXPORT_TOO_LARGE",
    );
  }

  const stagedJobs = Array.from(jobs.values())
    .filter((job) => job.userId === params.userId && job.kind === "staged")
    .sort((a, b) => a.createdAt - b.createdAt);
  while (stagedJobs.length >= MAX_STAGED_EXPORTS_PER_USER) {
    const old = stagedJobs.shift()!;
    disposeJob(old.id, old);
  }

  const id = crypto.randomUUID();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), EXPORT_TMP_PREFIX));
  const tmpPath = path.join(tmpDir, "export.bin");
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_STAGED_EXPORT_BYTES) {
        callback(new ReliableExportPayloadTooLargeError(
          "导出文件超过 512MB，无法通过临时下载中转",
          "STAGED_EXPORT_TOO_LARGE",
        ));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(params.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      limiter,
      fs.createWriteStream(tmpPath),
    );
    if (size === 0) throw new ReliableExportValidationError("导出文件为空", "EMPTY_EXPORT_FILE");
  } catch (error) {
    safeRemove(tmpDir);
    throw error;
  }

  const downloadToken = crypto.randomBytes(32).toString("hex");
  const filename = sanitizeFilename(params.filename);
  const job: ReliableExportJob = {
    id,
    kind: "staged",
    userId: params.userId,
    contentType: params.contentType,
    state: "ready",
    current: 1,
    total: 1,
    message: "导出文件已准备完成",
    filename,
    downloadToken,
    warnings: 0,
    tmpDir,
    tmpPath,
    createdAt: Date.now(),
    expiresAt: Date.now() + EXPORT_TTL_MS,
  };
  jobs.set(id, job);
  downloadTokens.set(downloadToken, id);
  return { downloadToken, filename, size };
}

export function getReliableExportJob(jobId: string, userId: string): ReliableExportJobSnapshot | null {
  cleanupExpiredReliableExports();
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) return null;
  return publicSnapshot(job);
}

export function handleReliableExportDownload(c: Context): Response {
  cleanupExpiredReliableExports();
  const token = c.req.param("token");
  const jobId = downloadTokens.get(token);
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job || job.state !== "ready" || job.downloadToken !== token || !fs.existsSync(job.tmpPath)) {
    return new Response(JSON.stringify({ error: "下载链接无效或已过期" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const stat = fs.statSync(job.tmpPath);
  const stream = fs.createReadStream(job.tmpPath);

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": job.contentType,
      "Content-Length": String(stat.size),
      "Content-Encoding": "identity",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(job.filename || "nowen-note-export.bin")}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Nowen-Reliable-Export": "1",
    },
  });
}

export const reliableExportTestUtils = {
  attachmentIdsInMarkdown,
  decodedBase64Bytes,
  normalizeAssetRelPath,
  replaceAttachmentUrl,
  sanitizeFilename,
  getJobCount: () => jobs.size,
};
