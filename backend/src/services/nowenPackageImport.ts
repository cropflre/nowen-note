import { executeNowenPackageImportWithBatch } from "./roundTripImportBatches";
import {
  importNowenPackageWithSync,
  type RoundTripImportParams,
} from "./nowenRoundTripSync";

export async function importNowenPackage(zipBuffer: Buffer, params: RoundTripImportParams): Promise<any> {
  return params.dryRun
    ? importNowenPackageWithSync(zipBuffer, params)
    : executeNowenPackageImportWithBatch(zipBuffer, params);
}

export type {
  RoundTripImportParams as ImportParams,
  RoundTripSyncImportMode as RoundTripImportMode,
  RoundTripSyncStrategy as RoundTripConflictStrategy,
} from "./nowenRoundTripSync";
export type { ImportConflict } from "./nowenPackageImportV2";
