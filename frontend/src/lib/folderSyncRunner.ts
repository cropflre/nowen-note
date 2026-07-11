import type {
  FolderSyncPendingUploads,
  FolderSyncScanResult,
  FolderSyncUploadCandidate,
} from "@/lib/desktopBridge";
import {
  getFolderSyncPreferences,
  pushFolderSyncPreferences,
} from "@/lib/folderSyncPreferences";
import {
  getFolderSyncErrorCode,
  handleFolderSyncSourceDeleted,
  importFolderSyncAttachment,
  importFolderSyncText,
} from "@/lib/folderSyncTransport";

export interface SyncRunOptions {
  silent?: boolean;
  reason?: "manual" | "auto";
}

export interface SyncRunResult {
  ok: boolean;
  folderId: string;
  scanResult: FolderSyncScanResult | null;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  conflicts: number;
  deleted: number;
  error?: string;
}

type ExtendedCandidate = FolderSyncUploadCandidate & {
  action?: "upsert" | "delete";
  previousRelativePath?: string | null;
  attachmentId?: string | null;
};

type ExtendedPending = FolderSyncPendingUploads & {
  config: FolderSyncPendingUploads["config"] & {
    conflictPolicy?: "protect" | "copy" | "overwrite";
    deletionPolicy?: "keep" | "trash" | "detach";
    extractAttachmentText?: boolean;
  };
  pending: ExtendedCandidate[];
};

const ATTACHMENT_EXTS = new Set([".pdf", ".docx"]);

function getFolderSync() {
  return (window as any).nowenDesktop?.folderSync as import("@/lib/desktopBridge").FolderSyncAPI | undefined;
}

function base64ToFile(base64: string, filename: string, mimeType: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], filename, { type: mimeType || "application/octet-stream" });
}

function emptyResult(folderId: string, error?: string): SyncRunResult {
  return {
    ok: !error,
    folderId,
    scanResult: null,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: error ? 1 : 0,
    conflicts: 0,
    deleted: 0,
    error,
  };
}

async function appendSafeLog(
  folderId: string,
  type: "sync" | "upload" | "warn" | "error",
  message: string,
): Promise<void> {
  try {
    await getFolderSync()?.appendLog(folderId, type, message.slice(0, 1000));
  } catch {
    // Logging must never block the synchronization pipeline.
  }
}

/**
 * Executes one complete one-way projection pass:
 * local scan -> bounded pending list -> authenticated backend mutation -> local status update.
 */
export async function runFolderSyncOnce(
  folderId: string,
  options: SyncRunOptions = {},
): Promise<SyncRunResult> {
  const fs = getFolderSync();
  const reason = options.reason || "manual";
  if (!fs) return emptyResult(folderId, "文件夹同步仅桌面端可用");

  const preferences = getFolderSyncPreferences(folderId);
  try {
    // Push before scanning so main-process exclusion and scan policy use the same snapshot.
    await pushFolderSyncPreferences(fs, folderId, preferences);
  } catch (error) {
    console.warn("[folder-sync] failed to push advanced preferences:", error);
  }

  await appendSafeLog(folderId, "sync", `${reason} sync started`);
  const scanResult = await fs.runNow(folderId);
  if (!scanResult.ok) {
    const message = scanResult.message || "扫描失败";
    await appendSafeLog(folderId, "error", `${reason} scan failed: ${message}`);
    return { ...emptyResult(folderId, message), scanResult };
  }

  const rawPending = await fs.getPendingUploads(folderId);
  if (!rawPending.ok) {
    const message = rawPending.error || "获取待同步文件失败";
    await appendSafeLog(folderId, "error", message);
    return { ...emptyResult(folderId, message), scanResult };
  }
  const pendingResult = rawPending as ExtendedPending;
  const targetNotebookId = pendingResult.config.targetNotebookId;

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let conflicts = 0;
  let deleted = 0;

  for (const candidate of pendingResult.pending) {
    if (candidate.action === "delete") {
      try {
        if (candidate.sourcePathHash) {
          await handleFolderSyncSourceDeleted({
            sourcePathHash: candidate.sourcePathHash,
            policy: preferences.deletionPolicy,
          });
        }
        await fs.markUploadResult(folderId, candidate.relativePath, { success: true, noteId: candidate.existingNoteId || undefined });
        deleted += 1;
      } catch (error: any) {
        failed += 1;
        await fs.markUploadResult(folderId, candidate.relativePath, {
          success: false,
          error: `删除策略执行失败: ${error?.message || "unknown error"}`,
        });
      }
      continue;
    }

    if (!targetNotebookId) {
      skipped += 1;
      await fs.markUploadResult(folderId, candidate.relativePath, {
        success: false,
        skipped: true,
        error: "未配置目标笔记本",
      });
      continue;
    }

    if (candidate.skipReason) {
      skipped += 1;
      await fs.markUploadResult(folderId, candidate.relativePath, {
        success: false,
        skipped: true,
        error: candidate.skipReason,
      });
      continue;
    }

    try {
      const extension = candidate.ext.toLowerCase();
      const common = {
        filename: candidate.filename,
        relativePath: candidate.relativePath,
        sha256: candidate.sha256,
        sourcePathHash: candidate.sourcePathHash,
        targetNotebookId,
        existingNoteId: candidate.existingNoteId || undefined,
        conflictPolicy: preferences.conflictPolicy,
      } as const;

      const response = ATTACHMENT_EXTS.has(extension)
        ? await (async () => {
            const fileResult = await fs.getUploadFile(folderId, candidate.relativePath);
            if (!fileResult.ok || !fileResult.buffer) {
              throw new Error(fileResult.message || "读取附件失败");
            }
            return importFolderSyncAttachment({
              ...common,
              extractText: preferences.extractAttachmentText,
              file: base64ToFile(
                fileResult.buffer,
                candidate.filename,
                fileResult.mimeType || "application/octet-stream",
              ),
            });
          })()
        : await importFolderSyncText({
            ...common,
            contentText: candidate.contentText ?? "",
          });

      await fs.markUploadResult(folderId, candidate.relativePath, {
        success: true,
        skipped: response.skipped,
        noteId: response.noteId,
        attachmentId: response.attachmentId,
      });

      if (response.skipped) skipped += 1;
      else if (response.created) imported += 1;
      else if (response.updated) updated += 1;

      if (response.conflictCopyNoteId) {
        await appendSafeLog(
          folderId,
          "warn",
          `${candidate.relativePath}: preserved edited Nowen content as an independent conflict copy`,
        );
      }
      if (response.extractionError) {
        await appendSafeLog(folderId, "warn", `${candidate.filename}: text extraction failed (${response.extractionError})`);
      }
    } catch (error: any) {
      const code = getFolderSyncErrorCode(error);
      if (code === "SYNC_CONFLICT") {
        conflicts += 1;
        await fs.markUploadResult(folderId, candidate.relativePath, {
          success: false,
          error: `SYNC_CONFLICT:${error?.message || "Nowen 笔记存在本地编辑"}`,
        });
      } else {
        failed += 1;
        await fs.markUploadResult(folderId, candidate.relativePath, {
          success: false,
          error: error?.message || "同步失败",
        });
      }
    }
  }

  await appendSafeLog(
    folderId,
    failed || conflicts ? "warn" : "sync",
    `Sync completed: +${imported} ~${updated} -${deleted} skip${skipped} conflict${conflicts} fail${failed}`,
  );

  return {
    ok: true,
    folderId,
    scanResult,
    imported,
    updated,
    skipped,
    failed,
    conflicts,
    deleted,
  };
}
