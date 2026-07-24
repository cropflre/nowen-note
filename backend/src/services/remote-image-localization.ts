import { v4 as uuid } from "uuid";
import {
  createInitialNoteResult,
  jobs,
  LocalizationJobError,
  nowIso,
  persistJob,
  publicJob,
  resolveScopeNoteIds,
  scanLocalizationScope,
  type LocalizationJob,
  type LocalizationScopeInput,
} from "./remote-image-localization-core";
import { scheduleQueuedLocalizationJobs } from "./remote-image-localization-runner";

function hasActiveLocalizationJob(userId: string): boolean {
  return [...jobs.values()].some(
    (job) => job.userId === userId && (job.status === "queued" || job.status === "running"),
  );
}

export function createLocalizationJob(userId: string, input: LocalizationScopeInput): Omit<LocalizationJob, "userId" | "expectedVersions"> {
  if (hasActiveLocalizationJob(userId)) {
    throw new LocalizationJobError(
      "已有网络图片本地化任务正在排队或执行，请等待完成后重试",
      "JOB_ALREADY_ACTIVE",
      409,
    );
  }
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
    noteIds: scan.snapshot.noteIds,
    expectedVersions: scan.snapshot.expectedVersions,
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
    failures: noteResults.flatMap((result) => result.failures),
  };
  persistJob(job);
  scheduleQueuedLocalizationJobs();
  return publicJob(job);
}

function findOwnedJob(userId: string, jobId: string): LocalizationJob {
  const job = jobs.get(jobId);
  if (!job || job.userId !== userId) throw new LocalizationJobError("任务不存在", "JOB_NOT_FOUND", 404);
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
  if (retryIds.length === 0) throw new LocalizationJobError("没有可重试的失败笔记", "NO_RETRYABLE_NOTES", 409);
  return createLocalizationJob(userId, { noteIds: retryIds });
}

export { scanLocalizationScope, LocalizationJobError } from "./remote-image-localization-core";
export type {
  LocalizationScopeInput,
  LocalizationJob,
  LocalizationScopeScan,
  LocalizationNoteResult,
} from "./remote-image-localization-core";
export { applyLocalizedContent, rollbackLocalizedAttachments } from "./remote-image-localization-mutation";
