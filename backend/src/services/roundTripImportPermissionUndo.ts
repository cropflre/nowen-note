import { getDb } from "../db/schema";
import {
  RoundTripImportUndoError,
  type RoundTripImportBatchDetail,
} from "./roundTripImportBatches";
import { undoRoundTripImportBatchWithLinks } from "./roundTripImportLinkUndo";
import {
  readPermissionUndoState,
  restorePermissionUndoState,
  validatePermissionUndoState,
} from "./roundTripPermissionTransfer";

export async function undoRoundTripImportBatchWithLinksAndPermissions(
  userId: string,
  batchId: string,
): Promise<RoundTripImportBatchDetail> {
  const permissionState = readPermissionUndoState(userId, batchId);
  if (permissionState) {
    const conflicts = validatePermissionUndoState(permissionState);
    if (conflicts.length) {
      throw new RoundTripImportUndoError(
        "成员或权限已在导入后发生变化，已拒绝破坏性撤销",
        "IMPORT_BATCH_UNDO_PERMISSION_CONFLICT",
        409,
        conflicts,
      );
    }
  }

  const detail = await undoRoundTripImportBatchWithLinks(userId, batchId);
  if (!permissionState) return detail;

  try {
    restorePermissionUndoState(permissionState);
  } catch (error) {
    const message = `内容已撤销，但成员与权限恢复失败：${error instanceof Error ? error.message : String(error)}`;
    getDb().prepare("UPDATE roundtrip_import_batches SET undoError = ? WHERE id = ? AND userId = ?")
      .run(message, batchId, userId);
    throw new RoundTripImportUndoError(message, "IMPORT_BATCH_UNDO_PERMISSION_RESTORE_FAILED", 409);
  }
  return detail;
}
