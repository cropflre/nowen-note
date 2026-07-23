import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { hasPermission, resolveNotePermission, resolveNotebookPermission } from "../middleware/acl";
import { scanRemoteImages, replaceRemoteImages, type RemoteImageScanResult } from "../lib/remote-image-localization";
import {
  downloadRemoteImage,
  saveDownloadedRemoteImageForNote,
  type DownloadedRemoteImage,
  RemoteImageError,
} from "./remote-image-import";
import { extractSearchableText } from "../lib/searchIndex";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import { syncNoteBlocks } from "../lib/noteBlocks";
import { syncNoteLinks } from "../lib/noteLinks";
import { noteVersionsRepository } from "../repositories";
import { logAudit } from "./audit";
import { broadcastNoteUpdated, broadcastToUser } from "./realtime";

const DATA_DIR = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
const JOBS_DIR = path.join(DATA_DIR, "jobs", "remote-image-localization");
const DEFAULT_MAX_NOTES = 100;
const DEFAULT_MAX_IMAGES = 500;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type LocalizationJobStatus = "queued" | "running" | "completed" | "completed_with_errors" | "cancelled" | "failed";
export type LocalizationNoteStatus =
  | "queued"
  | "completed"
  | "partial"
  | "failed"
  | "skipped"
  | "forbidden"
  | "locked"
  | "trashed"
  | "conflict"
  | "parse_error";

export interface LocalizationFailure {
  noteId: string;
  url?: string;
  code: string;
  message: string;
}

export interface LocalizationNoteScan {
  noteId: string;
  title: string;
  version: number;
  contentFormat: string;
  status: "ready" | "forbidden" | "locked" | "trashed" | "conflict" | "parse_error" | "not_found";
  reason?: string;
  scan: RemoteImageScanResult;
}

export interface LocalizationScopeScan {
  noteCount: number;
  readyNoteCount: number;
  notesWithRemoteImages: number;
  totalImageReferences: number;
  remoteReferenceCount: number;
  localReferenceCount: number;
  ignoredReferenceCount: number;
  uniqueRemoteUrlCount: number;
  uniqueRemoteUrls: string[];
  skippedNoteCount: number;
  notes: LocalizationNoteScan[];
  limits: {
    maxNotes: number;
    maxImages: number;
    maxTotalBytes: number;
  };
}

export interface LocalizationNoteResult {
  noteId: string;
  title: string;
  scannedVersion: number;
  finalVersion?: number;
  status: LocalizationNoteStatus;
  remoteReferenceCount: number;
  uniqueRemoteUrlCount: number;
  localizedReferences: number;
  localizedUrls: number;
  deduplicatedAttachments: number;
  failedUrls: number;
  skippedUrls: number;
  failures: LocalizationFailure[];
  warnings: string[];
}

export interface LocalizationJob {
  id: string;
  userId: string;
  status: LocalizationJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequested: boolean;
  source: "note_ids" | "notebook";
  notebookId: string | null;
  noteIds: string[];
  expectedVersions: Record<string, number>;
  currentNoteId: string | null;
  currentNoteTitle: string | null;
  currentUrl: string | null;
  error: string | null;
  summary: {
    totalNotes: number;
    scannedNotes: number;
    processedNotes: number;
    updatedNotes: number;
    skippedNotes: number;
    conflictNotes: number;
    notesWithFailures: number;
    totalImageReferences: number;
    remoteReferenceCount: number;
    uniqueRemoteUrlCount: number;
    downloadedUniqueUrls: number;
    reusedDownloads: number;
    localizedReferences: number;
    localizedUrls: number;
    deduplicatedAttachments: number;
    failedUrls: number;
    downloadedBytes: number;
  };
  noteResults: LocalizationNoteResult[];
  failures: LocalizationFailure[];
}

export interface LocalizationScopeInput {
  noteIds?: unknown;
  notebookId?: unknown;
  expectedVersions?: unknown;
}

export class LocalizationJobError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 413,
  ) {
    super(message);
  }
}

interface NoteRow {
  id: string;
  userId: string;
  notebookId: string;
  workspaceId: string | null;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  version: number;
  isLocked: number;
  isTrashed: number;
  isPinned: number;
}

const jobs = new Map<string, LocalizationJob>();
const activeJobs = new Set<string>();

function readPositiveEnv(name: string, fallback: number, max: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

function getLimits() {
  return {
    maxNotes: readPositiveEnv("REMOTE_IMAGE_LOCALIZATION_MAX_NOTES", DEFAULT_MAX_NOTES, 1000),
    maxImages: readPositiveEnv("REMOTE_IMAGE_LOCALIZATION_MAX_IMAGES", DEFAULT_MAX_IMAGES, 5000),
    maxTotalBytes: readPositiveEnv(
      "REMOTE_IMAGE_LOCALIZATION_MAX_TOTAL_MB",
      DEFAULT_MAX_TOTAL_BYTES / 1024 / 1024,
      10_000,
    ) * 1024 * 1024,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureJobsDir(): void {
  fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
}

function jobPath(id: string): string {
  return path.join(JOBS_DIR, `${id}.json`);
}

function persistJob(job: LocalizationJob): void {
  ensureJobsDir();
  job.updatedAt = nowIso();
  const target = jobPath(job.id);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
  jobs.set(job.id, job);
}

function publicJob(job: LocalizationJob): Omit<LocalizationJob, "userId" | "expectedVersions"> {
  const clone = JSON.parse(JSON.stringify(job)) as LocalizationJob;
  delete (clone as Partial<LocalizationJob>).userId;
  delete (clone as Partial<LocalizationJob>).expectedVersions;
  return clone;
}

function cleanupOldJobs(): void {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs.entries()) {
    const updatedAt = new Date(job.updatedAt).getTime();
    if (!Number.isFinite(updatedAt) || updatedAt >= cutoff || job.status === "queued" || job.status === "running") continue;
    jobs.delete(id);
    try {
      fs.unlinkSync(jobPath(id));
    } catch {
      // Ignore retention cleanup failures.
    }
  }
}

function loadJobs(): void {
  ensureJobsDir();
  for (const name of fs.readdirSync(JOBS_DIR).filter((entry) => entry.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, name), "utf8")) as LocalizationJob;
      if (!parsed?.id || !parsed?.userId) continue;
      if (parsed.status === "queued" || parsed.status === "running") {
        parsed.status = "failed";
        parsed.error = "服务在任务执行期间重启；可使用重试重新扫描未完成笔记";
        parsed.completedAt = nowIso();
        parsed.currentNoteId = null;
        parsed.currentNoteTitle = null;
        parsed.currentUrl = null;
        parsed.failures = parsed.failures || [];
        parsed.failures.push({
          noteId: "",
          code: "JOB_INTERRUPTED",
          message: parsed.error,
        });
        persistJob(parsed);
      } else {
        jobs.set(parsed.id, parsed);
      }
    } catch (error) {
      console.warn("[remote-image-localization] failed to load job:", name, error);
    }
  }
  cleanupOldJobs();
}

loadJobs();

function normalizeExpectedVersions(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, number> = {};
  for (const [noteId, version] of Object.entries(value as Record<string, unknown>)) {
    const normalizedId = noteId.trim();
    const normalizedVersion = Number(version);
    if (normalizedId && Number.isInteger(normalizedVersion) && normalizedVersion >= 0) {
      output[normalizedId] = normalizedVersion;
    }
  }
  return output;
}

function normalizeNoteIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean))];
}

function resolveScopeNoteIds(userId: string, input: LocalizationScopeInput): {
  source: "note_ids" | "notebook";
  notebookId: string | null;
  noteIds: string[];
  expectedVersions: Record<string, number>;
} {
  const limits = getLimits();
  const noteIds = normalizeNoteIds(input.noteIds);
  const notebookId = typeof input.notebookId === "string" ? input.notebookId.trim() : "";
  const expectedVersions = normalizeExpectedVersions(input.expectedVersions);

  if ((noteIds.length > 0 && notebookId) || (noteIds.length === 0 && !notebookId)) {
    throw new LocalizationJobError("noteIds 与 notebookId 必须且只能提供一个", "INVALID_SCOPE", 400);
  }

  if (noteIds.length > 0) {
    if (noteIds.length > limits.maxNotes) {
      throw new LocalizationJobError(`单次最多处理 ${limits.maxNotes} 篇笔记`, "NOTE_LIMIT_EXCEEDED", 413);
    }
    return { source: "note_ids", notebookId: null, noteIds, expectedVersions };
  }

  const notebookPermission = resolveNotebookPermission(notebookId, userId);
  if (!hasPermission(notebookPermission.permission, "read")) {
    throw new LocalizationJobError("笔记本不存在或无权访问", "NOTEBOOK_FORBIDDEN", 403);
  }

  const db = getDb();
  const rows = db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM notebooks WHERE id = ?
      UNION ALL
      SELECT n.id FROM notebooks n
      JOIN descendants d ON n.parentId = d.id
    )
    SELECT notes.id
    FROM notes
    WHERE notes.notebookId IN (SELECT id FROM descendants)
      AND notes.isTrashed = 0
    ORDER BY notes.updatedAt DESC, notes.id ASC
    LIMIT ?
  `).all(notebookId, limits.maxNotes + 1) as Array<{ id: string }>;

  if (rows.length > limits.maxNotes) {
    throw new LocalizationJobError(
      `该笔记本超过单次 ${limits.maxNotes} 篇笔记限制，请缩小范围后重试`,
      "NOTE_LIMIT_EXCEEDED",
      413,
    );
  }
  return {
    source: "notebook",
    notebookId,
    noteIds: rows.map((row) => row.id),
    expectedVersions,
  };
}

function emptyScan(contentFormat = "unknown"): RemoteImageScanResult {
  return {
    contentFormat,
    totalImageReferences: 0,
    remoteReferenceCount: 0,
    localReferenceCount: 0,
    ignoredReferenceCount: 0,
    remoteUrls: [],
  };
}

function readNote(noteId: string): NoteRow | undefined {
  return getDb().prepare(`
    SELECT id, userId, notebookId, workspaceId, title, content, contentText,
           contentFormat, version, isLocked, isTrashed, isPinned
    FROM notes WHERE id = ?
  `).get(noteId) as NoteRow | undefined;
}

function scanOneNote(userId: string, noteId: string, expectedVersion?: number): LocalizationNoteScan {
  const row = readNote(noteId);
  if (!row) {
    return {
      noteId,
      title: "",
      version: 0,
      contentFormat: "unknown",
      status: "not_found",
      reason: "笔记不存在",
      scan: emptyScan(),
    };
  }

  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "write")) {
    return {
      noteId,
      title: row.title,
      version: row.version,
      contentFormat: row.contentFormat,
      status: "forbidden",
      reason: "没有写权限",
      scan: emptyScan(row.contentFormat),
    };
  }
  if (row.isTrashed) {
    return {
      noteId,
      title: row.title,
      version: row.version,
      contentFormat: row.contentFormat,
      status: "trashed",
      reason: "笔记位于回收站",
      scan: emptyScan(row.contentFormat),
    };
  }
  if (row.isLocked) {
    return {
      noteId,
      title: row.title,
      version: row.version,
      contentFormat: row.contentFormat,
      status: "locked",
      reason: "笔记已锁定",
      scan: emptyScan(row.contentFormat),
    };
  }
  if (expectedVersion !== undefined && expectedVersion !== row.version) {
    return {
      noteId,
      title: row.title,
      version: row.version,
      contentFormat: row.contentFormat,
      status: "conflict",
      reason: `预期版本 ${expectedVersion}，当前版本 ${row.version}`,
      scan: emptyScan(row.contentFormat),
    };
  }

  const scan = scanRemoteImages(row.content || "", row.contentFormat || "tiptap-json");
  if (scan.parseError) {
    return {
      noteId,
      title: row.title,
      version: row.version,
      contentFormat: row.contentFormat,
      status: "parse_error",
      reason: scan.parseError,
      scan,
    };
  }
  return {
    noteId,
    title: row.title,
    version: row.version,
    contentFormat: row.contentFormat,
    status: "ready",
    scan,
  };
}

export function scanLocalizationScope(userId: string, input: LocalizationScopeInput): LocalizationScopeScan {
  const scope = resolveScopeNoteIds(userId, input);
  const notes = scope.noteIds.map((noteId) => scanOneNote(userId, noteId, scope.expectedVersions[noteId]));
  const readyNotes = notes.filter((note) => note.status === "ready");
  const uniqueRemoteUrls = [...new Set(readyNotes.flatMap((note) => note.scan.remoteUrls))];
  const limits = getLimits();

  return {
    noteCount: notes.length,
    readyNoteCount: readyNotes.length,
    notesWithRemoteImages: readyNotes.filter((note) => note.scan.remoteReferenceCount > 0).length,
    totalImageReferences: readyNotes.reduce((sum, note) => sum + note.scan.totalImageReferences, 0),
    remoteReferenceCount: readyNotes.reduce((sum, note) => sum + note.scan.remoteReferenceCount, 0),
    localReferenceCount: readyNotes.reduce((sum, note) => sum + note.scan.localReferenceCount, 0),
    ignoredReferenceCount: readyNotes.reduce((sum, note) => sum + note.scan.ignoredReferenceCount, 0),
    uniqueRemoteUrlCount: uniqueRemoteUrls.length,
    uniqueRemoteUrls,
    skippedNoteCount: notes.length - readyNotes.length,
    notes,
    limits,
  };
}

function createInitialNoteResult(scan: LocalizationNoteScan): LocalizationNoteResult {
  const statusMap: Record<LocalizationNoteScan["status"], LocalizationNoteStatus> = {
    ready: scan.scan.remoteReferenceCount > 0 ? "queued" : "skipped",
    forbidden: "forbidden",
    locked: "locked",
    trashed: "trashed",
    conflict: "conflict",
    parse_error: "parse_error",
    not_found: "skipped",
  };
  const failures: LocalizationFailure[] = scan.status === "ready"
    ? []
    : [{
        noteId: scan.noteId,
        code: scan.status.toUpperCase(),
        message: scan.reason || "笔记已跳过",
      }];
  return {
    noteId: scan.noteId,
    title: scan.title,
    scannedVersion: scan.version,
    status: statusMap[scan.status],
    remoteReferenceCount: scan.scan.remoteReferenceCount,
    uniqueRemoteUrlCount: scan.scan.remoteUrls.length,
    localizedReferences: 0,
    localizedUrls: 0,
    deduplicatedAttachments: 0,
    failedUrls: 0,
    skippedUrls: scan.status === "ready" && scan.scan.remoteReferenceCount === 0 ? 0 : scan.scan.remoteUrls.length,
    failures,
    warnings: [],
  };
}

export function createLocalizationJob(userId: string, input: LocalizationScopeInput): Omit<LocalizationJob, "userId" | "expectedVersions"> {
  const scope = resolveScopeNoteIds(userId, input);
  const scan = scanLocalizationScope(userId, input);
  if (scan.uniqueRemoteUrlCount > scan.limits.maxImages) {
    throw new LocalizationJobError(
      `待处理唯一图片 ${scan.uniqueRemoteUrlCount} 张，超过单次 ${scan.limits.maxImages} 张限制`,
      "IMAGE_LIMIT_EXCEEDED",
      413,
    );
  }

  const noteResults = scan.notes.map(createInitialNoteResult);
  const initialSkipped = noteResults.filter((result) => result.status !== "queued").length;
  const initialConflicts = noteResults.filter((result) => result.status === "conflict").length;
  const initialFailures = noteResults.flatMap((result) => result.failures);
  const job: LocalizationJob = {
    id: uuid(),
    userId,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    completedAt: null,
    cancelRequested: false,
    source: scope.source,
    notebookId: scope.notebookId,
    noteIds: scope.noteIds,
    expectedVersions: scope.expectedVersions,
    currentNoteId: null,
    currentNoteTitle: null,
    currentUrl: null,
    error: null,
    summary: {
      totalNotes: scan.noteCount,
      scannedNotes: scan.noteCount,
      processedNotes: initialSkipped,
      updatedNotes: 0,
      skippedNotes: initialSkipped,
      conflictNotes: initialConflicts,
      notesWithFailures: noteResults.filter((result) => result.failures.length > 0).length,
      totalImageReferences: scan.totalImageReferences,
      remoteReferenceCount: scan.remoteReferenceCount,
      uniqueRemoteUrlCount: scan.uniqueRemoteUrlCount,
      downloadedUniqueUrls: 0,
      reusedDownloads: 0,
      localizedReferences: 0,
      localizedUrls: 0,
      deduplicatedAttachments: 0,
      failedUrls: 0,
      downloadedBytes: 0,
    },
    noteResults,
    failures: initialFailures,
  };
  persistJob(job);
  setImmediate(() => {
    void runLocalizationJob(job.id).catch((error) => {
      console.error("[remote-image-localization] job failed:", error);
    });
  });
  return publicJob(job);
}

function findOwnedJob(userId: string, jobId: string): LocalizationJob {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) {
    throw new LocalizationJobError("任务不存在", "JOB_NOT_FOUND", 404);
  }
  return job;
}

export function getLocalizationJob(userId: string, jobId: string) {
  return publicJob(findOwnedJob(userId, jobId));
}

export function listLocalizationJobs(userId: string, limit = 20) {
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 20, 1), 100);
  return [...jobs.values()]
    .filter((job) => job.userId === userId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, safeLimit)
    .map(publicJob);
}

export function cancelLocalizationJob(userId: string, jobId: string) {
  const job = findOwnedJob(userId, jobId);
  if (job.status !== "queued" && job.status !== "running") {
    throw new LocalizationJobError("任务已经结束，无法取消", "JOB_NOT_CANCELLABLE", 409);
  }
  job.cancelRequested = true;
  persistJob(job);
  return publicJob(job);
}

export function retryLocalizationJob(userId: string, jobId: string) {
  const job = findOwnedJob(userId, jobId);
  if (job.status === "queued" || job.status === "running") {
    throw new LocalizationJobError("任务仍在执行，不能重试", "JOB_STILL_RUNNING", 409);
  }
  const retryIds = job.noteResults
    .filter((result) => ["failed", "partial", "conflict", "parse_error"].includes(result.status))
    .map((result) => result.noteId)
    .filter(Boolean);
  if (retryIds.length === 0) {
    throw new LocalizationJobError("没有可重试的失败笔记", "NO_RETRYABLE_NOTES", 409);
  }
  return createLocalizationJob(userId, { noteIds: retryIds });
}

function pushFailure(job: LocalizationJob, result: LocalizationNoteResult, failure: LocalizationFailure): void {
  result.failures.push(failure);
  job.failures.push(failure);
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof RemoteImageError || error instanceof LocalizationJobError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "LOCALIZATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function broadcastLocalizedNote(userId: string, note: NoteRow): void {
  try {
    broadcastNoteUpdated(note.id, {
      version: note.version,
      updatedAt: (note as NoteRow & { updatedAt?: string }).updatedAt || nowIso(),
      title: note.title,
      contentText: note.contentText,
      actorUserId: userId,
    });
    broadcastToUser(userId, {
      type: "note:list-updated" as any,
      note: {
        id: note.id,
        title: note.title,
        contentText: note.contentText,
        updatedAt: (note as NoteRow & { updatedAt?: string }).updatedAt || nowIso(),
        version: note.version,
        isPinned: note.isPinned,
        isTrashed: note.isTrashed,
        notebookId: note.notebookId,
        workspaceId: note.workspaceId,
      },
      actorUserId: userId,
      actorConnectionId: null,
    } as any);
  } catch (error) {
    console.warn("[remote-image-localization] broadcast failed:", error);
  }
}

function applyLocalizedContent(args: {
  userId: string;
  noteId: string;
  scannedVersion: number;
  scannedContent: string;
  contentFormat: string;
  replacements: ReadonlyMap<string, string>;
}): { updated: boolean; conflict: boolean; replacedCount: number; finalVersion?: number; warnings: string[] } {
  const db = getDb();
  const current = readNote(args.noteId);
  if (!current || current.version !== args.scannedVersion || current.content !== args.scannedContent) {
    return { updated: false, conflict: true, replacedCount: 0, warnings: [] };
  }
  const { permission } = resolveNotePermission(args.noteId, args.userId);
  if (!hasPermission(permission, "write") || current.isLocked || current.isTrashed) {
    return { updated: false, conflict: true, replacedCount: 0, warnings: [] };
  }

  const replacement = replaceRemoteImages(current.content || "", args.contentFormat, args.replacements);
  if (replacement.parseError) {
    throw new LocalizationJobError(replacement.parseError, "CONTENT_PARSE_FAILED", 409);
  }
  if (!replacement.changed) {
    return { updated: false, conflict: false, replacedCount: 0, finalVersion: current.version, warnings: [] };
  }

  const initialText = extractSearchableText(replacement.content, args.contentFormat);
  const update = db.prepare(`
    UPDATE notes
       SET content = ?, contentText = ?, version = version + 1, updatedAt = datetime('now')
     WHERE id = ? AND version = ?
  `).run(replacement.content, initialText, args.noteId, args.scannedVersion);
  if (Number(update.changes || 0) !== 1) {
    return { updated: false, conflict: true, replacedCount: 0, warnings: [] };
  }

  try {
    noteVersionsRepository.create({
      id: uuid(),
      noteId: current.id,
      userId: args.userId,
      title: current.title,
      content: current.content,
      contentText: current.contentText,
      contentFormat: current.contentFormat,
      version: current.version,
      changeType: "edit",
      changeSummary: "本地化网络图片",
    });
  } catch (error) {
    console.warn("[remote-image-localization] create note version failed:", error);
  }

  const warnings: string[] = [];
  let normalizedContent = replacement.content;
  try {
    const synced = syncNoteBlocks(db, current.id, replacement.content, args.contentFormat);
    normalizedContent = synced.content;
    db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
      .run(synced.content, synced.contentText, current.id);
  } catch (error) {
    warnings.push(`Block 索引同步失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    syncAttachmentReferences(db, current.id, normalizedContent);
  } catch (error) {
    warnings.push(`附件引用同步失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    syncNoteLinks(db, args.userId, current.id, normalizedContent);
  } catch (error) {
    warnings.push(`双链索引同步失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const final = db.prepare(`
    SELECT id, userId, notebookId, workspaceId, title, content, contentText,
           contentFormat, version, isLocked, isTrashed, isPinned, updatedAt
    FROM notes WHERE id = ?
  `).get(current.id) as (NoteRow & { updatedAt: string }) | undefined;
  if (final) broadcastLocalizedNote(args.userId, final);
  try {
    logAudit(
      args.userId,
      "note",
      "update",
      { noteId: current.id, localizedRemoteImages: replacement.replacedCount },
      { targetType: "note", targetId: current.id },
    );
  } catch {
    // Audit failure must not roll back successful localization.
  }

  return {
    updated: true,
    conflict: false,
    replacedCount: replacement.replacedCount,
    finalVersion: final?.version ?? current.version + 1,
    warnings,
  };
}

async function runLocalizationJob(jobId: string): Promise<void> {
  if (activeJobs.has(jobId)) return;
  const job = jobs.get(jobId);
  if (!job || job.status !== "queued") return;
  activeJobs.add(jobId);
  const limits = getLimits();
  const downloadCache = new Map<string, Promise<DownloadedRemoteImage>>();
  const countedDownloads = new Set<string>();

  const getDownloaded = (url: string): Promise<DownloadedRemoteImage> => {
    const existing = downloadCache.get(url);
    if (existing) {
      job.summary.reusedDownloads += 1;
      return existing;
    }
    const promise = downloadRemoteImage(url).then((downloaded) => {
      if (job.summary.downloadedBytes + downloaded.buffer.byteLength > limits.maxTotalBytes) {
        throw new LocalizationJobError(
          `任务下载总量超过 ${Math.round(limits.maxTotalBytes / 1024 / 1024)}MB 限制`,
          "TOTAL_SIZE_LIMIT_EXCEEDED",
          413,
        );
      }
      if (!countedDownloads.has(url)) {
        countedDownloads.add(url);
        job.summary.downloadedUniqueUrls += 1;
        job.summary.downloadedBytes += downloaded.buffer.byteLength;
      }
      return downloaded;
    });
    downloadCache.set(url, promise);
    return promise;
  };

  try {
    job.status = "running";
    job.startedAt = nowIso();
    persistJob(job);

    for (const result of job.noteResults) {
      if (result.status !== "queued") continue;
      const current = readNote(result.noteId);
      if (!current) {
        result.status = "skipped";
        result.skippedUrls = result.uniqueRemoteUrlCount;
        pushFailure(job, result, { noteId: result.noteId, code: "NOTE_NOT_FOUND", message: "笔记不存在" });
        job.summary.processedNotes += 1;
        job.summary.skippedNotes += 1;
        persistJob(job);
        continue;
      }

      const permission = resolveNotePermission(current.id, job.userId);
      if (!hasPermission(permission.permission, "write")) {
        result.status = "forbidden";
        result.skippedUrls = result.uniqueRemoteUrlCount;
        pushFailure(job, result, { noteId: current.id, code: "FORBIDDEN", message: "处理前写权限已失效" });
        job.summary.processedNotes += 1;
        job.summary.skippedNotes += 1;
        persistJob(job);
        continue;
      }
      if (current.version !== result.scannedVersion) {
        result.status = "conflict";
        result.skippedUrls = result.uniqueRemoteUrlCount;
        pushFailure(job, result, {
          noteId: current.id,
          code: "VERSION_CONFLICT",
          message: `扫描版本 ${result.scannedVersion}，当前版本 ${current.version}`,
        });
        job.summary.processedNotes += 1;
        job.summary.skippedNotes += 1;
        job.summary.conflictNotes += 1;
        persistJob(job);
        continue;
      }

      const scan = scanRemoteImages(current.content || "", current.contentFormat || "tiptap-json");
      if (scan.parseError) {
        result.status = "parse_error";
        result.skippedUrls = scan.remoteUrls.length;
        pushFailure(job, result, { noteId: current.id, code: "CONTENT_PARSE_FAILED", message: scan.parseError });
        job.summary.processedNotes += 1;
        job.summary.skippedNotes += 1;
        persistJob(job);
        continue;
      }

      job.currentNoteId = current.id;
      job.currentNoteTitle = current.title;
      const replacements = new Map<string, string>();
      let cancelledAfterCurrent = false;

      for (const url of scan.remoteUrls) {
        if (job.cancelRequested) {
          cancelledAfterCurrent = true;
          result.skippedUrls += scan.remoteUrls.length - result.localizedUrls - result.failedUrls;
          break;
        }
        job.currentUrl = url;
        persistJob(job);
        try {
          const downloaded = await getDownloaded(url);
          const imported = await saveDownloadedRemoteImageForNote({
            downloaded,
            sourceUrl: url,
            noteId: current.id,
            userId: job.userId,
            workspaceId: permission.workspaceId || null,
            uploadSource: "historical-localization",
          });
          replacements.set(url, imported.url);
          result.localizedUrls += 1;
          if (imported.deduplicated) result.deduplicatedAttachments += 1;
        } catch (error) {
          const details = errorDetails(error);
          result.failedUrls += 1;
          pushFailure(job, result, {
            noteId: current.id,
            url,
            code: details.code,
            message: details.message,
          });
        }
        persistJob(job);
      }

      if (replacements.size > 0) {
        try {
          const applied = applyLocalizedContent({
            userId: job.userId,
            noteId: current.id,
            scannedVersion: result.scannedVersion,
            scannedContent: current.content,
            contentFormat: current.contentFormat,
            replacements,
          });
          if (applied.conflict) {
            result.status = "conflict";
            result.skippedUrls += Math.max(0, replacements.size - result.failedUrls);
            pushFailure(job, result, {
              noteId: current.id,
              code: "VERSION_CONFLICT",
              message: "保存前笔记内容已变化，未覆盖最新正文",
            });
            job.summary.conflictNotes += 1;
          } else if (applied.updated) {
            result.finalVersion = applied.finalVersion;
            result.localizedReferences = applied.replacedCount;
            result.warnings.push(...applied.warnings);
            result.status = result.failedUrls > 0 ? "partial" : "completed";
            job.summary.updatedNotes += 1;
            job.summary.localizedReferences += applied.replacedCount;
            job.summary.localizedUrls += result.localizedUrls;
            job.summary.deduplicatedAttachments += result.deduplicatedAttachments;
          } else {
            result.status = result.failedUrls > 0 ? "failed" : "skipped";
          }
        } catch (error) {
          const details = errorDetails(error);
          result.status = "failed";
          pushFailure(job, result, { noteId: current.id, code: details.code, message: details.message });
        }
      } else {
        result.status = result.failedUrls > 0 ? "failed" : "skipped";
      }

      job.summary.failedUrls += result.failedUrls;
      job.summary.processedNotes += 1;
      if (["failed", "partial", "conflict", "parse_error"].includes(result.status)) {
        job.summary.notesWithFailures += 1;
      }
      if (["skipped", "forbidden", "locked", "trashed", "conflict", "parse_error"].includes(result.status)) {
        job.summary.skippedNotes += 1;
      }
      job.currentUrl = null;
      persistJob(job);

      if (cancelledAfterCurrent || job.cancelRequested) {
        job.status = "cancelled";
        job.completedAt = nowIso();
        job.currentNoteId = null;
        job.currentNoteTitle = null;
        job.currentUrl = null;
        for (const queued of job.noteResults.filter((entry) => entry.status === "queued")) {
          queued.status = "skipped";
          queued.skippedUrls = queued.uniqueRemoteUrlCount;
          job.summary.processedNotes += 1;
          job.summary.skippedNotes += 1;
        }
        persistJob(job);
        return;
      }
    }

    job.status = job.failures.length > 0 ? "completed_with_errors" : "completed";
    job.completedAt = nowIso();
    job.currentNoteId = null;
    job.currentNoteTitle = null;
    job.currentUrl = null;
    persistJob(job);
  } catch (error) {
    const details = errorDetails(error);
    job.status = "failed";
    job.error = details.message;
    job.completedAt = nowIso();
    job.currentNoteId = null;
    job.currentNoteTitle = null;
    job.currentUrl = null;
    job.failures.push({ noteId: "", code: details.code, message: details.message });
    persistJob(job);
  } finally {
    activeJobs.delete(jobId);
  }
}
