import { getDb } from "../db/schema";
import {
  RoundTripImportUndoError,
  type RoundTripImportBatchDetail,
} from "./roundTripImportBatches";
import { undoRoundTripImportBatchWithLinks } from "./roundTripImportLinkUndo";
import {
  readPermissionUndoState,
  restorePermissionAppliedState,
  restorePermissionUndoState,
  validatePermissionUndoState,
} from "./roundTripPermissionTransfer";

/**
 * Undo content/source links and permission mutations as one guarded operation.
 *
 * The existing content undo owns its own transaction and attachment restoration. Permission rows
 * are restored first, then compensated back to their post-import snapshot if content undo fails.
 * This prevents the historical half-undone state where content was already removed while imported
 * memberships remained active.
 */
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
    restorePermissionUndoState(permissionState);
  }

  try {
    return await undoRoundTripImportBatchWithLinks(userId, batchId);
  } catch (error) {
    if (permissionState) {
      try {
        restorePermissionAppliedState(permissionState);
      } catch (compensationError) {
        const message = `内容撤销失败，且权限补偿恢复失败：${compensationError instanceof Error ? compensationError.message : String(compensationError)}`;
        getDb().prepare("UPDATE roundtrip_import_batches SET undoError = ? WHERE id = ? AND userId = ?")
          .run(message, batchId, userId);
        throw new RoundTripImportUndoError(message, "IMPORT_BATCH_UNDO_PERMISSION_COMPENSATION_FAILED", 409);
      }
    }
    throw error;
  }
}
