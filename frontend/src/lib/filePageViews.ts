import type { FileItem, FileSortKey } from "@/types";

/** Pure helpers for the file page's Image hosting and Storage & tools views. */

export type ImageHostScope = "all" | "image" | "file" | "myUploads" | "unreferenced";
export type PublicLinkStatus = "public" | "private" | "disabled" | "unknown";
export type StorageJumpTarget = "files" | "imageHost";
export const IMAGE_HOST_PAGE_SIZE = 60;

/** The former image-host tabs map to plain list filters; no sharing parameters are ever sent. */
export function imageHostListParams(scope: ImageHostScope, query: string, sort: FileSortKey, page: number) {
  return {
    ...(scope === "image" || scope === "file" ? { category: scope } : {}),
    ...(scope === "myUploads" ? { filter: "myUploads" as const } : scope === "unreferenced" ? { filter: "unreferenced" as const } : {}),
    q: query || undefined, sort, page, pageSize: IMAGE_HOST_PAGE_SIZE,
  };
}

/** Older servers and device-only mode do not report link state; show nothing rather than guess. */
export function publicLinkStatus(file: Pick<FileItem, "externalAccessEnabled" | "publicLinkActive">): PublicLinkStatus {
  if (file.externalAccessEnabled === false) return "disabled";
  if (file.publicLinkActive === true) return "public";
  if (file.publicLinkActive === false) return "private";
  return "unknown";
}

export interface CleanupResponseLike {
  dbOrphansRemoved?: number; dbOrphanBytes?: number;
  contentOrphansRemoved?: number; contentOrphanBytes?: number;
  diskOrphansRemoved?: number; diskOrphanBytes?: number; diskScanSkipped?: boolean;
  totalRemovedItems?: number; totalFreedBytes?: number; graceHours?: number;
}

export interface CleanupSummary {
  content: { count: number; bytes: number };
  db: { count: number; bytes: number };
  disk: { count: number; bytes: number; skipped: boolean };
  count: number;
  bytes: number;
  graceHours: number;
}

/** Device-only mode returns a reduced shape; missing numbers count as zero. */
export function summarizeCleanup(result: CleanupResponseLike): CleanupSummary {
  const n = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  return {
    content: { count: n(result.contentOrphansRemoved), bytes: n(result.contentOrphanBytes) },
    db: { count: n(result.dbOrphansRemoved), bytes: n(result.dbOrphanBytes) },
    disk: { count: n(result.diskOrphansRemoved), bytes: n(result.diskOrphanBytes), skipped: result.diskScanSkipped !== false },
    count: n(result.totalRemovedItems),
    bytes: n(result.totalFreedBytes),
    graceHours: typeof result.graceHours === "number" && result.graceHours >= 0 ? result.graceHours : 24,
  };
}

/** Cleanup only runs when a fresh preview still matches what the user confirmed. */
export function sameCleanupPreview(left: CleanupSummary, right: CleanupSummary): boolean {
  return left.count === right.count && left.bytes === right.bytes
    && left.content.count === right.content.count && left.db.count === right.db.count && left.disk.count === right.disk.count;
}
