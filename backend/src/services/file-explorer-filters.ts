import { parseAssetFilters } from "./asset-organization.js";

const KIND_CONDITIONS: Record<string, string> = {
  video: "a.mimeType LIKE 'video/%'",
  audio: "a.mimeType LIKE 'audio/%'",
  archive: "a.mimeType IN ('application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed', 'application/vnd.rar', 'application/x-7z-compressed', 'application/gzip', 'application/x-tar')",
  document: "(a.mimeType LIKE 'text/%' OR a.mimeType IN ('application/pdf', 'application/json', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint') OR a.mimeType LIKE 'application/vnd.openxmlformats-officedocument.%')",
};

/** Shared by the legacy query and both permission/retention projections. */
export function fileExplorerFilters(kind?: string, createdAfter?: string, query: Record<string, string> = {}) {
  const conditions: string[] = ["a.trashedAt IS NULL"];
  const params: string[] = [];
  let filters;
  try { filters = parseAssetFilters({ ...query, fileKind: kind, createdAfter }); }
  catch { return { conditions, params, error: "Invalid file filters", code: "INVALID_FILE_FILTER" }; }
  if (kind) {
    if (!Object.hasOwn(KIND_CONDITIONS, kind)) return { conditions, params, error: "无效的文件分类", code: "INVALID_FILE_KIND" };
    conditions.push(KIND_CONDITIONS[kind]);
  }
  if (createdAfter) {
    const timestamp = Date.parse(createdAfter);
    if (!Number.isFinite(timestamp)) return { conditions, params, error: "无效的日期", code: "INVALID_FILE_DATE" };
    conditions.push("datetime(a.createdAt) >= datetime(?)");
    params.push(new Date(timestamp).toISOString().slice(0, 19).replace("T", " "));
  }
  if (filters.createdBefore) {
    conditions.push("datetime(a.createdAt) <= datetime(?)");
    params.push(filters.createdBefore);
  }
  if (filters.recentDays) {
    conditions.push("datetime(a.createdAt) >= datetime(?)");
    params.push(new Date(Date.now() - filters.recentDays * 86400000).toISOString());
  }
  for (const [key, operator] of [["minSize", ">="], ["maxSize", "<="]] as const) {
    if (filters[key] !== undefined) { conditions.push(`a.size ${operator} ?`); params.push(String(filters[key])); }
  }
  for (const tagId of filters.tagIds || []) {
    conditions.push("EXISTS (SELECT 1 FROM asset_tag_relations atr WHERE atr.attachmentId = a.id AND atr.tagId = ?)");
    params.push(tagId);
  }
  return { conditions, params };
}
