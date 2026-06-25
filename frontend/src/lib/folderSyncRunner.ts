/**
 * folderSyncRunner — 文件夹同步执行器（renderer 侧）
 *
 * 抽离 FolderSyncSettings 的扫描+上传逻辑，供手动同步和自动调度共用。
 * 采用方案 A：Electron 负责扫描/读文件，renderer 带 token 上传。
 */

import { api } from "@/lib/api";
import type { FolderSyncScanResult } from "@/lib/desktopBridge";

export interface SyncRunResult {
  ok: boolean;
  folderId: string;
  scanResult: FolderSyncScanResult | null;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  error?: string;
}

function getFolderSync() {
  return (window as any).nowenDesktop?.folderSync as import("@/lib/desktopBridge").FolderSyncAPI | undefined;
}

/**
 * 执行一次文件夹同步（扫描 + 上传）。
 * 不管手动还是自动，都走这个函数。
 */
export async function runFolderSyncOnce(folderId: string): Promise<SyncRunResult> {
  const fs = getFolderSync();
  if (!fs) return { ok: false, folderId, scanResult: null, imported: 0, updated: 0, skipped: 0, failed: 0, error: "Not desktop" };

  // Step 1: 本地扫描
  const scanResult = await fs.runNow(folderId);
  if (!scanResult.ok) {
    return { ok: false, folderId, scanResult, imported: 0, updated: 0, skipped: 0, failed: 0, error: scanResult.message || "Scan failed" };
  }

  // Step 2: 获取待上传文件
  const pendingResult = await fs.getPendingUploads(folderId);
  if (!pendingResult.ok) {
    return { ok: false, folderId, scanResult, imported: 0, updated: 0, skipped: 0, failed: 0, error: pendingResult.error || "Failed to get pending uploads" };
  }

  const targetNotebookId = pendingResult.config.targetNotebookId;
  if (!targetNotebookId) {
    // 没有目标笔记本，只扫描不上传
    return { ok: true, folderId, scanResult, imported: 0, updated: 0, skipped: 0, failed: 0 };
  }

  // Step 3: 逐个上传
  let imported = 0, updated = 0, uploadSkipped = 0, uploadFailed = 0;

  for (const candidate of pendingResult.pending) {
    if (candidate.skipReason || !candidate.contentText) {
      await fs.markUploadResult(folderId, candidate.relativePath, { success: false, skipped: true, error: candidate.skipReason || "No content" });
      uploadSkipped++;
      continue;
    }
    try {
      const res = await api.folderSync.importFile({
        filename: candidate.filename,
        relativePath: candidate.relativePath,
        sha256: candidate.sha256,
        targetNotebookId,
        contentText: candidate.contentText,
        sourcePathHash: candidate.sourcePathHash,
        existingNoteId: candidate.existingNoteId || undefined,
      });
      if (res.skipped) {
        await fs.markUploadResult(folderId, candidate.relativePath, { success: true, noteId: res.noteId, skipped: true });
        uploadSkipped++;
      } else if (res.success) {
        await fs.markUploadResult(folderId, candidate.relativePath, { success: true, noteId: res.noteId });
        if (res.created) imported++;
        else if (res.updated) updated++;
      } else {
        await fs.markUploadResult(folderId, candidate.relativePath, { success: false, error: "Import failed" });
        uploadFailed++;
      }
    } catch (e: any) {
      await fs.markUploadResult(folderId, candidate.relativePath, { success: false, error: e?.message || "Upload error" });
      uploadFailed++;
    }
  }

  return { ok: true, folderId, scanResult, imported, updated, skipped: uploadSkipped, failed: uploadFailed };
}
