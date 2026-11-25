import type { MigrationJob } from "@/lib/migrations";

/**
 * Pure helpers behind the "Import notes" page: which files to send, how to package a folder, and how server
 * states, warnings and errors read to someone who only wants their notes moved over.
 */

/** A chosen or dropped file with its path inside the selected folder ("Vault/Daily/a.md"), or just its name. */
export interface ImportFile { file: File; path: string }

const NOTE_EXTENSIONS = [".md", ".markdown", ".html", ".htm", ".txt"];
// Same list the server accepts as attachments (migrationSourceAdapter `supportedAssets`); SVG is never accepted.
const ASSET_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".heic", ".heif", ".pdf", ".csv", ".json",
  ".docx", ".xlsx", ".pptx", ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".mp4", ".mov", ".webm"];
/** Server limits (MIGRATION_LIMITS) checked before anything is uploaded. */
export const IMPORT_LIMITS = Object.freeze({ uploadBytes: 512 * 1024 * 1024, files: 20_000 });
export const IMPORT_ACCEPT = [".zip", ...NOTE_EXTENSIONS, ...ASSET_EXTENSIONS].join(",");

const extension = (name: string) => { const dot = name.lastIndexOf("."); return dot > 0 ? name.slice(dot).toLowerCase() : ""; };
const baseName = (name: string) => name.replace(/\.[^./]+$/, "");
export const isZipFile = (name: string) => extension(name) === ".zip";
export const isNoteFile = (name: string) => NOTE_EXTENSIONS.includes(extension(name));
export const isAssetFile = (name: string) => ASSET_EXTENSIONS.includes(extension(name));

/** App settings, trash and OS metadata never hold notes (mirrors the server's ignored paths). */
export function isIgnoredImportPath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  const last = (parts[parts.length - 1] || "").toLowerCase();
  return parts.some((part) => part.startsWith(".")) || parts[0] === "__MACOSX" || last === "thumbs.db" || last === "desktop.ini";
}

export type PlannedUpload =
  | { kind: "file"; file: File }
  | { kind: "package"; name: string; entries: ImportFile[] };

export type ImportPlan =
  | { ok: true; name: string; uploads: PlannedUpload[]; unsupported: string[] }
  | { ok: false; reason: "empty" | "no-notes" | "unsupported" | "too-large" | "too-many"; unsupported: string[] };

/**
 * ZIP files go up as they are. Loose notes are packaged together with the files beside them, so links and images
 * between them still resolve; a single loose note goes up on its own.
 */
export function planImport(files: ImportFile[], fallbackName: string): ImportPlan {
  const visible = files.filter((entry) => !isIgnoredImportPath(entry.path));
  const zips = visible.filter((entry) => isZipFile(entry.file.name));
  const notes = visible.filter((entry) => isNoteFile(entry.file.name));
  const assets = visible.filter((entry) => isAssetFile(entry.file.name));
  const unsupported = visible.filter((entry) => !zips.includes(entry) && !notes.includes(entry) && !assets.includes(entry)).map((entry) => entry.path);
  if (!visible.length) return { ok: false, reason: "empty", unsupported };
  if (!zips.length && !notes.length) return { ok: false, reason: unsupported.length ? "unsupported" : "no-notes", unsupported };
  const loose = notes.length ? [...notes, ...assets] : [];
  // A folder's own name is the most recognisable name for the import; its files go in without the extra level.
  const roots = new Set(loose.map((entry) => entry.path.includes("/") ? entry.path.split("/")[0] : ""));
  const commonRoot = roots.size === 1 && !roots.has("") ? [...roots][0] : "";
  const name = (zips.length === 1 && !loose.length ? baseName(zips[0].file.name)
    : commonRoot || (notes.length === 1 && !zips.length ? baseName(notes[0].file.name) : fallbackName)).trim().slice(0, 200) || fallbackName;
  const uploads: PlannedUpload[] = zips.map((entry) => ({ kind: "file", file: entry.file }));
  if (loose.length === 1) uploads.push({ kind: "file", file: loose[0].file });
  else if (loose.length > 1) {
    if (loose.length > IMPORT_LIMITS.files) return { ok: false, reason: "too-many", unsupported };
    const entries = loose.map((entry) => ({ file: entry.file, path: commonRoot ? entry.path.slice(commonRoot.length + 1) : entry.path }));
    uploads.push({ kind: "package", name, entries });
  }
  const sizes = uploads.map((upload) => upload.kind === "file" ? upload.file.size : upload.entries.reduce((sum, entry) => sum + entry.file.size, 0));
  if (sizes.some((size) => size > IMPORT_LIMITS.uploadBytes)) return { ok: false, reason: "too-large", unsupported };
  return { ok: true, name, uploads, unsupported };
}

/** Builds one uncompressed ZIP in the browser; JSZip is only loaded when a folder is imported. */
export async function packageImport(name: string, entries: ImportFile[], onProgress?: (percent: number) => void): Promise<File> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.path, entry.file, { binary: true });
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, (metadata) => onProgress?.(Math.floor(metadata.percent)));
  return new File([blob], `${name}.zip`, { type: "application/zip" });
}

export function filesFromInput(list: FileList | File[] | null | undefined): ImportFile[] {
  return Array.from(list || []).map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }));
}

/** Drag and drop keeps folder structure through the entry API where the browser offers it. */
export async function filesFromDrop(transfer: DataTransfer): Promise<ImportFile[]> {
  const roots = Array.from(transfer.items || []).map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (!roots.length) return filesFromInput(transfer.files);
  const files: ImportFile[] = [];
  const visit = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (files.length > IMPORT_LIMITS.files) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      files.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most 100 entries per call; keep reading until it is empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const root of roots) await visit(root, "");
  return files;
}

export type ImportPhase = "start" | "preparing" | "incomplete" | "preview" | "importing" | "done" | "partial" | "failed" | "cancelled" | "undone";

export function importPhase(job: MigrationJob | null, preparing: boolean): ImportPhase {
  if (preparing) return "preparing";
  if (!job) return "start";
  switch (job.status) {
    case "CREATED": return "incomplete";
    case "UPLOADING": case "SCANNING": case "NORMALIZING": return "preparing";
    case "PREVIEW_READY": return "preview";
    case "APPROVED": case "IMPORTING": case "VERIFYING": case "PAUSED": return "importing";
    case "COMPLETED": return "done";
    case "PARTIAL": return "partial";
    case "CANCELLED": return "cancelled";
    case "UNDONE": return "undone";
    default: return "failed";
  }
}

export type ImportErrorKind = "format" | "encoding" | "size" | "storage" | "busy" | "changed" | "permission" | "network" | "account" | "unknown";

const ERROR_KINDS: Array<[ImportErrorKind, RegExp]> = [
  ["encoding", /^MIGRATION_INVALID_UTF8$/],
  ["size", /^MIGRATION_(?:UPLOAD_TOO_LARGE|ARCHIVE_LIMIT|CONTENT_TOO_LARGE|NOTE_COUNT_LIMIT|REQUEST_TOO_LARGE|STAGING_QUOTA|ITEM_LIMIT|BATCH_LIMIT|CHUNK_TOO_LARGE|SIYUAN_\w*(?:LIMIT|TOO_LARGE))$/],
  ["storage", /^MIGRATION_STORAGE_(?:FULL|CAPACITY|UNAVAILABLE)$/],
  ["busy", /^MIGRATION_(?:ACTIVE_LIMIT|UPLOAD_BUSY|UPLOAD_ACTIVE)$/],
  ["changed", /^MIGRATION_(?:PREVIEW_EXPIRED|STATE_CONFLICT|TARGET_CHANGED|STAGING_EXPIRED|UPLOAD_EXPIRED|SOURCE_INCOMPLETE|UPLOAD_INCOMPLETE|NEEDS_ATTENTION)$/],
  ["permission", /^(?:MIGRATION_(?:FORBIDDEN|TARGET_FORBIDDEN|TOKEN_REVOKED)|RESOURCE_FORBIDDEN)$/],
  ["network", /^MIGRATION_(?:INTERRUPTED|REQUEST_FAILED|PROCESS_FAILED|UPLOAD_\w+|CHUNK_\w+)$/],
  ["format", /^MIGRATION_(?:INVALID_ZIP|ARCHIVE_SIZE_MISMATCH|UNSAFE_ARCHIVE_ENTRY|UNSAFE_PATH|INVALID_MANIFEST|CONTENT_HASH_MISMATCH|ASSET_HASH_MISMATCH|ASSET_TYPE_MISMATCH|UNSUPPORTED_ASSET|UNSUPPORTED_FORMAT|FORMAT_UNSUPPORTED|HUAWEI_FORMAT_UNSUPPORTED|SIYUAN_INVALID_\w+|SIYUAN_DUPLICATE_ID|DUPLICATE_SOURCE_ID|FILENAME_INVALID|EMPTY|CONTENT_MISSING)$/],
];

/** Errors come as thrown API errors (with a code) or as a failed job's stored code. */
export function importErrorKind(cause: unknown): ImportErrorKind {
  const code = typeof cause === "string" ? cause
    : cause && typeof cause === "object" ? String((cause as { code?: unknown }).code || (cause as { message?: unknown }).message || "") : "";
  if (code === "MIGRATION_ACCOUNT_CHANGED") return "account";
  for (const [kind, pattern] of ERROR_KINDS) if (pattern.test(code)) return kind;
  const status = cause && typeof cause === "object" && "status" in cause ? Number((cause as { status?: unknown }).status) : Number.NaN;
  if (cause instanceof TypeError || [0, 408, 429, 502, 503, 504].includes(status)) return "network";
  if (status === 401 || status === 403) return "permission";
  if (status === 413) return "size";
  return "unknown";
}

export type ImportRisk = "missing" | "unsupported" | "simplified" | "external" | "storage";

const RISKS: Array<[ImportRisk, RegExp]> = [
  ["missing", /^(?:UNRESOLVED_RELATIVE_REFERENCES|UNSUPPORTED_ASSET_REFERENCE|SIYUAN_UNRESOLVED_ASSET|SIYUAN_UNSUPPORTED_ASSET|SIYUAN_UNRESOLVED_BLOCK_REFERENCE|NOTION_UNEXPORTED_LINKS|NOTION_LINK_LIMIT)\b/],
  // Only content that is left out. Notion database properties that stay as source data count as "simplified".
  ["unsupported", /^(?:UNSUPPORTED_FILES_SKIPPED|CSV_DATABASE_NOT_CONVERTED|NOTION_CSV_UNMAPPED_ROWS|SIYUAN_NONCURRENT_DOCUMENTS_SKIPPED)\b/],
  ["external", /^(?:EXTERNAL_RESOURCES_PRESERVED|SIYUAN_EXTERNAL_RESOURCES_PRESERVED)\b/],
  ["storage", /^STORAGE_QUOTA_UNVERIFIED\b/],
  // Decisions about changed notes are shown by their own count, not as a general risk.
  ["simplified", /^(?!SOURCE_CHANGED_EXISTING_KEPT|EXISTING_TARGET_UNAVAILABLE)[A-Z][A-Z0-9_]+\b/],
];

/** The handful of things worth knowing before importing, in a stable order. */
export function importRisks(warnings: readonly string[]): ImportRisk[] {
  const found = new Set<ImportRisk>();
  for (const warning of warnings) {
    const match = RISKS.find(([, pattern]) => pattern.test(warning));
    if (match) found.add(match[0]);
  }
  return (["missing", "unsupported", "simplified", "external", "storage"] as const).filter((risk) => found.has(risk));
}

/** The readable half of a warning ("CODE; explanation"), for the details view. */
export function warningText(warning: string): string {
  const at = warning.indexOf("; ");
  return at > 0 && /^[A-Z][A-Z0-9_]+$/.test(warning.slice(0, at)) ? warning.slice(at + 2) : warning;
}

export type ImportToken = { scopes: string[]; lastUsedAt: string | null; revokedAt: string | null; expiresAt: string | null };

/**
 * An assistant counts as connected only when an active token that may run imports has actually been used.
 * Nothing on this page can see the assistant itself.
 */
export function assistantConnection(tokens: readonly ImportToken[], now = Date.now()): { lastUsedAt: string } | null {
  const used = tokens.filter((token) => !token.revokedAt && token.lastUsedAt && token.scopes.includes("export:import")
    && (!token.expiresAt || Date.parse(token.expiresAt) > now))
    .map((token) => token.lastUsedAt!).sort();
  return used.length ? { lastUsedAt: used[used.length - 1] } : null;
}
