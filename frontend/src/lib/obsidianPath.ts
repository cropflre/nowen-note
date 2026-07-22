import type { ObsidianEntryKind } from "./obsidianImportTypes";

const NOTES = new Set(["md", "markdown"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const VIDEOS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIOS = new Set(["mp3", "wav", "ogg", "m4a", "aac", "flac"]);
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", ".svn", "__macosx", "node_modules"]);
const SKIP_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

export const MAX_OBSIDIAN_FILE_BYTES = 250 * 1024 * 1024;
export const MAX_OBSIDIAN_ZIP_FILES = 20_000;

export function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function normalizeObsidianPath(value: string): string {
  let input = safeDecode(String(value || "").trim());
  if (input.startsWith("<") && input.endsWith(">")) input = input.slice(1, -1);
  input = input.replace(/\\/g, "/").replace(/^\/+/, "");
  const out: string[] = [];
  for (const raw of input.split("/")) {
    const part = raw.trim();
    if (!part || part === ".") continue;
    if (part === "..") { if (out.length) out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}

export function pathDirname(path: string): string {
  const value = normalizeObsidianPath(path);
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(0, slash) : "";
}

export function pathBasename(path: string): string {
  const value = normalizeObsidianPath(path);
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

export function getObsidianExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() || name;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function classifyObsidianFile(name: string): ObsidianEntryKind {
  const ext = getObsidianExtension(name);
  if (NOTES.has(ext)) return "note";
  if (IMAGES.has(ext)) return "image";
  if (VIDEOS.has(ext)) return "video";
  if (AUDIOS.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return "attachment";
}

export function sanitizeNotebookSegment(value: string): string {
  let result = String(value || "").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ").replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "");
  if ([...result].length > 60) result = [...result].slice(0, 60).join("").trim();
  return result || "Obsidian Vault";
}

export function skippedObsidianPath(path: string): string | null {
  const parts = normalizeObsidianPath(path).split("/").filter(Boolean);
  if (!parts.length) return "空路径";
  for (const part of parts.slice(0, -1)) {
    const lower = part.toLowerCase();
    if (SKIP_DIRS.has(lower)) return `忽略目录 ${part}`;
    if (lower.startsWith(".") && lower !== ".attachments") return `忽略隐藏目录 ${part}`;
  }
  const file = parts[parts.length - 1];
  const lower = file.toLowerCase();
  if (SKIP_FILES.has(lower) || lower.startsWith("._")) return `忽略系统文件 ${file}`;
  if (lower.startsWith(".") && lower !== ".attachments") return `忽略隐藏文件 ${file}`;
  return null;
}

export function commonTopFolder(paths: string[]): string | null {
  const split = paths.map((path) => normalizeObsidianPath(path).split("/").filter(Boolean)).filter((parts) => parts.length);
  if (!split.length || split.some((parts) => parts.length < 2)) return null;
  const first = split[0][0];
  return split.every((parts) => parts[0] === first) ? first : null;
}

export function resolveVaultRelativePath(directory: string, rawTarget: string): string {
  let target = safeDecode(String(rawTarget || "").trim());
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  target = target.replace(/\\/g, "/");
  const out = target.startsWith("/") ? [] : normalizeObsidianPath(directory).split("/").filter(Boolean);
  for (const raw of target.replace(/^\/+/, "").split("/")) {
    const part = raw.trim();
    if (!part || part === ".") continue;
    if (part === "..") { if (out.length) out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}

export function stripReferenceDecorations(target: string): string {
  let value = target.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  const cut = [value.indexOf("#"), value.indexOf("?")].filter((n) => n >= 0).sort((a, b) => a - b)[0];
  return (cut === undefined ? value : value.slice(0, cut)).trim();
}

export function isExternalAsset(target: string): boolean {
  return /^(?:https?:|data:|blob:|file:|mailto:|tel:|#|\/\/)/i.test(target.trim());
}

export function obsidianMime(name: string): string {
  const ext = getObsidianExtension(name);
  const map: Record<string, string> = {
    png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif", webp:"image/webp", svg:"image/svg+xml", bmp:"image/bmp", ico:"image/x-icon", avif:"image/avif",
    mp4:"video/mp4", webm:"video/webm", mov:"video/quicktime", m4v:"video/x-m4v", ogv:"video/ogg",
    mp3:"audio/mpeg", wav:"audio/wav", ogg:"audio/ogg", m4a:"audio/mp4", aac:"audio/aac", flac:"audio/flac", pdf:"application/pdf",
  };
  return map[ext] || "application/octet-stream";
}
