import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { sanitizeForImport } from "../lib/sanitizeHtml";
import { MIGRATION_LIMITS, migrationRelativePathSchema, nmfManifestSchema, nmfNoteSchema, type NmfNote } from "./migrationFormat";
import { createNotionMigrationContext } from "./migrationNotionAdapter";
import { isSiyuanMigration, stageSiyuanMigration } from "./migrationSiyuanAdapter";
import { MIGRATION_SOURCE_ADAPTER_API_VERSION, normalizeMigrationSource, type MigrationSourceAdapterContext } from "./migrationSourceAdapters";

const unzipper = require("unzipper");
type Source = Pick<NmfNote["source"], "platform" | "exportId">;
type ZipEntry = {
  path: string; type: string; uncompressedSize: number; compressedSize: number;
  externalFileAttributes: number; flags: number; compressionMethod: number;
  stream(): NodeJS.ReadableStream;
};
type StagedFile = { diskPath: string; size: number; sha256: string };

export class MigrationSourceError extends Error {
  readonly status = 400;
  constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new MigrationSourceError(code); };
const noteExtension = (name: string): boolean => /\.(md|markdown|html?|txt)$/i.test(name);
const supportedAssets: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".heic": "image/heic", ".heif": "image/heif",
  ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".m4a": "audio/mp4", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
};

/** Files are opened only from the service's private staging directory, never from a client URL/path. */
export async function hashMigrationFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export function sanitizeMigrationHtml(content: string): string { return sanitizeForImport(content); }

export function migrationDirectoryBytes(directory: string): number {
  if (!fs.existsSync(directory)) return 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += migrationDirectoryBytes(filename);
    else if (entry.isFile()) bytes += fs.statSync(filename).size;
  }
  return bytes;
}

export async function sniffMigrationAsset(filePath: string, filename: string): Promise<string> {
  const extension = path.extname(filename).toLowerCase();
  const mime = supportedAssets[extension];
  if (!mime) return fail("MIGRATION_UNSUPPORTED_ASSET");
  const handle = await fs.promises.open(filePath, "r");
  const head = Buffer.alloc(64);
  let bytesRead = 0;
  try { ({ bytesRead } = await handle.read(head, 0, head.length, 0)); } finally { await handle.close(); }
  const bytes = head.subarray(0, bytesRead);
  const ascii = bytes.toString("latin1");
  const prefix = (magic: string) => ascii.startsWith(magic);
  let valid = false;
  switch (extension) {
    case ".png": valid = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); break;
    case ".jpg": case ".jpeg": valid = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255; break;
    case ".gif": valid = prefix("GIF87a") || prefix("GIF89a"); break;
    case ".webp": valid = prefix("RIFF") && ascii.slice(8, 12) === "WEBP"; break;
    case ".pdf": valid = prefix("%PDF-"); break;
    case ".docx": case ".xlsx": case ".pptx": valid = prefix("PK\x03\x04"); break;
    case ".mp3": valid = prefix("ID3") || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0); break;
    case ".wav": valid = prefix("RIFF") && ascii.slice(8, 12) === "WAVE"; break;
    case ".ogg": valid = prefix("OggS"); break;
    case ".flac": valid = prefix("fLaC"); break;
    case ".webm": valid = bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])); break;
    case ".avif": case ".heic": case ".heif": case ".mp4": case ".mov": case ".m4a":
      valid = ascii.slice(4, 8) === "ftyp" && /^(avif|avis|heic|heix|hevc|hevx|mif1|msf1|isom|iso[2-9]|mp4[12]|M4[AV ]|qt  )/.test(ascii.slice(8, 12)); break;
    default: valid = !bytes.includes(0) && !/^\s*(?:<\?php|<script|<!doctype\s+html|<html)/i.test(ascii);
  }
  if (!valid || prefix("MZ") || prefix("\x7fELF")) return fail("MIGRATION_ASSET_TYPE_MISMATCH");
  return mime;
}

function safePath(value: string): string {
  const parsed = migrationRelativePathSchema.safeParse(value);
  if (!parsed.success) return fail("MIGRATION_UNSAFE_PATH");
  if (parsed.data.split("/").some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return fail("MIGRATION_UNSAFE_PATH");
  return parsed.data;
}

/** Bound the central directory before unzipper allocates one object per entry. ZIP64 is outside v1's budgets. */
async function preflightZip(filePath: string): Promise<void> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MIGRATION_LIMITS.uploadBytes) return fail("MIGRATION_UPLOAD_TOO_LARGE");
  const handle = await fs.promises.open(filePath, "r");
  try {
    const tail = Buffer.alloc(Math.min(stat.size, 65_557));
    await handle.read(tail, 0, tail.length, stat.size - tail.length);
    let end = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) { end = offset; break; }
    }
    if (end < 0) return fail("MIGRATION_INVALID_ZIP");
    const entries = tail.readUInt16LE(end + 10);
    const directoryBytes = tail.readUInt32LE(end + 12);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)
      || tail.readUInt16LE(end + 8) !== entries || entries === 0xffff || directoryBytes === 0xffffffff
      || entries > MIGRATION_LIMITS.files || directoryBytes > 16 * 1024 * 1024) return fail("MIGRATION_ARCHIVE_LIMIT");
  } finally { await handle.close(); }
}

async function extractArchive(filePath: string, destination: string, budget: number, assertActive?: () => void): Promise<Map<string, StagedFile>> {
  await preflightZip(filePath);
  const directory = await unzipper.Open.file(filePath) as { files: ZipEntry[] };
  if (directory.files.length > MIGRATION_LIMITS.files) return fail("MIGRATION_ARCHIVE_LIMIT");
  const seen = new Set<string>();
  let declaredTotal = 0;
  const entries = directory.files.map((entry) => {
    const folder = entry.type === "Directory" || entry.path.endsWith("/");
    const name = safePath(folder ? entry.path.slice(0, -1) : entry.path);
    const key = name.toLowerCase();
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
    if (seen.has(key) || (mode && mode !== 0x8000 && mode !== 0x4000)
      || (entry.flags & 1) || ![0, 8].includes(entry.compressionMethod)) return fail("MIGRATION_UNSAFE_ARCHIVE_ENTRY");
    seen.add(key);
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
      || entry.uncompressedSize > (name === "manifest.json" ? MIGRATION_LIMITS.manifestBytes : noteExtension(name) || /\.sy$/i.test(name) ? MIGRATION_LIMITS.contentBytes : MIGRATION_LIMITS.assetBytes)
      || entry.uncompressedSize / Math.max(1, entry.compressedSize) > 1000) return fail("MIGRATION_ARCHIVE_LIMIT");
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > MIGRATION_LIMITS.extractedBytes || declaredTotal > budget) return fail("MIGRATION_ARCHIVE_LIMIT");
    return { entry, name, folder };
  });
  // Never extract into a directory that an earlier upload could have populated with symlinks.
  await fs.promises.rm(destination, { recursive: true, force: true });
  await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
  const files = new Map<string, StagedFile>();
  let actualTotal = 0;
  for (const { entry, name, folder } of entries) {
    assertActive?.();
    if (folder) continue;
    const diskPath = path.join(destination, name);
    await fs.promises.mkdir(path.dirname(diskPath), { recursive: true, mode: 0o700 });
    let size = 0;
    const hash = crypto.createHash("sha256");
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      try { assertActive?.(); } catch (error) { callback(error as Error); return; }
      size += chunk.length; actualTotal += chunk.length;
      if (size > entry.uncompressedSize || actualTotal > MIGRATION_LIMITS.extractedBytes || actualTotal > budget) { callback(new MigrationSourceError("MIGRATION_ARCHIVE_LIMIT")); return; }
      hash.update(chunk); callback(null, chunk);
    } });
    try {
      await pipeline(entry.stream() as never, meter, fs.createWriteStream(diskPath, { flags: "wx", mode: 0o600 }));
    } catch (error) { await fs.promises.rm(destination, { recursive: true, force: true }); throw error; }
    if (size !== entry.uncompressedSize) return fail("MIGRATION_ARCHIVE_SIZE_MISMATCH");
    files.set(name, { diskPath, size, sha256: hash.digest("hex") });
  }
  return files;
}

function formatFor(name: string): NmfNote["contentFormat"] {
  return /\.html?$/i.test(name) ? "html" : /\.txt$/i.test(name) ? "txt" : "markdown";
}
function readText(file: StagedFile, maxBytes: number): string {
  if (file.size > maxBytes) return fail("MIGRATION_CONTENT_TOO_LARGE");
  const buffer = fs.readFileSync(file.diskPath);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, ""); }
  catch { return fail("MIGRATION_INVALID_UTF8"); }
}
function references(content: string, format: NmfNote["contentFormat"]): string[] {
  if (format === "txt") return [];
  const matches = format === "html"
    ? [...content.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1])
    : [...content.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)].map((match) => match[1].replace(/^<|>$/g, ""))
      .concat([...content.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]));
  return [...new Set(matches)].slice(0, 400);
}
function resolveReference(notePath: string, href: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(href.split(/[?#]/)[0]); } catch { return null; }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(notePath), decoded));
  return migrationRelativePathSchema.safeParse(resolved).success ? resolved : null;
}

export async function stageMigrationFile(input: {
  filePath: string; filename: string; jobDir: string; source: Source;
  onNote: (note: NmfNote) => Promise<void>;
  assertActive?: () => void;
}): Promise<{ warnings: string[] }> {
  const relativeUpload = path.relative(input.jobDir, input.filePath).split(path.sep).join("/");
  safePath(relativeUpload);
  const stat = await fs.promises.lstat(input.filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) return fail("MIGRATION_UNSAFE_PATH");
  const isZip = /\.zip$/i.test(input.filename);
  if (!isZip && !noteExtension(input.filename)) return fail("MIGRATION_UNSUPPORTED_FORMAT");
  const warnings = new Set<string>();
  const extraction = path.join(path.dirname(input.filePath), "extracted");
  const budget = MIGRATION_LIMITS.temporaryBytes - migrationDirectoryBytes(input.jobDir) + migrationDirectoryBytes(extraction);
  const files = isZip ? await extractArchive(input.filePath, extraction, budget, input.assertActive)
    : new Map([[safePath(input.filename), { diskPath: input.filePath, size: stat.size, sha256: await hashMigrationFile(input.filePath) }]]);
  const managed = (file: StagedFile) => safePath(path.relative(input.jobDir, file.diskPath).split(path.sep).join("/"));
  const manifestFile = files.get("manifest.json");
  let emitted = 0;
  const emit = async (note: NmfNote) => {
    input.assertActive?.();
    await input.onNote(note);
    if (++emitted % 20 === 0) await yieldEventLoop();
  };
  const context: MigrationSourceAdapterContext = { files, source: input.source,
    readText: (name, maxBytes) => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return fail("MIGRATION_CONTENT_TOO_LARGE");
      return readText(files.get(name) || fail("MIGRATION_CONTENT_MISSING"), Math.min(maxBytes, MIGRATION_LIMITS.manifestBytes));
    },
    managedPath: managed, sniffAsset: sniffMigrationAsset, onNote: emit, assertActive: input.assertActive };
  const normalizeManifest = async (context: MigrationSourceAdapterContext) => {
    let raw: unknown;
    try { raw = JSON.parse(context.readText("manifest.json", MIGRATION_LIMITS.manifestBytes)); } catch { return fail("MIGRATION_INVALID_MANIFEST"); }
    const result = nmfManifestSchema.safeParse(raw);
    if (!result.success) return fail("MIGRATION_INVALID_MANIFEST");
    const manifest = result.data;
    if (input.source.platform !== "files" && (manifest.source.platform !== input.source.platform || manifest.source.exportId !== input.source.exportId)) return fail("MIGRATION_SOURCE_MISMATCH");
    const sourceIds = new Set<string>();
    for (const note of manifest.notes) {
      input.assertActive?.();
      if (sourceIds.has(note.sourceId)) return fail("MIGRATION_DUPLICATE_SOURCE_ID");
      sourceIds.add(note.sourceId);
      const body = files.get(note.contentFile);
      if (!body || body.sha256 !== note.sha256) return fail("MIGRATION_CONTENT_HASH_MISMATCH");
      for (const attachment of note.attachments) {
        const asset = files.get(attachment.path);
        if (!asset || asset.sha256 !== attachment.sha256) return fail("MIGRATION_ASSET_HASH_MISMATCH");
        await sniffMigrationAsset(asset.diskPath, attachment.path);
      }
    }
    for (const note of manifest.notes) {
      const { contentFile, sha256: _hash, sourceId, ...fields } = note;
      const rawContent = readText(files.get(contentFile)!, MIGRATION_LIMITS.contentBytes);
      if (note.contentFormat === "html") warnings.add("HTML_SANITIZED; unsupported styles, scripts and embedded components are removed");
      if (Object.keys(note.metadata).length) warnings.add("SOURCE_METADATA_REPORTED_ONLY; properties, comments, history and sharing permissions are not imported");
      const attachments = await Promise.all(note.attachments.map(async (attachment) => ({
        ...attachment, path: managed(files.get(attachment.path)!),
        originalPath: attachment.originalPath || path.posix.relative(path.posix.dirname(contentFile), attachment.path),
        mimeType: await sniffMigrationAsset(files.get(attachment.path)!.diskPath, attachment.path),
      })));
      await context.onNote(nmfNoteSchema.parse({ ...fields, schemaVersion: 1, source: { ...manifest.source, sourceId },
        content: note.contentFormat === "html" ? sanitizeMigrationHtml(rawContent) : rawContent, attachments }));
    }
    return { warnings: [...warnings] };
  };
  const normalizeSiyuan = async (context: MigrationSourceAdapterContext) => {
    try {
      return await stageSiyuanMigration(context);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (typeof code === "string" && /^MIGRATION_|^SIYUAN_/.test(code)) throw new MigrationSourceError(code);
      throw error;
    }
  };
  const notes = [...files.keys()].filter(noteExtension).filter((name) => !/^(?:__MACOSX|assets|attachments)\//i.test(name)).sort();
  let notion: ReturnType<typeof createNotionMigrationContext> | undefined;
  const matchesNotion = () => {
    try { notion = createNotionMigrationContext({ notePaths: notes, csvPaths: [...files.keys()].filter((name) => /\.csv$/i.test(name)), source: input.source, readText: context.readText }); }
    catch (error) { if (typeof (error as { code?: string }).code === "string") throw new MigrationSourceError((error as { code: string }).code); throw error; }
    return Boolean(notion);
  };
  const normalizeGeneric = async (context: MigrationSourceAdapterContext, notion: ReturnType<typeof createNotionMigrationContext>) => {
    const noteNames = new Set(notes);
    if (!notes.length || notes.length > MIGRATION_LIMITS.notes) return fail("MIGRATION_NOTE_COUNT_LIMIT");
    if (input.source.platform === "huawei") {
      if (notes.some((name) => !/\.(?:txt|html?)$/i.test(name))) return fail("MIGRATION_HUAWEI_FORMAT_UNSUPPORTED");
      warnings.add("HUAWEI_EXPORT_LIMITS; 仅导入已导出的 TXT/HTML 和本地资源；原始时间、标签、手写、语音结构及云端备份不恢复");
    }
    for (const name of files.keys()) {
      if (!noteExtension(name) && !supportedAssets[path.extname(name).toLowerCase()]) warnings.add("UNSUPPORTED_FILES_SKIPPED; scripts, macros, databases and unknown files are not imported");
      if (/\.csv$/i.test(name)) warnings.add("CSV_DATABASE_NOT_CONVERTED; export database pages as Markdown or HTML");
    }
    for (const name of notes) {
      const format = formatFor(name);
      const rawContent = readText(files.get(name)!, MIGRATION_LIMITS.contentBytes);
      const content = format === "html" ? sanitizeMigrationHtml(rawContent) : rawContent;
      if (format === "html") warnings.add("HTML_SANITIZED; unsupported styles, scripts and embedded components are removed");
      const attachments: NmfNote["attachments"] = [];
      const links: NmfNote["links"] = [];
      for (const href of references(content, format)) {
        if (/^(?:https?:)?\/\//i.test(href)) { warnings.add("EXTERNAL_RESOURCES_PRESERVED; remote images and links are not downloaded or verified"); continue; }
        const resolved = resolveReference(name, href);
        if (!resolved) continue;
        const target = files.get(resolved);
        if (!target) { warnings.add("UNRESOLVED_RELATIVE_REFERENCES; original links are preserved"); continue; }
        if (noteNames.has(resolved)) { links.push({ href, targetSourceId: resolved }); continue; }
        if (!supportedAssets[path.extname(resolved).toLowerCase()]) { warnings.add("UNSUPPORTED_ASSET_REFERENCE; original links are preserved"); continue; }
        attachments.push({ assetId: crypto.createHash("sha256").update(resolved).digest("hex"), path: managed(target),
          sha256: target.sha256, originalPath: href, mimeType: await sniffMigrationAsset(target.diskPath, resolved) });
      }
      const titleMatch = format === "html" ? /<title[^>]*>([^<]+)<\/title>/i.exec(rawContent) : /^#\s+(.+)$/m.exec(content);
      const note: NmfNote = { schemaVersion: 1, source: { ...input.source, sourceId: name },
        title: (titleMatch?.[1]?.trim() || path.posix.basename(name).replace(/\.[^.]+$/, "")).slice(0, 500),
        path: path.posix.dirname(name) === "." ? [] : path.posix.dirname(name).split("/"),
        contentFormat: format, content, attachments, links, tags: [], metadata: {} };
      await context.onNote(nmfNoteSchema.parse(notion ? notion.decorate(name, note) : note));
    }
    notion?.warnings.forEach((warning) => warnings.add(warning));
    return { warnings: [...warnings] };
  };
  const apiVersion = MIGRATION_SOURCE_ADAPTER_API_VERSION;
  return normalizeMigrationSource([
    { apiVersion, id: "nmf-v1", matches: () => Boolean(manifestFile), normalize: normalizeManifest },
    { apiVersion, id: "siyuan-native-zip", matches: () => isSiyuanMigration(files), normalize: normalizeSiyuan },
    { apiVersion, id: "notion-markdown-html-csv", matches: matchesNotion, normalize: (context) => normalizeGeneric(context, notion!) },
    { apiVersion, id: "huawei-notepad-files", matches: () => input.source.platform === "huawei", normalize: (context) => normalizeGeneric(context, null) },
    { apiVersion, id: "generic-files", matches: () => true, normalize: (context) => normalizeGeneric(context, null) },
  ], context);
}
