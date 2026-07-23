import { executeNowenPackageImportWithBatch } from "./roundTripImportBatches";
import {
  attachRoundTripImportLinkUndo,
  captureRoundTripImportLinkUndo,
} from "./roundTripImportLinkUndo";
import {
  importNowenPackageWithSync,
  type RoundTripImportParams,
} from "./nowenRoundTripSync";

export async function importNowenPackage(zipBuffer: Buffer, params: RoundTripImportParams): Promise<any> {
  if (params.dryRun) return importNowenPackageWithSync(zipBuffer, params);

  const linkSnapshot = await captureRoundTripImportLinkUndo(zipBuffer, params.userId, params.workspaceId);
  const result = await executeNowenPackageImportWithBatch(zipBuffer, params);
  const batchId = String(result?.importBatch?.id || "");
  if (batchId && result?.success) {
    const attached = attachRoundTripImportLinkUndo(params.userId, batchId, linkSnapshot);
    if (!attached.available) {
      result.importBatch = {
        ...(result.importBatch || {}),
        undoAvailable: false,
        reason: attached.reason ?? result.importBatch?.reason ?? null,
      };
    }
  }
  return result;
}

export type {
  RoundTripImportParams as ImportParams,
  RoundTripSyncImportMode as RoundTripImportMode,
  RoundTripSyncStrategy as RoundTripConflictStrategy,
} from "./nowenRoundTripSync";
export type { ImportConflict } from "./nowenPackageImportV2";
