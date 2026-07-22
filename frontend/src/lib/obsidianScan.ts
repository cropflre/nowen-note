import type { ObsidianEntry, ObsidianScanResult } from "./obsidianImportTypes";
import {
  MAX_OBSIDIAN_FILE_BYTES, MAX_OBSIDIAN_ZIP_FILES, classifyObsidianFile, commonTopFolder,
  normalizeObsidianPath, obsidianMime, pathBasename, pathDirname, sanitizeNotebookSegment, skippedObsidianPath,
} from "./obsidianPath";

function attachPath(file: File, path: string): File {
  try { Object.defineProperty(file, "webkitRelativePath", { configurable: true, value: path }); } catch { /* old WebView */ }
  return file;
}

function scan(files: File[], source: "folder" | "zip", fallback: string): ObsidianScanResult {
  const rawPaths = files.map((file) => normalizeObsidianPath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name));
  const top = commonTopFolder(rawPaths);
  const entries: ObsidianEntry[] = [];
  const folders = new Set<string>();
  const stats = { notes: 0, attachments: 0, images: 0, videos: 0, pdfs: 0, skipped: 0, folders: 0, totalBytes: 0 };

  files.forEach((file, index) => {
    const relPath = rawPaths[index] || normalizeObsidianPath(file.name);
    const vaultPath = normalizeObsidianPath(top && relPath.startsWith(`${top}/`) ? relPath.slice(top.length + 1) : relPath);
    const fileName = pathBasename(vaultPath) || file.name;
    const skipReason = skippedObsidianPath(vaultPath);
    const tooLarge = file.size > MAX_OBSIDIAN_FILE_BYTES;
    const kind = skipReason || tooLarge ? "skipped" : classifyObsidianFile(fileName);
    const directory = pathDirname(vaultPath);
    const notebookPath = directory ? directory.split("/").map(sanitizeNotebookSegment) : [];
    const parts = directory.split("/").filter(Boolean);
    for (let depth = 1; depth <= parts.length; depth++) folders.add(parts.slice(0, depth).join("/"));
    stats.totalBytes += file.size;
    if (kind === "note") stats.notes++;
    else if (kind === "skipped") stats.skipped++;
    else {
      stats.attachments++;
      if (kind === "image") stats.images++;
      if (kind === "video") stats.videos++;
      if (kind === "pdf") stats.pdfs++;
    }
    entries.push({ relPath, vaultPath, fileName, notebookPath, size: file.size, lastModified: file.lastModified, kind, selected: kind !== "skipped", file, skipReason: skipReason || (tooLarge ? "单文件超过 250 MB 安全上限" : undefined) });
  });
  stats.folders = folders.size;
  return { source, rootFolderName: sanitizeNotebookSegment(top || fallback || "Obsidian Vault"), entries, stats };
}

export function scanObsidianFolder(files: FileList | File[]): ObsidianScanResult {
  return scan(Array.from(files), "folder", "Obsidian Vault");
}

export async function scanObsidianZip(file: File): Promise<ObsidianScanResult> {
  if (!file || !/\.zip$/i.test(file.name)) throw new Error("请选择 Obsidian Vault 的 ZIP 文件");
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(file);
  const entries = Object.entries(zip.files).filter(([, item]) => !item.dir);
  if (entries.length > MAX_OBSIDIAN_ZIP_FILES) throw new Error(`ZIP 文件数量过多（${entries.length}），上限 ${MAX_OBSIDIAN_ZIP_FILES}`);
  const paths = entries.map(([path]) => normalizeObsidianPath(path));
  const top = commonTopFolder(paths);
  const fallback = sanitizeNotebookSegment(file.name.replace(/\.zip$/i, ""));
  const root = top || fallback;
  const files: File[] = [];
  for (const [rawPath, item] of entries) {
    if (rawPath.includes("\0") || rawPath.replace(/\\/g, "/").split("/").includes("..")) continue;
    const path = normalizeObsidianPath(rawPath);
    if (!path) continue;
    const blob = await item.async("blob");
    const name = pathBasename(path) || "file";
    const imported = new File([blob], name, { type: blob.type || obsidianMime(name), lastModified: item.date?.getTime() || file.lastModified || Date.now() });
    files.push(attachPath(imported, top ? path : `${root}/${path}`));
  }
  return scan(files, "zip", root);
}
