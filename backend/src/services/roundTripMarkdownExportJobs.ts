import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import type { Context } from "hono";
import JSZip from "jszip";
import { getDb } from "../db/schema";
import {
  ReliableExportBusyError,
  validatePreparedMarkdownNotes,
  type PreparedMarkdownNote,
  type ReliableExportJobSnapshot,
} from "./reliableExportJobs";
import { createStableNowenPackageExport } from "./nowenPackageExportStable";
import { ensureNowenInstanceEnvironment } from "./nowenInstanceIdentity";

// export.ts imports this service at router startup. Pin the instance identity once so the native
// Nowen-package endpoint and Markdown jobs both write the same stable sourceInstanceId.
ensureNowenInstanceEnvironment();

const TMP_PREFIX = "nowen-roundtrip-markdown-";
const TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface Job extends ReliableExportJobSnapshot {
  userId: string;
  tmpDir: string;
  tmpPath: string;
  createdAt: number;
  expiresAt: number;
}

const jobs = new Map<string, Job>();
const tokens = new Map<string, string>();
let lastCleanupAt = 0;

function publicSnapshot(job: Job): ReliableExportJobSnapshot {
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

function dispose(jobId: string, job: Job): void {
  jobs.delete(jobId);
  if (job.downloadToken) tokens.delete(job.downloadToken);
  try { fs.rmSync(job.tmpDir, { recursive: true, force: true }); } catch { /* next cleanup */ }
}

function cleanup(force = false): void {
  const now = Date.now();
  if (!force && now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  for (const [jobId, job] of jobs) {
    if (job.expiresAt <= now) dispose(jobId, job);
  }
  try {
    for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(TMP_PREFIX)) continue;
      const target = path.join(os.tmpdir(), entry.name);
      try {
        if (now - fs.statSync(target).mtimeMs > TTL_MS * 2) fs.rmSync(target, { recursive: true, force: true });
      } catch {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* temp directory unavailable */ }
}

const cleanupTimer = setInterval(() => cleanup(true), CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();
cleanup(true);

function inferWorkspaceId(userId: string, noteIds: string[]): string | null {
  if (!noteIds.length) return null;
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT workspaceId
      FROM notes
     WHERE id IN (${noteIds.map(() => "?").join(",")})
  `).all(...noteIds) as Array<{ workspaceId: string | null }>;
  if (rows.length !== 1) throw new Error("Selected notes span multiple workspaces");
  const workspaceId = rows[0]?.workspaceId || null;
  if (!workspaceId) {
    const count = db.prepare(`
      SELECT COUNT(*) AS count FROM notes
       WHERE id IN (${noteIds.map(() => "?").join(",")}) AND userId = ?
    `).get(...noteIds, userId) as { count: number };
    if (Number(count?.count) !== noteIds.length) throw new Error("Selected notes are not owned by the current user");
  }
  return workspaceId;
}

function sanitizeMarkdownFilename(value: string): string {
  const normalized = String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return normalized || "未命名";
}

async function normalizeSingleFlatMarkdownFilename(
  buffer: Buffer,
  title: string,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const rootMarkdownFiles = Object.keys(zip.files).filter((name) =>
    !name.includes("/") && name.toLowerCase().endsWith(".md") && !zip.files[name].dir,
  );
  if (rootMarkdownFiles.length !== 1) return buffer;

  const currentName = rootMarkdownFiles[0];
  const targetName = `${sanitizeMarkdownFilename(title)}.md`;
  if (currentName === targetName) return buffer;

  const content = await zip.file(currentName)!.async("nodebuffer");
  zip.remove(currentName);
  zip.file(targetName, content);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

async function buildJob(
  job: Job,
  notes: PreparedMarkdownNote[],
  inlineImages: boolean,
  layout: "notebooks" | "flat",
  filenameBase?: string,
): Promise<void> {
  try {
    job.state = "building";
    job.message = "正在生成完整目录与附件清单";
    const noteIds = notes.map((note) => note.id);
    const workspaceId = inferWorkspaceId(job.userId, noteIds);
    const result = await createStableNowenPackageExport({
      userId: job.userId,
      workspaceId,
      noteIds,
      preparedMarkdown: notes,
      packageKind: "markdown",
      includeHumanReadableTree: true,
      inlineImages,
      layout,
      filenameBase,
    });
    const buffer = layout === "flat" && notes.length === 1
      ? await normalizeSingleFlatMarkdownFilename(result.buffer, notes[0].title)
      : result.buffer;
    fs.writeFileSync(job.tmpPath, buffer);
    job.filename = result.filename;
    job.warnings = result.stats.warnings;
    job.current = job.total;
    job.state = "ready";
    job.message = result.stats.warnings
      ? `导出完成，${result.stats.warnings} 项需要检查`
      : "导出完成";
    job.downloadToken = crypto.randomBytes(32).toString("hex");
    tokens.set(job.downloadToken, job.id);
  } catch (error) {
    job.state = "error";
    job.message = error instanceof Error ? error.message : "生成 ZIP 失败";
    job.expiresAt = Date.now() + TTL_MS;
    try { fs.rmSync(job.tmpPath, { force: true }); } catch { /* ignore */ }
  }
}

export function createRoundTripMarkdownExportJob(params: {
  userId: string;
  notes: PreparedMarkdownNote[];
  inlineImages: boolean;
  layout?: "notebooks" | "flat";
  filenameBase?: string;
}): ReliableExportJobSnapshot {
  validatePreparedMarkdownNotes(params.notes);
  cleanup();
  for (const [jobId, job] of jobs) {
    if (job.userId !== params.userId) continue;
    if (job.state === "queued" || job.state === "building") throw new ReliableExportBusyError();
    dispose(jobId, job);
  }

  const id = crypto.randomUUID();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  const job: Job = {
    id,
    userId: params.userId,
    state: "queued",
    current: 0,
    total: params.notes.length,
    message: "等待生成 ZIP",
    filename: params.filenameBase ? `${params.filenameBase}.zip` : undefined,
    warnings: 0,
    tmpDir,
    tmpPath: path.join(tmpDir, "export.zip"),
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  };
  jobs.set(id, job);
  void buildJob(job, params.notes, params.inlineImages, params.layout || "notebooks", params.filenameBase);
  return publicSnapshot(job);
}

export function getRoundTripMarkdownExportJob(jobId: string, userId: string): ReliableExportJobSnapshot | null {
  cleanup();
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) return null;
  return publicSnapshot(job);
}

export function handleRoundTripMarkdownDownload(c: Context): Response | null {
  cleanup();
  const token = c.req.param("token");
  const jobId = tokens.get(token);
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) return null;
  if (job.state !== "ready" || job.downloadToken !== token || !fs.existsSync(job.tmpPath)) {
    return new Response(JSON.stringify({ error: "下载链接无效或已过期" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const stat = fs.statSync(job.tmpPath);
  const stream = fs.createReadStream(job.tmpPath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(stat.size),
      "Content-Encoding": "identity",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(job.filename || "nowen-note.zip")}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Nowen-Round-Trip-Package": "2",
    },
  });
}
