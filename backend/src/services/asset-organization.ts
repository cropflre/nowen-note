import { getDb } from "../db/schema.js";
import {
  resolveFileAttachmentAccess,
  type FileAttachmentAccessRow,
} from "./fileAttachmentAccess.js";
import {
  hasKnowledgeCapability,
  resolveResourceKnowledgeAccess,
} from "./knowledgeCapabilities.js";

export interface AssetFilters {
  category?: "image" | "file";
  fileKind?: "document" | "video" | "audio" | "archive";
  mime?: string;
  q?: string;
  folderId?: string;
  createdAfter?: string;
  createdBefore?: string;
  recentDays?: number;
  minSize?: number;
  maxSize?: number;
  tagIds?: string[];
  referenceState?: "referenced" | "unreferenced" | "multiple";
  duplicateOnly?: boolean;
}
export const ASSET_FILTER_KEYS = [
  "category",
  "fileKind",
  "mime",
  "q",
  "folderId",
  "createdAfter",
  "createdBefore",
  "recentDays",
  "minSize",
  "maxSize",
  "tagIds",
  "referenceState",
  "duplicateOnly",
];
const identifier = /^[\w-]{1,100}$/;
export function assetIds(value: unknown, limit = 200): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > limit ||
    value.some((id) => typeof id !== "string" || !identifier.test(id))
  )
    throw new Error("INVALID_ASSET_IDS");
  return [...new Set(value)] as string[];
}
export function parseAssetFilters(
  input: Record<string, unknown>,
  strict = false,
): AssetFilters {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (strict &&
      Object.keys(input).some((key) => !ASSET_FILTER_KEYS.includes(key)))
  )
    throw new Error("INVALID_FILE_FILTER");
  const result: Record<string, unknown> = {};
  for (const key of ASSET_FILTER_KEYS) {
    const value = input[key];
    if (!strict && key === "category" && value === "all") continue;
    if (value === undefined || value === "") continue;
    if (["minSize", "maxSize", "recentDays"].includes(key)) {
      if (
        !(typeof value === "number" || typeof value === "string") ||
        !/^\d+$/.test(String(value))
      )
        throw new Error("INVALID_FILE_FILTER");
      const number = Number(value);
      if (
        !Number.isSafeInteger(number) ||
        number < 0 ||
        (key === "recentDays" && (number < 1 || number > 3650))
      )
        throw new Error("INVALID_FILE_FILTER");
      result[key] = number;
    } else if (key === "tagIds") {
      const values = typeof value === "string" ? value.split(",") : value;
      if (Array.isArray(values) && !values.length) continue;
      result[key] = assetIds(values, 50);
    } else if (key === "duplicateOnly") {
      if (![true, false, "true", "false"].includes(value as boolean))
        throw new Error("INVALID_FILE_FILTER");
      result[key] = value === true || value === "true";
    } else {
      if (typeof value !== "string" || value.length > 500)
        throw new Error("INVALID_FILE_FILTER");
      if (key === "category" && !["image", "file"].includes(value))
        throw new Error("INVALID_FILE_FILTER");
      if (
        key === "fileKind" &&
        !["document", "video", "audio", "archive"].includes(value)
      )
        throw new Error("INVALID_FILE_FILTER");
      if (
        key === "referenceState" &&
        !["referenced", "unreferenced", "multiple"].includes(value)
      )
        throw new Error("INVALID_FILE_FILTER");
      if (key === "mime" && !/^[\w.+-]+\/[\w.+-]+$/.test(value))
        throw new Error("INVALID_FILE_FILTER");
      if (key === "folderId" && !identifier.test(value))
        throw new Error("INVALID_FILE_FILTER");
      if (
        (key === "createdAfter" || key === "createdBefore") &&
        !Number.isFinite(Date.parse(value))
      )
        throw new Error("INVALID_FILE_FILTER");
      result[key] = value;
    }
  }
  const filters = result as AssetFilters;
  if ((filters.minSize ?? 0) > (filters.maxSize ?? Number.MAX_SAFE_INTEGER))
    throw new Error("INVALID_FILE_FILTER");
  if (
    filters.createdAfter &&
    filters.createdBefore &&
    Date.parse(filters.createdAfter) > Date.parse(filters.createdBefore)
  )
    throw new Error("INVALID_FILE_FILTER");
  return filters;
}

type AssetRow = FileAttachmentAccessRow & {
  id: string;
  hash: string | null;
  filename: string;
};
export function assetDuplicates(
  row: AssetRow,
  userId: string,
): Array<{ id: string; filename: string }> {
  if (!row.hash) return [];
  const rows = getDb()
    .prepare(
      `SELECT id, noteId, userId, workspaceId, uploadSource, filename, hash FROM attachments
    WHERE trashedAt IS NULL AND hash = ? AND id <> ? AND ((? IS NULL AND workspaceId IS NULL AND userId = ?) OR workspaceId = ?)
    ORDER BY createdAt, id`,
    )
    .all(
      row.hash,
      row.id,
      row.workspaceId,
      userId,
      row.workspaceId,
    ) as AssetRow[];
  return rows
    .filter((other) => resolveFileAttachmentAccess(other, userId).canView)
    .map(({ id, filename }) => ({ id, filename }));
}
/** Counts only authorized reference notes; no hidden note names or counts leave this boundary. */
export function filterOrganizedAssets<T extends AssetRow>(
  rows: T[],
  filters: AssetFilters,
  userId: string,
): T[] {
  if (!filters.referenceState && !filters.duplicateOnly) return rows;
  const counts = new Map<string, number>();
  if (filters.referenceState) {
    const access = new Map<string, boolean>();
    for (let offset = 0; offset < rows.length; offset += 200) {
      const ids = rows.slice(offset, offset + 200).map((row) => row.id);
      const references = getDb()
        .prepare(
          `SELECT attachmentId,noteId FROM attachment_references WHERE attachmentId IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...ids) as Array<{ attachmentId: string; noteId: string }>;
      for (const reference of references) {
        if (!access.has(reference.noteId))
          access.set(
            reference.noteId,
            hasKnowledgeCapability(
              resolveResourceKnowledgeAccess("note", reference.noteId, userId),
              "canView",
            ),
          );
        if (access.get(reference.noteId))
          counts.set(
            reference.attachmentId,
            (counts.get(reference.attachmentId) || 0) + 1,
          );
      }
    }
  }
  const duplicateHashes = new Map<string, boolean>();
  return rows.filter((row) => {
    const count = counts.get(row.id) || 0;
    if (filters.referenceState === "referenced" && !count) return false;
    if (filters.referenceState === "unreferenced" && count) return false;
    if (filters.referenceState === "multiple" && count < 2) return false;
    if (filters.duplicateOnly) {
      if (!row.hash) return false;
      if (!duplicateHashes.has(row.hash))
        duplicateHashes.set(row.hash, assetDuplicates(row, userId).length > 0);
      if (!duplicateHashes.get(row.hash)) return false;
    }
    return true;
  });
}
