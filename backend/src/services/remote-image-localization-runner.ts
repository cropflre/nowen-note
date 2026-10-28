import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hasPermission, resolveNotePermission } from "../middleware/acl";
import { scanRemoteImages } from "../lib/remote-image-localization";
import {
  downloadRemoteImage,
  type DownloadedRemoteImage,
  RemoteImageError,
} from "./remote-image-import";
import {
  activeJobs,
  createInitialNoteResult,
  scanOneNote,
  DEFAULT_MAX_ACTIVE_JOBS,
  ensureJobsDir,
  getLimits,
  JOBS_DIR,
  jobs,
  LocalizationJobError,
  nowIso,
  persistJob,
  readNote,
  readPositiveEnv,
  scheduledJobs,
  type LocalizationFailure,
  type LocalizationJob,
  type LocalizationNoteResult,
} from "./remote-image-localization-core";
import {
  applyLocalizedContent,
  currentWriteState,
  rollbackLocalizedAttachments,
  saveLocalizedAttachment,
  type CreatedAttachment,
} from "./remote-image-localization-mutation";
import { waitForImageHost, deferImageHost } from "./remote-image-localization-throttle";
import { yFlush } from "./yjs";

interface CachedDownload {
  tempPath: string;
  mimeType: string;
  filename: string;
  finalUrl: string;
  size: number;
}

export function scheduleQueuedLocalizationJobs(): void {
  const maxActive = readPositiveEnv(
    "REMOTE_IMAGE_LOCALIZATION_MAX_ACTIVE_JOBS",
    DEFAULT_MAX_ACTIVE_JOBS,
    8,
  );
  let reserved = activeJobs.size + scheduledJobs.size;
  if (reserved >= maxActive) return;
  const queued = [...jobs.values()]
    .filter((job) => job.status === "queued" && !activeJobs.has(job.id) && !scheduledJobs.has(job.id))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const job of queued) {
    if (reserved >= maxActive) break;
    scheduledJobs.add(job.id);
    reserved += 1;
    setImmediate(() => {
      scheduledJobs.delete(job.id);
      void runLocalizationJob(job.id).catch((error) => {
        console.error("[remote-image-localization] job failed:", error);
      });
    });
  }
}


function pushFailure(job: LocalizationJob, result: LocalizationNoteResult, failure: LocalizationFailure): void {
  result.failures.push(failure);
  job.failures.push(failure);
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof RemoteImageError || error instanceof LocalizationJobError) {
    return { code: error.code, message: error.message };
  }
  return { code: "LOCALIZATION_FAILED", message: error instanceof Error ? error.message : String(error) };
}

function finishSkipped(job: LocalizationJob, result: LocalizationNoteResult): void {
  job.summary.processedNotes += 1;
  job.summary.skippedNotes += 1;
  job.summary.processedImageOperations = (job.summary.processedImageOperations || 0) + result.uniqueRemoteUrlCount;
  job.summary.skippedImageOperations = (job.summary.skippedImageOperations || 0) + result.uniqueRemoteUrlCount;
  if (result.status === "conflict") job.summary.conflictNotes += 1;
  persistJob(job);
}

async function* pendingNotes(job: LocalizationJob): AsyncGenerator<LocalizationNoteResult> {
  if (!job.automaticBatching) {
    yield* job.noteResults;
    return;
  }
  const batchSize = getLimits().maxNotes;
  const remoteUrls = new Set<string>();
  for (let offset = 0; offset < job.noteIds.length && !job.cancelRequested; offset += batchSize) {
    const batch = job.noteIds.slice(offset, offset + batchSize).map((id) => {
      const scan = scanOneNote(job.userId, id, job.expectedVersions[id], true);
      const result = createInitialNoteResult(scan);
      job.summary.scannedNotes += 1;
      job.summary.totalImageReferences += scan.scan.totalImageReferences;
      job.summary.remoteReferenceCount += scan.scan.remoteReferenceCount;
      job.summary.totalImageOperations += result.uniqueRemoteUrlCount;
      if (scan.status === "ready") for (const url of scan.scan.remoteUrls) remoteUrls.add(url);
      job.summary.uniqueRemoteUrlCount = remoteUrls.size;
      job.noteResults.push(result);
      job.failures.push(...result.failures);
      if (result.status !== "queued") {
        job.summary.processedNotes += 1;
        job.summary.skippedNotes += 1;
        job.summary.processedImageOperations += result.uniqueRemoteUrlCount;
        job.summary.skippedImageOperations += result.uniqueRemoteUrlCount;
        if (result.status === "conflict") job.summary.conflictNotes += 1;
        if (result.failures.length) job.summary.notesWithFailures += 1;
      }
      return result;
    });
    persistJob(job);
    yield* batch;
    // Yield even for batches without remote images so cancellation can be received.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function runLocalizationJob(jobId: string): Promise<void> {
  scheduledJobs.delete(jobId);
  if (activeJobs.has(jobId)) return;
  const job = jobs.get(jobId);
  if (!job || job.status !== "queued") return;
  activeJobs.add(jobId);
  const limits = getLimits();
  ensureJobsDir();
  const downloadDir = path.join(JOBS_DIR, `${jobId}.downloads`);
  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
  const downloadCache = new Map<string, Promise<CachedDownload>>();
  let cachedBytes = 0;
  const countedDownloads = new Set<string>();
  const clearDownloads = () => {
    downloadCache.clear();
    cachedBytes = 0;
    fs.rmSync(downloadDir, { recursive: true, force: true });
    fs.mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
  };

  const getDownloaded = (url: string): Promise<CachedDownload> => {
    const existing = downloadCache.get(url);
    if (existing) {
      job.summary.reusedDownloads += 1;
      return existing;
    }
    if (job.automaticBatching && downloadCache.size >= limits.maxImages) clearDownloads();
    const promise = (async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await downloadRemoteImage(url, {
            beforeRequest: (target) => waitForImageHost(target.hostname, () => job.cancelRequested),
          });
        } catch (error) {
          if (!(error instanceof RemoteImageError) || error.code !== "REMOTE_IMAGE_RATE_LIMITED") throw error;
          deferImageHost(error.hostname ?? new URL(url).hostname, error.retryAfterMs);
          if (attempt >= 1 || job.cancelRequested) throw error;
        }
      }
    })().then(async (downloaded) => {
      const size = downloaded.buffer.byteLength;
      if (job.automaticBatching && cachedBytes + size > limits.maxTotalBytes) {
        clearDownloads();
        downloadCache.set(url, promise);
      }
      if ((job.automaticBatching ? size : job.summary.downloadedBytes + size) > limits.maxTotalBytes) {
        throw new LocalizationJobError("图片下载量超过批次容量限制", "TOTAL_SIZE_LIMIT_EXCEEDED", 413);
      }
      cachedBytes += size;
      if (!countedDownloads.has(url)) {
        countedDownloads.add(url);
        job.summary.downloadedUniqueUrls += 1;
      }
      job.summary.downloadedBytes += size;
      const tempPath = path.join(downloadDir, `${crypto.createHash("sha256").update(url).digest("hex")}.bin`);
      await fs.promises.writeFile(tempPath, downloaded.buffer, { mode: 0o600 });
      return {
        tempPath,
        mimeType: downloaded.mimeType,
        filename: downloaded.filename,
        finalUrl: downloaded.finalUrl,
        size,
      };
    });
    downloadCache.set(url, promise);
    return promise;
  };

  try {
    job.status = "running";
    job.startedAt = nowIso();
    persistJob(job);

    for await (const result of pendingNotes(job)) {
      if (job.cancelRequested) break;
      if (result.status !== "queued") continue;
      try { yFlush(result.noteId); } catch {}
      const current = readNote(result.noteId);
      if (!current) {
        result.status = "skipped";
        result.skippedUrls = result.uniqueRemoteUrlCount;
        pushFailure(job, result, { noteId: result.noteId, code: "NOTE_NOT_FOUND", message: "笔记不存在" });
        finishSkipped(job, result);
        continue;
      }

      const permission = resolveNotePermission(current.id, job.userId);
      if (!hasPermission(permission.permission, "write")
        || (job.automaticBatching && (current.userId !== job.userId || current.workspaceId))) {
        result.status = "forbidden";
        result.skippedUrls = result.uniqueRemoteUrlCount;
        pushFailure(job, result, { noteId: current.id, code: "FORBIDDEN", message: "处理前写权限已失效" });
        finishSkipped(job, result);
        continue;
      }
      if (current.isLocked || current.isTrashed || current.version !== result.scannedVersion) {
        result.status = current.isLocked ? "locked" : current.isTrashed ? "trashed" : "conflict";
        result.skippedUrls = result.uniqueRemoteUrlCount;
        pushFailure(job, result, {
          noteId: current.id,
          code: current.isLocked ? "NOTE_LOCKED" : current.isTrashed ? "NOTE_TRASHED" : "VERSION_CONFLICT",
          message: current.version !== result.scannedVersion
            ? `扫描版本 ${result.scannedVersion}，当前版本 ${current.version}`
            : current.isLocked ? "笔记已锁定" : "笔记位于回收站",
        });
        finishSkipped(job, result);
        continue;
      }

      const scan = scanRemoteImages(current.content || "", current.contentFormat || "tiptap-json");
      if (scan.parseError) {
        result.status = "parse_error";
        result.skippedUrls = scan.remoteUrls.length;
        pushFailure(job, result, { noteId: current.id, code: "CONTENT_PARSE_FAILED", message: scan.parseError });
        finishSkipped(job, result);
        continue;
      }

      job.currentNoteId = current.id;
      job.currentNoteTitle = current.title;
      const replacements = new Map<string, string>();
      const createdAttachments: CreatedAttachment[] = [];

      for (const url of scan.remoteUrls) {
        if (job.cancelRequested) {
          const remaining = scan.remoteUrls.length - result.localizedUrls - result.failedUrls;
          result.skippedUrls += remaining;
          job.summary.processedImageOperations += remaining;
          job.summary.skippedImageOperations += remaining;
          break;
        }
        job.currentUrl = url;
        persistJob(job);
        try {
          const cached = await getDownloaded(url);
          const state = currentWriteState(job.userId, current.id, result.scannedVersion, current.content, job.automaticBatching);
          if (!state) throw new LocalizationJobError("下载期间笔记内容或权限已变化", "VERSION_CONFLICT", 409);
          const downloaded: DownloadedRemoteImage = {
            buffer: await fs.promises.readFile(cached.tempPath),
            mimeType: cached.mimeType,
            filename: cached.filename,
            finalUrl: cached.finalUrl,
          };
          const saved = await saveLocalizedAttachment({
            jobId: job.id,
            userId: job.userId,
            noteId: current.id,
            workspaceId: state.workspaceId,
            sourceUrl: url,
            downloaded,
          });
          replacements.set(url, saved.imported.url);
          if (saved.created) createdAttachments.push(saved.created);
          result.localizedUrls += 1;
          if (saved.imported.deduplicated) result.deduplicatedAttachments += 1;
        } catch (error) {
          if (job.cancelRequested) {
            const remaining = scan.remoteUrls.length - result.localizedUrls - result.failedUrls;
            result.skippedUrls += remaining;
            job.summary.processedImageOperations += remaining - 1;
            job.summary.skippedImageOperations += remaining;
            break;
          }
          const details = errorDetails(error);
          result.failedUrls += 1;
          pushFailure(job, result, { noteId: current.id, url, code: details.code, message: details.message });
        } finally {
          // Download completion is an operation, not a successful note commit.
          job.summary.processedImageOperations += 1;
          persistJob(job);
        }
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
            personalOnly: job.automaticBatching,
          });
          if (applied.conflict) {
            await rollbackLocalizedAttachments(createdAttachments);
            result.localizedUrls = 0;
            result.deduplicatedAttachments = 0;
            result.status = "conflict";
            result.skippedUrls += replacements.size;
            job.summary.skippedImageOperations += replacements.size;
            pushFailure(job, result, {
              noteId: current.id,
              code: "VERSION_CONFLICT",
              message: "保存前笔记内容、权限或锁定状态已变化，未覆盖最新正文",
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
            await rollbackLocalizedAttachments(createdAttachments);
            result.localizedUrls = 0;
            result.deduplicatedAttachments = 0;
            result.status = result.failedUrls > 0 ? "failed" : "skipped";
          }
        } catch (error) {
          await rollbackLocalizedAttachments(createdAttachments);
          result.localizedUrls = 0;
          result.deduplicatedAttachments = 0;
          const details = errorDetails(error);
          result.status = "failed";
          pushFailure(job, result, { noteId: current.id, code: details.code, message: details.message });
        }
      } else {
        result.status = result.failedUrls > 0 ? "failed" : "skipped";
      }

      job.summary.failedUrls += result.failedUrls;
      job.summary.processedNotes += 1;
      if (["failed", "partial", "conflict", "parse_error"].includes(result.status)) job.summary.notesWithFailures += 1;
      if (["skipped", "forbidden", "locked", "trashed", "conflict", "parse_error"].includes(result.status)) job.summary.skippedNotes += 1;
      job.currentUrl = null;
      persistJob(job);
    }

    if (job.cancelRequested) {
      for (const queued of job.noteResults.filter((entry) => entry.status === "queued")) {
        queued.status = "skipped";
        queued.skippedUrls = queued.uniqueRemoteUrlCount;
        job.summary.processedImageOperations += queued.uniqueRemoteUrlCount;
        job.summary.skippedImageOperations += queued.uniqueRemoteUrlCount;
        job.summary.processedNotes += 1;
        job.summary.skippedNotes += 1;
      }
    }
    job.status = job.cancelRequested ? "cancelled" : job.failures.length > 0 ? "completed_with_errors" : "completed";
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
    fs.rmSync(downloadDir, { recursive: true, force: true });
    scheduleQueuedLocalizationJobs();
  }
}

