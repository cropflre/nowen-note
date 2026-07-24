import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/schema";
import { hasPermission, resolveNotePermission, resolveNotebookPermission } from "../middleware/acl";
import { scanRemoteImages, type RemoteImageScanResult } from "../lib/remote-image-localization";
import { yFlush } from "./yjs";

export const DATA_DIR = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
export const JOBS_DIR = path.join(DATA_DIR, "jobs", "remote-image-localization");
const DEFAULT_MAX_NOTES = 100;
const DEFAULT_MAX_IMAGES = 500;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
export const DEFAULT_MAX_ACTIVE_JOBS = 2;
const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type LocalizationJobStatus = "queued" | "running" | "completed" | "completed_with_errors" | "cancelled" | "failed";
export type LocalizationNoteStatus =
  | "queued" | "completed" | "partial" | "failed" | "skipped"
  | "forbidden" | "locked" | "trashed" | "conflict" | "parse_error";

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
  snapshot: { noteIds: string[]; expectedVersions: Record<string, number> };
  limits: { maxNotes: number; maxImages: number; maxTotalBytes: number };
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

export interface NoteRow {
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
  updatedAt?: string;
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

export const jobs = new Map<string, LocalizationJob>();
export const activeJobs = new Set<string>();
export const scheduledJobs = new Set<string>();

export function readPositiveEnv(name: string, fallback: number, max: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

export function getLimits() {
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

export function nowIso(): string {
  return new Date().toISOString();
}

export function ensureJobsDir(): void {
  fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
}

function jobPath(id: string): string {
  return path.join(JOBS_DIR, `${id}.json`);
}

export function persistJob(job: LocalizationJob): void {
  ensureJobsDir();
  job.updatedAt = nowIso();
  const target = jobPath(job.id);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
  jobs.set(job.id, job);
}

export function publicJob(job: LocalizationJob): Omit<LocalizationJob, "userId" | "expectedVersions"> {
  const clone = JSON.parse(JSON.stringify(job)) as LocalizationJob;
  delete (clone as Partial<LocalizationJob>).userId;
  delete (clone as Partial<LocalizationJob>).expectedVersions;
  return clone;
}

function loadJobs(): void {
  ensureJobsDir();
  const cutoff = Date.now() - JOB_RETENTION_MS;
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
        parsed.failures.push({ noteId: "", code: "JOB_INTERRUPTED", message: parsed.error });
        persistJob(parsed);
      } else if (new Date(parsed.updatedAt).getTime() >= cutoff) {
        jobs.set(parsed.id, parsed);
      } else {
        try { fs.unlinkSync(path.join(JOBS_DIR, name)); } catch {}
      }
    } catch (error) {
      console.warn("[remote-image-localization] failed to load job:", name, error);
    }
  }
}

loadJobs();

function normalizeExpectedVersions(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, number> = {};
  for (const [noteId, version] of Object.entries(value as Record<string, unknown>)) {
    const id = noteId.trim();
    const normalized = Number(version);
    if (id && Number.isInteger(normalized) && normalized >= 0) output[id] = normalized;
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

export function resolveScopeNoteIds(userId: string, input: LocalizationScopeInput): {
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
  const rows = getDb().prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM notebooks WHERE id = ?
      UNION ALL
      SELECT n.id FROM notebooks n JOIN descendants d ON n.parentId = d.id
    )
    SELECT notes.id FROM notes
    WHERE notes.notebookId IN (SELECT id FROM descendants) AND notes.isTrashed = 0
    ORDER BY notes.updatedAt DESC, notes.id ASC LIMIT ?
  `).all(notebookId, limits.maxNotes + 1) as Array<{ id: string }>;
  if (rows.length > limits.maxNotes) {
    throw new LocalizationJobError(
      `该笔记本超过单次 ${limits.maxNotes} 篇笔记限制，请缩小范围后重试`,
      "NOTE_LIMIT_EXCEEDED",
      413,
    );
  }
  return { source: "notebook", notebookId, noteIds: rows.map((row) => row.id), expectedVersions };
}

export function readNote(noteId: string): NoteRow | undefined {
  return getDb().prepare(`
    SELECT id, userId, notebookId, workspaceId, title, content, contentText,
           contentFormat, version, isLocked, isTrashed, isPinned, updatedAt
    FROM notes WHERE id = ?
  `).get(noteId) as NoteRow | undefined;
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

function scanOneNote(userId: string, noteId: string, expectedVersion?: number): LocalizationNoteScan {
  try { yFlush(noteId); } catch {}
  const row = readNote(noteId);
  if (!row) return { noteId, title: "", version: 0, contentFormat: "unknown", status: "not_found", reason: "笔记不存在", scan: emptyScan() };
  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "write")) {
    return { noteId, title: row.title, version: row.version, contentFormat: row.contentFormat, status: "forbidden", reason: "没有写权限", scan: emptyScan(row.contentFormat) };
  }
  if (row.isTrashed) return { noteId, title: row.title, version: row.version, contentFormat: row.contentFormat, status: "trashed", reason: "笔记位于回收站", scan: emptyScan(row.contentFormat) };
  if (row.isLocked) return { noteId, title: row.title, version: row.version, contentFormat: row.contentFormat, status: "locked", reason: "笔记已锁定", scan: emptyScan(row.contentFormat) };
  if (expectedVersion !== undefined && expectedVersion !== row.version) {
    return { noteId, title: row.title, version: row.version, contentFormat: row.contentFormat, status: "conflict", reason: `预期版本 ${expectedVersion}，当前版本 ${row.version}`, scan: emptyScan(row.contentFormat) };
  }
  const scan = scanRemoteImages(row.content || "", row.contentFormat || "tiptap-json");
  if (scan.parseError) return { noteId, title: row.title, version: row.version, contentFormat: row.contentFormat, status: "parse_error", reason: scan.parseError, scan };
  return { noteId, title: row.title, version: row.version, contentFormat: row.contentFormat, status: "ready", scan };
}

export function scanLocalizationScope(userId: string, input: LocalizationScopeInput): LocalizationScopeScan {
  const scope = resolveScopeNoteIds(userId, input);
  const notes = scope.noteIds.map((noteId) => scanOneNote(userId, noteId, scope.expectedVersions[noteId]));
  const readyNotes = notes.filter((note) => note.status === "ready");
  const uniqueRemoteUrls = [...new Set(readyNotes.flatMap((note) => note.scan.remoteUrls))];
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
    snapshot: {
      noteIds: readyNotes.map((note) => note.noteId),
      expectedVersions: Object.fromEntries(readyNotes.map((note) => [note.noteId, note.version])),
    },
    limits: getLimits(),
  };
}

export function createInitialNoteResult(scan: LocalizationNoteScan): LocalizationNoteResult {
  const statusMap: Record<LocalizationNoteScan["status"], LocalizationNoteStatus> = {
    ready: scan.scan.remoteReferenceCount > 0 ? "queued" : "skipped",
    forbidden: "forbidden", locked: "locked", trashed: "trashed",
    conflict: "conflict", parse_error: "parse_error", not_found: "skipped",
  };
  const failures: LocalizationFailure[] = scan.status === "ready" ? [] : [{
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
