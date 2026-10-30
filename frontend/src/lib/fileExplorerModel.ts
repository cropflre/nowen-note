export type AssetFolder = { id: string; name: string; parentId: string | null; fileCount?: number };
export type AssetView = "grid" | "list" | "masonry";
export type AssetCategory = "all" | "recent" | "image" | "document" | "video" | "audio" | "archive" | "unorganized";

export function folderPath(folders: AssetFolder[], id: string | null): AssetFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const visited = new Set<string>();
  const path: AssetFolder[] = [];
  let current = id;
  while (current && !visited.has(current)) {
    visited.add(current);
    const folder = byId.get(current);
    if (!folder) break;
    path.unshift(folder);
    current = folder.parentId;
  }
  return path;
}

export function selectFile(previous: Set<string>, orderedIds: string[], id: string, anchor: string | null,
  modifiers: { toggle?: boolean; range?: boolean }): Set<string> {
  const start = anchor ? orderedIds.indexOf(anchor) : -1;
  const end = orderedIds.indexOf(id);
  if (modifiers.range && start >= 0 && end >= 0) {
    const range = orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1);
    return new Set(modifiers.toggle ? [...previous, ...range] : range);
  }
  if (modifiers.toggle) {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }
  return new Set([id]);
}

export function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function assetFileKind(mime: string): "image" | "document" | "video" | "audio" | "archive" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (["application/zip", "application/x-zip-compressed", "application/x-rar-compressed", "application/vnd.rar", "application/x-7z-compressed", "application/gzip", "application/x-tar"].includes(mime)) return "archive";
  if (mime.startsWith("text/") || mime.startsWith("application/vnd.openxmlformats-officedocument.")
    || ["application/pdf", "application/json", "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"].includes(mime)) return "document";
  return "other";
}
