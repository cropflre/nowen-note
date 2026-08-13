import fs from "fs";
import path from "path";
import {
  roundTripImportBatchesRepository,
  type RoundTripImportBatchRow,
} from "../repositories/roundTripImportBatchesRepository";
import type {
  RoundTripImportBatchDetail,
  RoundTripImportBatchSummary,
} from "./roundTripImportBatches";

const DATA_DIR = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
const UNDO_ROOT = path.join(DATA_DIR, "import-undo");

function workspaceScope(workspaceId: string | null | undefined): string {
  return workspaceId || "personal";
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value || "") as T;
  } catch {
    return fallback;
  }
}

function removeUndoDir(batchId: string): void {
  try {
    fs.rmSync(path.join(UNDO_ROOT, batchId), { recursive: true, force: true });
  } catch {
    // Expiration cleanup is best effort for filesystem state. The database flag
    // remains authoritative and prevents a stale backup from being reused.
  }
}

function publicBatch(row: RoundTripImportBatchRow): RoundTripImportBatchDetail {
  const preview = parseJson<Record<string, unknown>>(row.previewJson, {});
  const result = parseJson<Record<string, unknown>>(row.resultJson, {});
  const counts = (
    result.counts && typeof result.counts === "object"
      ? result.counts
      : preview.counts
  ) as Record<string, number> | undefined;
  const warnings = Array.isArray(result.warnings)
    ? result.warnings
    : Array.isArray(preview.warnings)
      ? preview.warnings
      : [];
  const errors = Array.isArray(result.errors)
    ? result.errors
    : Array.isArray(preview.errors)
      ? preview.errors
      : [];

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    importMode: row.importMode,
    packageKind: row.packageKind,
    sourceInstanceId: row.sourceInstanceId,
    sourceExportBatchId: row.sourceExportBatchId,
    status: row.status,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    undoneAt: row.undoneAt,
    undo: {
      available: row.undoAvailable && row.status === "completed",
      expiresAt: row.undoExpiresAt,
      reason: row.undoUnavailableReason,
      error: row.undoError,
    },
    counts: counts || {},
    warningCount: warnings.length,
    errorCount: errors.length,
    preview,
    result,
  };
}

export async function cleanupExpiredRoundTripImportUndoMetadata(): Promise<string[]> {
  const ids = await roundTripImportBatchesRepository.findExpiredUndoIds(
    new Date().toISOString(),
  );
  if (!ids.length) return [];

  await roundTripImportBatchesRepository.markUndoExpired(ids);
  ids.forEach(removeUndoDir);
  return ids;
}

export async function listRoundTripImportBatchMetadata(
  userId: string,
  options: { workspaceId?: string | null; limit?: number } = {},
): Promise<RoundTripImportBatchSummary[]> {
  await cleanupExpiredRoundTripImportUndoMetadata();
  const limit = Math.max(1, Math.min(Number(options.limit) || 30, 100));
  const rows = await roundTripImportBatchesRepository.listByUser(userId, {
    workspaceScope: options.workspaceId === undefined
      ? undefined
      : workspaceScope(options.workspaceId),
    limit,
  });

  return rows.map((row) => {
    const detail = publicBatch(row);
    const { preview: _preview, result: _result, ...summary } = detail;
    return summary;
  });
}

export async function getRoundTripImportBatchMetadata(
  userId: string,
  batchId: string,
): Promise<RoundTripImportBatchDetail | null> {
  await cleanupExpiredRoundTripImportUndoMetadata();
  const row = await roundTripImportBatchesRepository.getByUserAndId(userId, batchId);
  return row ? publicBatch(row) : null;
}
