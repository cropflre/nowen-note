import crypto from "crypto";
import path from "path";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { syncReferences } from "../lib/attachmentRefs";
import { createDeduplicatedAttachmentRow, type ExistingAttachmentForDedup } from "../routes/attachments-core";
import { deleteAttachmentObject, getUploadMonthPath, writeAttachmentObject } from "./attachment-storage";
import { enqueueAttachment } from "./embedding-worker";
import {
  jsonDepth,
  parseWeChatDataAnalysisPayload,
  type NormalizedWeChatFavorite,
  type NormalizedWeChatFavoriteItem,
  type WeChatFavoriteItemKind,
} from "./wechatFavoritesAdapters/wechatDataAnalysisV1";

const unzipper = require("unzipper");

export type WeChatDuplicateStrategy = "skip" | "update" | "duplicate";

export interface WeChatFavoritesImportOptions {
  userId: string;
  workspaceId: string | null;
  dryRun?: boolean;
  rootNotebookName?: string;
  groupByYear?: boolean;
  preserveTags?: boolean;
  continueOnMissingMedia?: boolean;
  duplicateStrategy?: WeChatDuplicateStrategy;
  selectedTypes?: string[];
}

export interface WeChatFavoriteImportItemResult {
  externalId: string;
  title: string;
  status: "imported" | "updated" | "skipped" | "partial" | "failed";
  noteId?: string;
  warnings?: string[];
  error?: string;
}

export interface WeChatFavoritesImportReport {
  success: boolean;
  dryRun: boolean;
  batchId: string;
  adapter: "wechat-data-analysis-v1";
  rootNotebookId?: string;
  counts: {
    total: number;
    selected: number;
    imported: number;
    updated: number;
    skipped: number;
    partial: number;
    failed: number;
    attachments: number;
    attachmentDeduplicated: number;
    mediaMissing: number;
    mediaTooLarge: number;
    tagsCreated: number;
    tagsReused: number;
    duplicateExisting: number;
    wouldCreate: number;
    wouldUpdate: number;
    wouldSkip: number;
  };
  stats: {
    types: Record<string, number>;
    itemKinds: Record<string, number>;
    tags: number;
    dateFrom?: string;
    dateTo?: string;
    mediaReferences: number;
    mediaAvailable: number;
    mediaMissing: number;
    mediaBytes: number;
    zipEntries: number;
    zipUncompressedBytes: number;
  };
  warnings: string[];
  items: WeChatFavoriteImportItemResult[];
  durationMs: number;
}

interface ZipEntryLike {
  path: string;
  type?: string;
  compressedSize?: number;
  uncompressedSize?: number;
  vars?: { compressedSize?: number; uncompressedSize?: number };
  buffer(): Promise<Buffer>;
}

interface PackageScan {
  favorites: NormalizedWeChatFavorite[];
  mediaEntries: ZipEntryLike[];
  adapter: "wechat-data-analysis-v1";
  warnings: string[];
  zipEntries: number;
  zipUncompressedBytes: number;
}

interface StoredAttachment {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  deduplicated: boolean;
}

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_JSON_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_COMPRESSION_RATIO = 250;
const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const SOURCE_TYPE = "wechat-favorite";

const BLOCKED_EXTENSIONS = new Set([
  "exe", "dll", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "js", "jse",
  "wsf", "wsh", "hta", "lnk", "sh", "bash", "zsh", "fish", "app", "apk", "dmg",
]);
const NESTED_ARCHIVE_EXTENSIONS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]);

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/x-m4v",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
  ogg: "audio/ogg", opus: "audio/opus", amr: "audio/amr", silk: "application/octet-stream",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function positiveEnv(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function budgets() {
  return {
    maxEntries: positiveEnv("WECHAT_FAVORITES_IMPORT_MAX_ENTRIES", DEFAULT_MAX_ENTRIES, 200_000),
    maxTotalBytes: positiveEnv("WECHAT_FAVORITES_IMPORT_MAX_UNCOMPRESSED_BYTES", DEFAULT_MAX_TOTAL_BYTES, 20 * 1024 * 1024 * 1024),
    maxJsonBytes: positiveEnv("WECHAT_FAVORITES_IMPORT_MAX_JSON_BYTES", DEFAULT_MAX_JSON_BYTES, 512 * 1024 * 1024),
    maxCompressionRatio: positiveEnv("WECHAT_FAVORITES_IMPORT_MAX_COMPRESSION_RATIO", DEFAULT_MAX_COMPRESSION_RATIO, 2_000),
    maxAttachmentBytes: positiveEnv(
      "MAX_ATTACHMENT_SIZE_MB",
      DEFAULT_MAX_ATTACHMENT_BYTES / 1024 / 1024,
      10_240,
    ) * 1024 * 1024,
  };
}

export class WeChatFavoritesPackageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 413 | 415 = 400,
  ) {
    super(message);
  }
}

function entrySize(entry: ZipEntryLike): number {
  const value = entry.vars?.uncompressedSize ?? entry.uncompressedSize ?? 0;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function compressedSize(entry: ZipEntryLike): number {
  const value = entry.vars?.compressedSize ?? entry.compressedSize ?? 0;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normalizeSafeZipPath(value: string): string | null {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw || raw.includes("\u0000") || raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function extensionOf(value: string): string {
  const base = value.split("/").pop() || value;
  const index = base.lastIndexOf(".");
  return index >= 0 ? base.slice(index + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function safeFilename(value: string, fallback: string): string {
  const base = (value.split(/[\\/]/).pop() || fallback)
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .trim();
  return base.slice(0, 240) || fallback;
}

function safeNotebookName(value: string): string {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 60)
    .trim();
  return cleaned || "微信收藏";
}

function workspaceScope(workspaceId: string | null): string {
  return workspaceId || "personal";
}

function ensureOriginSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS note_import_origins (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      workspaceScope TEXT NOT NULL,
      noteId TEXT NOT NULL,
      sourceType TEXT NOT NULL,
      externalId TEXT NOT NULL,
      contentHash TEXT,
      batchId TEXT,
      importedAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT,
      metadata TEXT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_note_import_origins_scope_external
      ON note_import_origins(userId, workspaceScope, sourceType, externalId);
    CREATE INDEX IF NOT EXISTS idx_note_import_origins_note
      ON note_import_origins(noteId);
    CREATE INDEX IF NOT EXISTS idx_note_import_origins_batch
      ON note_import_origins(batchId);
  `);
}

function parseJsonBuffer(buffer: Buffer, filename: string): unknown {
  let text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) throw new WeChatFavoritesPackageError(`JSON 文件为空：${filename}`, "WECHAT_JSON_EMPTY");
  try {
    const value = JSON.parse(text);
    if (jsonDepth(value, MAX_JSON_DEPTH) > MAX_JSON_DEPTH) {
      throw new WeChatFavoritesPackageError(`JSON 嵌套层级过深：${filename}`, "WECHAT_JSON_TOO_DEEP", 413);
    }
    return value;
  } catch (error) {
    if (error instanceof WeChatFavoritesPackageError) throw error;
    throw new WeChatFavoritesPackageError(`JSON 格式无效：${filename}`, "WECHAT_JSON_INVALID");
  } finally {
    text = "";
  }
}

function candidatePriority(entryPath: string): number {
  const lower = entryPath.toLowerCase();
  if (/(^|\/)(favorites?|收藏)[^/]*\.json$/.test(lower)) return 0;
  if (/(^|\/)(messages?|conversations?)[^/]*\.json$/.test(lower)) return 1;
  return 2;
}

async function scanPackage(zipFilePath: string): Promise<PackageScan> {
  const limit = budgets();
  let directory: any;
  try {
    directory = await unzipper.Open.file(zipFilePath);
  } catch {
    throw new WeChatFavoritesPackageError("ZIP 文件损坏或无法读取", "WECHAT_ZIP_INVALID");
  }
  const entries = (directory.files || []) as ZipEntryLike[];
  if (entries.length > limit.maxEntries) {
    throw new WeChatFavoritesPackageError(`ZIP 条目过多，最多支持 ${limit.maxEntries} 个文件`, "WECHAT_ZIP_TOO_MANY_ENTRIES", 413);
  }

  let totalBytes = 0;
  const safeEntries: Array<{ path: string; entry: ZipEntryLike }> = [];
  const warnings = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "Directory") continue;
    const normalized = normalizeSafeZipPath(entry.path);
    if (!normalized) {
      throw new WeChatFavoritesPackageError(`ZIP 包含不安全路径：${entry.path}`, "WECHAT_ZIP_PATH_TRAVERSAL", 400);
    }
    const size = entrySize(entry);
    const compressed = compressedSize(entry);
    totalBytes += size;
    if (totalBytes > limit.maxTotalBytes) {
      throw new WeChatFavoritesPackageError("ZIP 解压后总体积超过安全限制", "WECHAT_ZIP_BUDGET_EXCEEDED", 413);
    }
    if (compressed > 0 && size > 1024 * 1024 && size / compressed > limit.maxCompressionRatio) {
      throw new WeChatFavoritesPackageError(`ZIP 条目压缩比异常：${normalized}`, "WECHAT_ZIP_COMPRESSION_RATIO", 413);
    }
    const lower = normalized.toLowerCase();
    if (lower.includes("/__macosx/") || lower.startsWith("__macosx/") || /(^|\/)\.[^/]+/.test(lower)) continue;
    const ext = extensionOf(normalized);
    if (BLOCKED_EXTENSIONS.has(ext)) {
      warnings.add(`已跳过高风险文件：${normalized}`);
      continue;
    }
    if (NESTED_ARCHIVE_EXTENSIONS.has(ext)) {
      warnings.add(`已跳过嵌套压缩包：${normalized}`);
      continue;
    }
    safeEntries.push({ path: normalized, entry });
  }

  const jsonEntries = safeEntries
    .filter(({ path }) => extensionOf(path) === "json")
    .sort((a, b) => candidatePriority(a.path) - candidatePriority(b.path));
  if (jsonEntries.length === 0) {
    throw new WeChatFavoritesPackageError("未找到微信收藏 JSON 主文件", "WECHAT_JSON_NOT_FOUND", 415);
  }

  const favorites = new Map<string, NormalizedWeChatFavorite>();
  let recognized = false;
  for (const { path: jsonPath, entry } of jsonEntries) {
    const size = entrySize(entry);
    if (size > limit.maxJsonBytes) {
      warnings.add(`JSON 文件过大，已跳过：${jsonPath}`);
      continue;
    }
    let parsed: unknown;
    try {
      const buffer = await entry.buffer();
      if (buffer.byteLength > limit.maxJsonBytes) {
        warnings.add(`JSON 文件过大，已跳过：${jsonPath}`);
        continue;
      }
      parsed = parseJsonBuffer(buffer, jsonPath);
    } catch (error) {
      if (candidatePriority(jsonPath) <= 1) throw error;
      warnings.add(`无法解析非主 JSON，已忽略：${jsonPath}`);
      continue;
    }
    const result = parseWeChatDataAnalysisPayload(parsed);
    if (!result) continue;
    recognized = true;
    for (const favorite of result.favorites) {
      const existing = favorites.get(favorite.externalId);
      if (!existing) {
        favorites.set(favorite.externalId, favorite);
      } else {
        existing.textBlocks = Array.from(new Set([...existing.textBlocks, ...favorite.textBlocks]));
        existing.items.push(...favorite.items);
        existing.tags = Array.from(new Set([...existing.tags, ...favorite.tags]));
      }
    }
  }
  if (!recognized || favorites.size === 0) {
    throw new WeChatFavoritesPackageError(
      "未识别到 WeChatDataAnalysis 微信收藏数据。请在工具中选择“收藏”并导出 JSON ZIP。",
      "WECHAT_ADAPTER_NOT_RECOGNIZED",
      415,
    );
  }

  const mediaEntries = safeEntries
    .filter(({ path }) => extensionOf(path) !== "json")
    .map(({ entry }) => entry);
  return {
    favorites: Array.from(favorites.values()),
    mediaEntries,
    adapter: "wechat-data-analysis-v1",
    warnings: Array.from(warnings),
    zipEntries: entries.length,
    zipUncompressedBytes: totalBytes,
  };
}

function aliasesFor(value: string): string[] {
  let decoded = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
  decoded = decoded.toLowerCase().replace(/^\/+/, "");
  if (!decoded) return [];
  const base = decoded.split("/").pop() || decoded;
  const stem = base.replace(/\.[^.]+$/, "");
  const md5s = decoded.match(/[0-9a-f]{32}/g) || [];
  return Array.from(new Set([decoded, base, stem, ...md5s].filter(Boolean)));
}

function buildMediaIndex(entries: ZipEntryLike[]): Map<string, ZipEntryLike[]> {
  const index = new Map<string, ZipEntryLike[]>();
  for (const entry of entries) {
    const normalized = normalizeSafeZipPath(entry.path);
    if (!normalized) continue;
    for (const alias of aliasesFor(normalized)) {
      const values = index.get(alias) || [];
      values.push(entry);
      index.set(alias, values);
    }
  }
  return index;
}

function resolveMediaEntry(item: NormalizedWeChatFavoriteItem, index: Map<string, ZipEntryLike[]>): {
  entry: ZipEntryLike | null;
  ambiguous?: boolean;
} {
  const hits = new Set<ZipEntryLike>();
  for (const ref of item.mediaRefs) {
    for (const alias of aliasesFor(ref)) {
      (index.get(alias) || []).forEach((entry) => hits.add(entry));
    }
  }
  if (hits.size === 1) return { entry: Array.from(hits)[0] };
  if (hits.size > 1) {
    const kindExts: Record<WeChatFavoriteItemKind, Set<string>> = {
      image: new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]),
      emoji: new Set(["png", "jpg", "jpeg", "gif", "webp"]),
      video: new Set(["mp4", "webm", "mov", "m4v"]),
      voice: new Set(["mp3", "m4a", "aac", "wav", "ogg", "opus", "amr", "silk"]),
      file: new Set(), text: new Set(), link: new Set(), location: new Set(), chatHistory: new Set(), contact: new Set(), other: new Set(),
    };
    const filtered = Array.from(hits).filter((entry) => kindExts[item.kind].has(extensionOf(entry.path)));
    if (filtered.length === 1) return { entry: filtered[0] };
    return { entry: null, ambiguous: true };
  }
  return { entry: null };
}

function contentHash(favorite: NormalizedWeChatFavorite): string {
  return crypto.createHash("sha256").update(JSON.stringify(favorite)).digest("hex");
}

function lookupOrigin(userId: string, workspaceId: string | null, externalId: string): {
  id: string;
  noteId: string;
  contentHash: string | null;
} | undefined {
  return getDb().prepare(
    `SELECT id, noteId, contentHash FROM note_import_origins
     WHERE userId = ? AND workspaceScope = ? AND sourceType = ? AND externalId = ?`,
  ).get(userId, workspaceScope(workspaceId), SOURCE_TYPE, externalId) as
    | { id: string; noteId: string; contentHash: string | null }
    | undefined;
}

function ensureNotebook(args: {
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
  name: string;
  icon?: string;
}): string {
  const db = getDb();
  const row = db.prepare(
    args.parentId
      ? `SELECT id FROM notebooks WHERE parentId = ? AND name = ? AND isDeleted = 0 AND workspaceId ${args.workspaceId ? "= ?" : "IS NULL"} LIMIT 1`
      : `SELECT id FROM notebooks WHERE parentId IS NULL AND name = ? AND isDeleted = 0 AND userId = ? AND workspaceId ${args.workspaceId ? "= ?" : "IS NULL"} LIMIT 1`,
  ).get(...(
    args.parentId
      ? args.workspaceId ? [args.parentId, args.name, args.workspaceId] : [args.parentId, args.name]
      : args.workspaceId ? [args.name, args.userId, args.workspaceId] : [args.name, args.userId]
  )) as { id: string } | undefined;
  if (row) return row.id;
  const id = uuid();
  db.prepare(
    `INSERT INTO notebooks (id, userId, parentId, name, icon, workspaceId)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, args.userId, args.parentId, args.name, args.icon || "💚", args.workspaceId);
  return id;
}

function yearForFavorite(favorite: NormalizedWeChatFavorite): string {
  const value = favorite.createdAt || favorite.updatedAt;
  const match = value?.match(/^(\d{4})-/);
  return match?.[1] || "其他年份";
}

function createPlaceholderNote(args: {
  userId: string;
  workspaceId: string | null;
  notebookId: string;
  favorite: NormalizedWeChatFavorite;
}): string {
  const id = uuid();
  const placeholder = JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "正在导入微信收藏…" }] }],
  });
  const createdAt = args.favorite.createdAt || args.favorite.updatedAt;
  const updatedAt = args.favorite.updatedAt || createdAt;
  if (createdAt) {
    getDb().prepare(
      `INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, workspaceId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, 'tiptap-json', ?, ?, ?)`,
    ).run(id, args.userId, args.notebookId, args.favorite.title, placeholder, args.favorite.title, args.workspaceId, createdAt, updatedAt || createdAt);
  } else {
    getDb().prepare(
      `INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, workspaceId)
       VALUES (?, ?, ?, ?, ?, ?, 'tiptap-json', ?)`,
    ).run(id, args.userId, args.notebookId, args.favorite.title, placeholder, args.favorite.title, args.workspaceId);
  }
  return id;
}

function textNode(text: string, href?: string): any {
  const node: any = { type: "text", text: text || " " };
  if (href) {
    node.marks = [{
      type: "link",
      attrs: { href, target: "_blank", rel: "noopener noreferrer nofollow" },
    }];
  }
  return node;
}

function paragraph(parts: Array<{ text: string; href?: string }>): any {
  return { type: "paragraph", content: parts.filter((part) => part.text).map((part) => textNode(part.text, part.href)) };
}

function safeLink(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function buildContent(args: {
  favorite: NormalizedWeChatFavorite;
  media: Map<NormalizedWeChatFavoriteItem, StoredAttachment>;
  warnings: string[];
}): { content: string; contentText: string } {
  const nodes: any[] = [];
  const plain: string[] = [args.favorite.title];
  for (const block of args.favorite.textBlocks) {
    if (!block) continue;
    block.split(/\n{2,}/).forEach((value) => {
      const text = value.trim();
      if (text) nodes.push(paragraph([{ text }]));
    });
    plain.push(block);
  }

  for (const item of args.favorite.items) {
    const stored = args.media.get(item);
    const title = item.title || stored?.filename || item.kind;
    if (stored && (item.kind === "image" || item.kind === "emoji") && stored.mimeType.startsWith("image/")) {
      nodes.push({ type: "image", attrs: { src: stored.url, alt: title, title } });
      if (item.description) nodes.push(paragraph([{ text: item.description }]));
    } else if (stored) {
      const icon = item.kind === "video" ? "🎬" : item.kind === "voice" ? "🎵" : "📎";
      const href = item.kind === "video" || item.kind === "voice" ? `${stored.url}?inline=1` : stored.url;
      nodes.push(paragraph([{ text: `${icon} ${title}`, href }]));
      if (item.description && item.description !== title) nodes.push(paragraph([{ text: item.description }]));
    } else if (item.kind === "location" && item.location) {
      const label = item.location.name || item.location.address || title || "位置";
      const lat = item.location.latitude;
      const lng = item.location.longitude;
      const href = lat && lng ? `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}` : undefined;
      nodes.push(paragraph([{ text: `📍 ${label}`, href }]));
      if (item.location.address && item.location.address !== label) nodes.push(paragraph([{ text: item.location.address }]));
    } else {
      const href = safeLink(item.url);
      const icon = item.kind === "link" ? "🔗" : item.kind === "contact" ? "👤" : "•";
      nodes.push(paragraph([{ text: `${icon} ${title || item.description || "收藏内容"}`, href }]));
      if (item.description && item.description !== title) nodes.push(paragraph([{ text: item.description }]));
    }
    plain.push(title, item.description, stored?.filename || "", item.sourceName || "");
  }

  const sourceParts: string[] = ["来源：微信收藏"];
  if (args.favorite.type) sourceParts.push(`类型：${args.favorite.type}`);
  if (args.favorite.createdAt) sourceParts.push(`收藏时间：${args.favorite.createdAt}`);
  if (args.favorite.source?.name) sourceParts.push(`原来源：${args.favorite.source.name}`);
  nodes.push({ type: "horizontalRule" });
  nodes.push(paragraph([{ text: sourceParts.join(" · ") }]));
  if (args.warnings.length) nodes.push(paragraph([{ text: `导入提示：${args.warnings.join("；")}` }]));
  plain.push(...sourceParts, ...args.warnings);

  if (nodes.length === 0) nodes.push(paragraph([{ text: "（空收藏）" }]));
  return {
    content: JSON.stringify({ type: "doc", content: nodes }),
    contentText: plain.filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 2_000_000),
  };
}

async function storeAttachment(args: {
  entry: ZipEntryLike;
  noteId: string;
  userId: string;
  workspaceId: string | null;
}): Promise<StoredAttachment> {
  const limit = budgets();
  const size = entrySize(args.entry);
  if (size > limit.maxAttachmentBytes) {
    throw new WeChatFavoritesPackageError(
      `附件过大：${args.entry.path}（最大 ${Math.round(limit.maxAttachmentBytes / 1024 / 1024)}MB）`,
      "WECHAT_MEDIA_TOO_LARGE",
      413,
    );
  }
  const ext = extensionOf(args.entry.path) || "bin";
  if (BLOCKED_EXTENSIONS.has(ext) || NESTED_ARCHIVE_EXTENSIONS.has(ext) || ext === "svg" || ext === "html" || ext === "htm") {
    throw new WeChatFavoritesPackageError(`不支持的附件类型：.${ext}`, "WECHAT_MEDIA_UNSAFE", 415);
  }
  const buffer = await args.entry.buffer();
  if (buffer.byteLength > limit.maxAttachmentBytes) {
    throw new WeChatFavoritesPackageError(`附件过大：${args.entry.path}`, "WECHAT_MEDIA_TOO_LARGE", 413);
  }
  const mimeType = MIME_BY_EXT[ext] || "application/octet-stream";
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const db = getDb();
  const dedup = db.prepare(
    args.workspaceId
      ? `SELECT id, path, mimeType, size, filename, hash FROM attachments WHERE userId = ? AND workspaceId = ? AND hash = ? LIMIT 1`
      : `SELECT id, path, mimeType, size, filename, hash FROM attachments WHERE userId = ? AND workspaceId IS NULL AND hash = ? LIMIT 1`,
  ).get(...(args.workspaceId ? [args.userId, args.workspaceId, hash] : [args.userId, hash])) as ExistingAttachmentForDedup | undefined;
  const filename = safeFilename(args.entry.path, `wechat-media.${ext}`);
  if (dedup) {
    const clone = createDeduplicatedAttachmentRow({
      source: dedup,
      noteId: args.noteId,
      userId: args.userId,
      workspaceId: args.workspaceId,
      filename,
      hash,
      uploadSource: "wechat-favorites",
    });
    enqueueAttachment({ attachmentId: clone.id, userId: args.userId, workspaceId: args.workspaceId, noteId: args.noteId });
    return { ...clone, deduplicated: true };
  }

  const id = uuid();
  const storagePath = `${getUploadMonthPath()}/${id}.${ext.slice(0, 8) || "bin"}`;
  await writeAttachmentObject(storagePath, buffer, mimeType);
  try {
    db.prepare(
      `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash, uploadSource)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, args.noteId, args.userId, filename, mimeType, buffer.byteLength, storagePath, args.workspaceId, hash, "wechat-favorites");
  } catch (error) {
    try { await deleteAttachmentObject(storagePath); } catch { /* best effort */ }
    throw error;
  }
  enqueueAttachment({ attachmentId: id, userId: args.userId, workspaceId: args.workspaceId, noteId: args.noteId });
  return { id, url: `/api/attachments/${id}`, filename, mimeType, size: buffer.byteLength, deduplicated: false };
}

async function removeAttachments(rows: Array<{ id: string; path: string }>): Promise<void> {
  const db = getDb();
  for (const row of rows) {
    try {
      const other = db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE path = ? AND id <> ?").get(row.path, row.id) as { count: number };
      db.prepare("DELETE FROM attachments WHERE id = ?").run(row.id);
      if (!other.count) await deleteAttachmentObject(row.path);
    } catch { /* best effort */ }
  }
}

function bindTags(args: {
  noteId: string;
  userId: string;
  workspaceId: string | null;
  tags: string[];
  warnings: string[];
}): { created: number; reused: number } {
  const db = getDb();
  let created = 0;
  let reused = 0;
  for (const raw of args.tags) {
    const name = raw.trim().slice(0, 30);
    if (!name) continue;
    let tag = db.prepare("SELECT id, workspaceId FROM tags WHERE userId = ? AND name = ? LIMIT 1").get(args.userId, name) as
      | { id: string; workspaceId: string | null }
      | undefined;
    if (tag && (tag.workspaceId || null) !== args.workspaceId) {
      args.warnings.push(`同名标签“${name}”已存在于其他空间，未绑定`);
      continue;
    }
    if (!tag) {
      const id = uuid();
      try {
        db.prepare("INSERT INTO tags (id, userId, name, color, workspaceId) VALUES (?, ?, ?, ?, ?)")
          .run(id, args.userId, name, "#07c160", args.workspaceId);
        tag = { id, workspaceId: args.workspaceId };
        created++;
      } catch {
        tag = db.prepare("SELECT id, workspaceId FROM tags WHERE userId = ? AND name = ? LIMIT 1").get(args.userId, name) as any;
      }
    } else {
      reused++;
    }
    if (tag) db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)").run(args.noteId, tag.id);
  }
  return { created, reused };
}

function saveOrigin(args: {
  userId: string;
  workspaceId: string | null;
  noteId: string;
  externalId: string;
  hash: string;
  batchId: string;
  metadata: Record<string, unknown>;
  existingId?: string;
}): void {
  const db = getDb();
  if (args.existingId) {
    db.prepare(
      `UPDATE note_import_origins SET noteId = ?, contentHash = ?, batchId = ?, updatedAt = datetime('now'), metadata = ? WHERE id = ?`,
    ).run(args.noteId, args.hash, args.batchId, JSON.stringify(args.metadata), args.existingId);
    return;
  }
  db.prepare(
    `INSERT INTO note_import_origins
      (id, userId, workspaceId, workspaceScope, noteId, sourceType, externalId, contentHash, batchId, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(), args.userId, args.workspaceId, workspaceScope(args.workspaceId), args.noteId,
    SOURCE_TYPE, args.externalId, args.hash, args.batchId, JSON.stringify(args.metadata),
  );
}

function emptyCounts(): WeChatFavoritesImportReport["counts"] {
  return {
    total: 0, selected: 0, imported: 0, updated: 0, skipped: 0, partial: 0, failed: 0,
    attachments: 0, attachmentDeduplicated: 0, mediaMissing: 0, mediaTooLarge: 0,
    tagsCreated: 0, tagsReused: 0, duplicateExisting: 0,
    wouldCreate: 0, wouldUpdate: 0, wouldSkip: 0,
  };
}

function scanStats(scan: PackageScan, mediaIndex: Map<string, ZipEntryLike[]>): WeChatFavoritesImportReport["stats"] {
  const types: Record<string, number> = {};
  const itemKinds: Record<string, number> = {};
  const tags = new Set<string>();
  const dates: string[] = [];
  let mediaReferences = 0;
  let mediaAvailable = 0;
  let mediaMissing = 0;
  let mediaBytes = 0;
  for (const favorite of scan.favorites) {
    types[favorite.type] = (types[favorite.type] || 0) + 1;
    favorite.tags.forEach((tag) => tags.add(tag));
    if (favorite.createdAt) dates.push(favorite.createdAt);
    for (const item of favorite.items) {
      itemKinds[item.kind] = (itemKinds[item.kind] || 0) + 1;
      if (item.mediaRefs.length === 0) continue;
      mediaReferences++;
      const resolved = resolveMediaEntry(item, mediaIndex);
      if (resolved.entry) {
        mediaAvailable++;
        mediaBytes += entrySize(resolved.entry);
      } else {
        mediaMissing++;
      }
    }
  }
  dates.sort();
  return {
    types, itemKinds, tags: tags.size,
    ...(dates[0] ? { dateFrom: dates[0] } : {}),
    ...(dates.length ? { dateTo: dates[dates.length - 1] } : {}),
    mediaReferences, mediaAvailable, mediaMissing, mediaBytes,
    zipEntries: scan.zipEntries,
    zipUncompressedBytes: scan.zipUncompressedBytes,
  };
}

export async function importWeChatFavoritesPackageFromZipFile(
  zipFilePath: string,
  options: WeChatFavoritesImportOptions,
): Promise<WeChatFavoritesImportReport> {
  const started = Date.now();
  const batchId = uuid();
  ensureOriginSchema();
  const scan = await scanPackage(zipFilePath);
  const mediaIndex = buildMediaIndex(scan.mediaEntries);
  const counts = emptyCounts();
  counts.total = scan.favorites.length;
  const selectedTypes = new Set((options.selectedTypes || []).filter(Boolean));
  const selected = scan.favorites.filter((favorite) => selectedTypes.size === 0 || selectedTypes.has(favorite.type));
  counts.selected = selected.length;
  const strategy = options.duplicateStrategy || "skip";
  const warnings = [...scan.warnings];
  const stats = scanStats(scan, mediaIndex);

  for (const favorite of selected) {
    const origin = lookupOrigin(options.userId, options.workspaceId, favorite.externalId);
    if (origin) counts.duplicateExisting++;
    if (!origin || strategy === "duplicate") counts.wouldCreate++;
    else if (strategy === "update") counts.wouldUpdate++;
    else counts.wouldSkip++;
  }

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      batchId,
      adapter: scan.adapter,
      counts,
      stats,
      warnings,
      items: [],
      durationMs: Date.now() - started,
    };
  }

  const rootName = safeNotebookName(options.rootNotebookName || "微信收藏");
  const rootNotebookId = ensureNotebook({
    userId: options.userId,
    workspaceId: options.workspaceId,
    parentId: null,
    name: rootName,
    icon: "💚",
  });
  const yearNotebooks = new Map<string, string>();
  const itemResults: WeChatFavoriteImportItemResult[] = [];

  for (const favorite of selected) {
    const itemWarnings: string[] = [];
    const hash = contentHash(favorite);
    const origin = lookupOrigin(options.userId, options.workspaceId, favorite.externalId);
    if (origin && strategy === "skip") {
      counts.skipped++;
      itemResults.push({ externalId: favorite.externalId, title: favorite.title, status: "skipped", noteId: origin.noteId });
      continue;
    }

    let noteId = "";
    let createdNew = false;
    let oldAttachments: Array<{ id: string; path: string }> = [];
    const createdAttachmentIds: string[] = [];
    try {
      let notebookId = rootNotebookId;
      if (options.groupByYear !== false) {
        const year = yearForFavorite(favorite);
        notebookId = yearNotebooks.get(year) || ensureNotebook({
          userId: options.userId,
          workspaceId: options.workspaceId,
          parentId: rootNotebookId,
          name: year,
          icon: "📅",
        });
        yearNotebooks.set(year, notebookId);
      }

      if (origin && strategy === "update") {
        const note = getDb().prepare(
          `SELECT id FROM notes WHERE id = ? AND userId = ? AND workspaceId ${options.workspaceId ? "= ?" : "IS NULL"} LIMIT 1`,
        ).get(...(options.workspaceId ? [origin.noteId, options.userId, options.workspaceId] : [origin.noteId, options.userId])) as { id: string } | undefined;
        if (!note) throw new Error("既有来源映射指向的笔记不存在或不属于当前空间");
        noteId = note.id;
        oldAttachments = getDb().prepare("SELECT id, path FROM attachments WHERE noteId = ?").all(noteId) as Array<{ id: string; path: string }>;
      } else {
        noteId = createPlaceholderNote({ userId: options.userId, workspaceId: options.workspaceId, notebookId, favorite });
        createdNew = true;
      }

      const media = new Map<NormalizedWeChatFavoriteItem, StoredAttachment>();
      const storedByEntry = new Map<ZipEntryLike, StoredAttachment>();
      for (const item of favorite.items) {
        if (item.mediaRefs.length === 0) continue;
        const resolved = resolveMediaEntry(item, mediaIndex);
        if (!resolved.entry) {
          counts.mediaMissing++;
          itemWarnings.push(resolved.ambiguous
            ? `媒体引用存在多个候选，未自动关联：${item.title || item.mediaRefs[0]}`
            : `媒体缺失：${item.title || item.mediaRefs[0]}`);
          if (options.continueOnMissingMedia === false) throw new Error(itemWarnings[itemWarnings.length - 1]);
          continue;
        }
        try {
          let stored = storedByEntry.get(resolved.entry);
          if (!stored) {
            stored = await storeAttachment({ entry: resolved.entry, noteId, userId: options.userId, workspaceId: options.workspaceId });
            storedByEntry.set(resolved.entry, stored);
            createdAttachmentIds.push(stored.id);
            counts.attachments++;
            if (stored.deduplicated) counts.attachmentDeduplicated++;
          }
          media.set(item, stored);
        } catch (error) {
          if (error instanceof WeChatFavoritesPackageError && error.code === "WECHAT_MEDIA_TOO_LARGE") counts.mediaTooLarge++;
          itemWarnings.push((error as Error).message || String(error));
          if (options.continueOnMissingMedia === false) throw error;
        }
      }

      const built = buildContent({ favorite, media, warnings: itemWarnings });
      const createdAt = favorite.createdAt || favorite.updatedAt;
      const updatedAt = favorite.updatedAt || createdAt;
      getDb().prepare(
        `UPDATE notes SET notebookId = ?, title = ?, content = ?, contentText = ?, contentFormat = 'tiptap-json',
          createdAt = COALESCE(?, createdAt), updatedAt = COALESCE(?, updatedAt), version = version + 1
         WHERE id = ?`,
      ).run(notebookId, favorite.title, built.content, built.contentText, createdAt || null, updatedAt || null, noteId);
      syncReferences(getDb(), noteId, built.content);

      if (options.preserveTags !== false && favorite.tags.length) {
        const tagResult = bindTags({
          noteId,
          userId: options.userId,
          workspaceId: options.workspaceId,
          tags: favorite.tags,
          warnings: itemWarnings,
        });
        counts.tagsCreated += tagResult.created;
        counts.tagsReused += tagResult.reused;
      }

      const originExternalId = strategy === "duplicate" && origin
        ? `${favorite.externalId}#duplicate:${uuid()}`
        : favorite.externalId;
      saveOrigin({
        userId: options.userId,
        workspaceId: options.workspaceId,
        noteId,
        externalId: originExternalId,
        hash,
        batchId,
        metadata: { originalExternalId: favorite.externalId, type: favorite.type, warnings: itemWarnings.length },
        existingId: origin && strategy === "update" ? origin.id : undefined,
      });

      if (origin && strategy === "update" && oldAttachments.length) {
        const newSet = new Set(createdAttachmentIds);
        await removeAttachments(oldAttachments.filter((row) => !newSet.has(row.id)));
        counts.updated++;
      } else {
        counts.imported++;
      }
      if (itemWarnings.length) counts.partial++;
      itemResults.push({
        externalId: favorite.externalId,
        title: favorite.title,
        status: itemWarnings.length ? "partial" : origin && strategy === "update" ? "updated" : "imported",
        noteId,
        ...(itemWarnings.length ? { warnings: itemWarnings } : {}),
      });
    } catch (error) {
      counts.failed++;
      if (createdNew && noteId) {
        const rows = getDb().prepare("SELECT id, path FROM attachments WHERE noteId = ?").all(noteId) as Array<{ id: string; path: string }>;
        await removeAttachments(rows);
        getDb().prepare("DELETE FROM notes WHERE id = ?").run(noteId);
      }
      itemResults.push({
        externalId: favorite.externalId,
        title: favorite.title,
        status: "failed",
        error: (error as Error)?.message || String(error),
      });
    }
  }

  const successCount = counts.imported + counts.updated + counts.partial + counts.skipped;
  console.info("[wechat-favorites-import]", {
    batchId,
    adapter: scan.adapter,
    workspaceScope: workspaceScope(options.workspaceId),
    total: counts.total,
    selected: counts.selected,
    imported: counts.imported,
    updated: counts.updated,
    skipped: counts.skipped,
    partial: counts.partial,
    failed: counts.failed,
    attachments: counts.attachments,
    durationMs: Date.now() - started,
  });
  return {
    success: successCount > 0 || counts.selected === 0,
    dryRun: false,
    batchId,
    adapter: scan.adapter,
    rootNotebookId,
    counts,
    stats,
    warnings,
    items: itemResults,
    durationMs: Date.now() - started,
  };
}
