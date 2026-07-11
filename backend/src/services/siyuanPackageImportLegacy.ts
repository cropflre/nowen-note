import crypto from "crypto";
import path from "path";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import { siyuanSyToMarkdown, type SiyuanNode } from "../lib/siyuanSyParser";
import { siyuanSyToTiptapJson } from "../lib/siyuanTiptapConverter";
import {
    deleteAttachmentObject,
    getUploadMonthPath,
    writeAttachmentObject,
} from "./attachment-storage";

const unzipper = require("unzipper");

interface ImportParams {
    userId: string;
    workspaceId: string | null;
    targetNotebookId?: string;
    contentFormat?: "tiptap-json" | "markdown";
}

export interface SiyuanPackageImportResult {
    success: boolean;
    count: number;
    notebookId: string;
    notebookIds: string[];
    notes: Array<{ id: string; title: string; notebookId: string; version: number }>;
    workspaceId: string | null;
    warnings: string[];
    stats: {
        syFiles: number;
        importedDocuments: number;
        assets: number;
        importedAssets: number;
        unresolvedAssets: number;
        unsupportedNodes: Record<string, number>;
    };
}

interface ZipEntryLike {
    path: string;
    type?: string;
    uncompressedSize?: number;
    vars?: { uncompressedSize?: number };
    buffer(): Promise<Buffer>;
}

interface SiyuanDocIndex {
    id: string;
    path: string;
    title: string;
    updatedAt?: string;
    ast: SiyuanNode;
}

interface PhysicalAsset {
    filename: string;
    mimeType: string;
    size: number;
    path: string;
    hash: string;
}

interface AttachmentRow {
    id: string;
    noteId: string;
    filename: string;
    mimeType: string;
    size: number;
    path: string;
    hash: string;
}

interface NotePlan {
    id: string;
    title: string;
    content: string;
    contentText: string;
    tags: string[];
    notebookPath: string[];
    updatedAt?: string;
    attachments: AttachmentRow[];
}

const SIYUAN_SY_EXT_RE = /\.sy$/i;
const SIYUAN_CONF_RE = /(^|\/)\.siyuan\/conf\.json$/i;
const ASSETS_SEGMENT_RE = /(^|\/)assets\//i;
const EMBEDDABLE_ASSET_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|mp4|webm|ogg|ogv|m4v|mov|mp3|wav|m4a|flac|aac|pdf|docx?|xlsx?|pptx?|zip|txt|md)([?#].*)?$/i;
const DEFAULT_MAX_ZIP_ENTRIES = 50_000;
const DEFAULT_MAX_SY_FILES = 20_000;
const DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_SY_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_ASSET_BYTES = 1024 * 1024 * 1024;

function readPositiveNumberEnv(name: string, fallback: number): number {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const SIYUAN_ZIP_BUDGETS = {
    maxEntries: readPositiveNumberEnv("SIYUAN_IMPORT_MAX_ZIP_ENTRIES", DEFAULT_MAX_ZIP_ENTRIES),
    maxSyFiles: readPositiveNumberEnv("SIYUAN_IMPORT_MAX_SY_FILES", DEFAULT_MAX_SY_FILES),
    maxTotalUncompressedBytes: readPositiveNumberEnv(
        "SIYUAN_IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES",
        DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES,
    ),
    maxSingleSyBytes: readPositiveNumberEnv("SIYUAN_IMPORT_MAX_SINGLE_SY_BYTES", DEFAULT_MAX_SINGLE_SY_BYTES),
    maxSingleAssetBytes: readPositiveNumberEnv("SIYUAN_IMPORT_MAX_SINGLE_ASSET_BYTES", DEFAULT_MAX_SINGLE_ASSET_BYTES),
};

export class SiyuanZipBudgetError extends Error {
    status = 413;
    code = "SIYUAN_ZIP_BUDGET_EXCEEDED";

    constructor(message: string) {
        super(message);
    }
}

function normalizeZipPath(value: string): string {
    return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function isSafeZipPath(value: string): boolean {
    const normalized = normalizeZipPath(value).replace(/\/+$/g, "");
    if (!normalized || normalized.includes("\0")) return false;
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
    return !normalized.split("/").some((part) => part === ".." || part === "");
}

function isIgnoredSiyuanDataEntry(value: string): boolean {
    const normalized = normalizeZipPath(value);
    return normalized.includes("__MACOSX/") || normalized.split("/").some((part) => part.startsWith(".") && part !== ".siyuan");
}

function isSyEntry(value: string): boolean {
    return SIYUAN_SY_EXT_RE.test(value);
}

function getEntryUncompressedSize(entry: ZipEntryLike): number {
    const raw = entry.vars?.uncompressedSize ?? entry.uncompressedSize;
    return Number.isFinite(raw) && raw !== undefined && raw >= 0 ? raw : 0;
}

function assertZipBudget(entries: ZipEntryLike[]): void {
    if (entries.length > SIYUAN_ZIP_BUDGETS.maxEntries) {
        throw new SiyuanZipBudgetError(`思源导入包文件数量过多，最多支持 ${SIYUAN_ZIP_BUDGETS.maxEntries} 个条目`);
    }

    let syFiles = 0;
    let totalUncompressed = 0;
    for (const entry of entries) {
        const entryPath = normalizeZipPath(entry.path);
        if (entry.type === "Directory" || isIgnoredSiyuanDataEntry(entryPath)) continue;

        const size = getEntryUncompressedSize(entry);
        totalUncompressed += size;
        if (totalUncompressed > SIYUAN_ZIP_BUDGETS.maxTotalUncompressedBytes) {
            throw new SiyuanZipBudgetError("思源导入包解压后总大小超出限制");
        }

        if (isSyEntry(entryPath)) {
            syFiles++;
            if (syFiles > SIYUAN_ZIP_BUDGETS.maxSyFiles) {
                throw new SiyuanZipBudgetError(`思源导入包 .sy 文件过多，最多支持 ${SIYUAN_ZIP_BUDGETS.maxSyFiles} 个`);
            }
            if (size > SIYUAN_ZIP_BUDGETS.maxSingleSyBytes) {
                throw new SiyuanZipBudgetError(`思源文档过大：${entryPath}`);
            }
            continue;
        }

        if (ASSETS_SEGMENT_RE.test(entryPath) && size > SIYUAN_ZIP_BUDGETS.maxSingleAssetBytes) {
            throw new SiyuanZipBudgetError(`思源资源文件过大：${entryPath}`);
        }
    }
}

function stripQueryHash(ref: string): string {
    return ref.split(/[?#]/)[0];
}

function trimAssetRef(raw: string): string {
    return raw
        .trim()
        .replace(/^<|>$/g, "")
        .replace(/^[']|[']$/g, "")
        .replace(/^[\"]|[\"]$/g, "")
        .replace(/\\/g, "/");
}

function safeDecodeUri(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        try {
            return decodeURI(value);
        } catch {
            return value;
        }
    }
}

function uniqueSorted(values: Iterable<string>): string[] {
    return Array.from(new Set(Array.from(values).map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function normalizeAssetRef(ref: string): string[] {
    const raw = trimAssetRef(ref);
    if (!raw || /^(https?:|data:|\/\/)/i.test(raw)) return [];

    const candidates = new Set<string>();
    const add = (value: string) => {
        let normalized = stripQueryHash(trimAssetRef(value))
            .replace(/^\.\//, "")
            .replace(/^\/+/, "");
        while (normalized.startsWith("../")) normalized = normalized.slice(3);
        if (!normalized) return;
        candidates.add(normalized);
        const decoded = safeDecodeUri(normalized);
        candidates.add(decoded);
        const fileName = decoded.split("/").pop();
        if (fileName) candidates.add(fileName);
        const assetsIndex = decoded.toLowerCase().lastIndexOf("/assets/");
        const assetsTail = assetsIndex >= 0
            ? decoded.slice(assetsIndex + 1)
            : decoded.toLowerCase().startsWith("assets/")
                ? decoded
                : "";
        if (assetsTail) {
            candidates.add(assetsTail);
            candidates.add(`./${assetsTail}`);
            candidates.add(`../${assetsTail}`);
        }
    };

    add(raw);
    add(safeDecodeUri(raw));

    return uniqueSorted(candidates);
}

function addAssetAliases(map: Map<string, ZipEntryLike>, entryPath: string, entry: ZipEntryLike): void {
    const normalized = normalizeZipPath(entryPath);
    const aliases = new Set<string>([normalized]);
    for (const alias of normalizeAssetRef(normalized)) aliases.add(alias);
    const fileName = normalized.split("/").pop();
    if (fileName) aliases.add(fileName);
    const assetsIndex = normalized.toLowerCase().lastIndexOf("/assets/");
    if (assetsIndex >= 0) aliases.add(normalized.slice(assetsIndex + 1));
    for (const alias of aliases) {
        if (!map.has(alias)) map.set(alias, entry);
    }
}

function getDocIdFromPath(value: string): string {
    const fileName = normalizeZipPath(value).split("/").pop() || value;
    return fileName.replace(/\.sy$/i, "");
}

function getSiyuanDocTitle(ast: SiyuanNode, fallback: string): string {
    const title = ast.Properties?.title || ast.Properties?.name || ast.Properties?.Title || ast.Properties?.Name || ast.Data;
    if (typeof title !== "string") return fallback;
    const normalized = title
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/\s+#{1,6}\s*$/, "")
        .trim();
    return normalized || fallback;
}

function getSiyuanUpdatedAt(ast: SiyuanNode): string | undefined {
    const updated = ast.Properties?.updated || ast.Properties?.Updated || ast.updated || ast.Updated;
    if (typeof updated !== "string") return undefined;
    const match = updated.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    if (!match) return undefined;
    const [, year, month, day, hour, minute, second] = match;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function getBoxIdFromConfPath(value: string): string | undefined {
    const parts = normalizeZipPath(value).split("/");
    const siyuanIndex = parts.findIndex((part) => part === ".siyuan");
    if (siyuanIndex <= 0) return undefined;
    return parts[siyuanIndex - 1];
}

function getBoxIdForDoc(value: string, boxNames: Map<string, string>): string | undefined {
    const parts = normalizeZipPath(value).split("/");
    const syFileIndex = parts.length - 1;
    const directMatch = parts.slice(0, syFileIndex).find((part) => boxNames.has(part));
    if (directMatch) return directMatch;
    if (parts.length >= 3 && /^data(?:[-_/]|\d|$)/i.test(parts[0])) return parts[1];
    return parts[0];
}

function buildSiyuanNotebookPath(value: string, docById: Map<string, SiyuanDocIndex>, boxNames: Map<string, string>): string[] {
    const parts = normalizeZipPath(value).split("/");
    const currentId = getDocIdFromPath(value);
    const boxId = getBoxIdForDoc(value, boxNames);
    const boxIndex = boxId ? parts.indexOf(boxId) : -1;
    const notebookPath: string[] = [];

    if (boxId) {
        notebookPath.push(boxNames.get(boxId) || boxId);
    }

    const parentIds = parts
        .slice(boxIndex >= 0 ? boxIndex + 1 : 0, -1)
        .filter((part) => part && part !== ".siyuan" && part !== "assets" && part !== currentId);
    for (const parentId of parentIds) {
        const parent = docById.get(parentId);
        notebookPath.push(parent?.title || parentId);
    }

    return notebookPath.filter(Boolean);
}

function getAssetMime(value: string): string {
    const lower = value.toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".bmp")) return "image/bmp";
    if (lower.endsWith(".ico")) return "image/x-icon";
    if (lower.endsWith(".avif")) return "image/avif";
    if (lower.endsWith(".mp4")) return "video/mp4";
    if (lower.endsWith(".webm")) return "video/webm";
    if (lower.endsWith(".ogg") || lower.endsWith(".ogv")) return "video/ogg";
    if (lower.endsWith(".mov")) return "video/quicktime";
    if (lower.endsWith(".m4v")) return "video/x-m4v";
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".wav")) return "audio/wav";
    if (lower.endsWith(".m4a")) return "audio/mp4";
    if (lower.endsWith(".flac")) return "audio/flac";
    if (lower.endsWith(".aac")) return "audio/aac";
    if (lower.endsWith(".pdf")) return "application/pdf";
    return "application/octet-stream";
}

function pickStorageExt(filename: string, mime: string): string {
    const ext = path.extname(filename || "").replace(/^\./, "").replace(/[^a-zA-Z0-9]/g, "");
    if (ext) return ext.slice(0, 8);
    if (mime === "image/jpeg") return "jpg";
    if (mime === "image/png") return "png";
    if (mime === "image/gif") return "gif";
    if (mime === "image/webp") return "webp";
    if (mime === "image/svg+xml") return "svg";
    if (mime === "application/pdf") return "pdf";
    return "bin";
}

function resolveAssetEntry(assetMap: Map<string, ZipEntryLike>, docPath: string, ref: string): ZipEntryLike | null {
    const candidates = new Set<string>(normalizeAssetRef(ref));
    const noteDir = normalizeZipPath(docPath).split("/").slice(0, -1).join("/");
    for (const candidate of Array.from(candidates)) {
        if (noteDir) candidates.add(`${noteDir}/${candidate}`);
    }
    for (const candidate of candidates) {
        const entry = assetMap.get(candidate);
        if (entry) return entry;
    }
    return null;
}

function resolveAssetUrl(urlMap: Map<string, string>, raw: string): string | null {
    for (const candidate of normalizeAssetRef(raw)) {
        const hit = urlMap.get(candidate);
        if (hit) return hit;
    }
    return null;
}

function rewriteAssetRefs(content: string, urlMap: Map<string, string>): string {
    if (!content || urlMap.size === 0) return content;
    let out = content.replace(/(!?\[[^\]]*]\()([^\s)]+)((?:\s+["'][^"']*["'])?\))/g, (match, prefix, raw, suffix) => {
        const url = resolveAssetUrl(urlMap, raw);
        return url ? `${prefix}${url}${suffix}` : match;
    });
    out = out.replace(/\b(src|href)=["']([^"']+)["']/gi, (match, attr, raw) => {
        const url = resolveAssetUrl(urlMap, raw);
        return url ? `${attr}="${url}"` : match;
    });
    return out;
}

function isImageMimeType(value: string): boolean {
    return value.toLowerCase().startsWith("image/");
}

function isVideoMimeType(value: string): boolean {
    return value.toLowerCase().startsWith("video/");
}

function isAudioMimeType(value: string): boolean {
    return value.toLowerCase().startsWith("audio/");
}

function appendUrlParam(url: string, key: string, value: string): string {
    if (!url) return url;
    const hashIndex = url.indexOf("#");
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const hit = new RegExp(`(?:^|[?&])${key}=`).test(base);
    if (hit) return `${base}${hash}`;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}${key}=${encodeURIComponent(value)}${hash}`;
}

function findAttachmentMime(url: string, urlMimeMap: Map<string, string>): string | undefined {
    const normalized = stripQueryHash(url.trim());
    return urlMimeMap.get(normalized) || urlMimeMap.get(url.trim());
}

function rewriteMarkdownAttachmentRender(content: string, urlMimeMap: Map<string, string>): string {
    if (!content || urlMimeMap.size === 0) return content;

    let out = content.replace(/[\u200B-\u200D\uFEFF]/g, "");

    out = out.replace(/<video\b[^>]*\bsrc=["']([^"']+)["'][^>]*>(?:<\/video>)?/gi, (match, rawSrc) => {
        const src = rawSrc.trim();
        const mime = findAttachmentMime(src, urlMimeMap);
        if (!mime || !isVideoMimeType(mime)) return match;
        return `@[video](${appendUrlParam(src, "inline", "1")})`;
    });

    out = out.replace(/<audio\b[^>]*\bsrc=["']([^"']+)["'][^>]*>(?:<\/audio>)?/gi, (match, rawSrc) => {
        const src = rawSrc.trim();
        const mime = findAttachmentMime(src, urlMimeMap);
        if (!mime || !isAudioMimeType(mime)) return match;
        return `[音频附件](${appendUrlParam(src, "download", "1")})`;
    });

    out = out.replace(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>(?:<\/iframe>)?/gi, (match, rawSrc) => {
        const src = rawSrc.trim();
        const mime = findAttachmentMime(src, urlMimeMap);
        if (!mime) return match;
        return `[嵌入内容](${src})`;
    });

    out = out.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, bang, text, rawUrl, title) => {
        const src = rawUrl.trim();
        const mime = findAttachmentMime(src, urlMimeMap);
        if (!mime) return match;

        const label = (text || title || "附件").trim() || "附件";

        if (bang === "!") {
            if (isImageMimeType(mime)) return match;
            if (isVideoMimeType(mime)) {
                const escapedTitle = (text || title || "video").replace(/"/g, "\\\"");
                return `@[video](${appendUrlParam(src, "inline", "1")} "${escapedTitle}")`;
            }
            if (isAudioMimeType(mime)) {
                return `[🔊 ${label}](${appendUrlParam(src, "download", "1")})`;
            }
            return `[📎 ${label}](${appendUrlParam(src, "download", "1")})`;
        }

        if (!isImageMimeType(mime)) {
            return `[${label}](${appendUrlParam(src, "download", "1")})`;
        }
        return match;
    });

    return out;
}

function mergeUnsupported(target: Record<string, number>, source: Record<string, number>): void {
    for (const [type, count] of Object.entries(source)) {
        target[type] = (target[type] || 0) + count;
    }
}

async function savePhysicalAsset(args: {
    entry: ZipEntryLike;
    userId: string;
    workspaceId: string | null;
    physicalCache: Map<string, PhysicalAsset>;
    importedFiles: Set<string>;
}): Promise<PhysicalAsset> {
    const entryPath = normalizeZipPath(args.entry.path);
    const cached = args.physicalCache.get(entryPath);
    if (cached) return cached;

    const buffer = await args.entry.buffer();
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const db = getDb();
    const existing = db
        .prepare(
            args.workspaceId
                ? `SELECT path, filename, mimeType, size, hash FROM attachments
            WHERE userId = ? AND workspaceId = ? AND hash = ? LIMIT 1`
                : `SELECT path, filename, mimeType, size, hash FROM attachments
            WHERE userId = ? AND workspaceId IS NULL AND hash = ? LIMIT 1`,
        )
        .get(...(args.workspaceId ? [args.userId, args.workspaceId, hash] : [args.userId, hash])) as PhysicalAsset | undefined;

    if (existing) {
        args.physicalCache.set(entryPath, existing);
        return existing;
    }

    const mimeType = getAssetMime(entryPath);
    const filename = path.basename(entryPath) || `${uuid()}.${pickStorageExt(entryPath, mimeType)}`;
    const storageId = uuid();
    const storagePath = `${getUploadMonthPath()}/${storageId}.${pickStorageExt(filename, mimeType)}`;
    await writeAttachmentObject(storagePath, buffer, mimeType);
    args.importedFiles.add(storagePath);

    const physical = {
        filename,
        mimeType,
        size: buffer.byteLength,
        path: storagePath,
        hash,
    };
    args.physicalCache.set(entryPath, physical);
    return physical;
}

async function readZipEntries(zipFilePath: string): Promise<ZipEntryLike[]> {
    const directory = await unzipper.Open.file(zipFilePath);
    return directory.files as ZipEntryLike[];
}

export async function importSiyuanPackageFromZipFile(
    zipFilePath: string,
    params: ImportParams,
): Promise<SiyuanPackageImportResult> {
    const db = getDb();
    const warnings: string[] = [];
    const importedFiles = new Set<string>();

    const entries = await readZipEntries(zipFilePath);
    for (const entry of entries) {
        if (!isSafeZipPath(entry.path)) {
            throw new Error(`Unsafe path in Siyuan package: ${entry.path}`);
        }
    }
    assertZipBudget(entries);

    const boxNames = new Map<string, string>();
    const docById = new Map<string, SiyuanDocIndex>();
    const assetMap = new Map<string, ZipEntryLike>();
    let totalAssets = 0;

    for (const entry of entries) {
        const entryPath = normalizeZipPath(entry.path);
        if (entry.type === "Directory" || isIgnoredSiyuanDataEntry(entryPath)) continue;

        if (SIYUAN_CONF_RE.test(entryPath)) {
            try {
                const parsed = JSON.parse((await entry.buffer()).toString("utf8"));
                const boxId = getBoxIdFromConfPath(entryPath);
                const boxName = parsed?.name || parsed?.boxName || parsed?.title;
                if (boxId && typeof boxName === "string" && boxName.trim()) boxNames.set(boxId, boxName.trim());
            } catch {
                warnings.push(`Failed to read Siyuan notebook config: ${entryPath}`);
            }
            continue;
        }

        if (ASSETS_SEGMENT_RE.test(entryPath)) {
            totalAssets++;
            addAssetAliases(assetMap, entryPath, entry);
            continue;
        }

        if (isSyEntry(entryPath)) {
            try {
                const ast = JSON.parse((await entry.buffer()).toString("utf8")) as SiyuanNode;
                const id = getDocIdFromPath(entryPath);
                const title = getSiyuanDocTitle(ast, id);
                const docIndex = {
                    id,
                    path: entryPath,
                    title,
                    updatedAt: getSiyuanUpdatedAt(ast),
                    ast,
                };
                docById.set(id, docIndex);
                if (ast.ID && ast.ID !== id) docById.set(ast.ID, docIndex);
            } catch {
                warnings.push(`Failed to parse Siyuan document: ${entryPath}`);
            }
        }
    }

    const docs = Array.from(new Map(Array.from(docById.values()).map((doc) => [doc.path, doc])).values())
        .sort((a, b) => a.path.localeCompare(b.path));
    if (docs.length === 0) {
        throw new Error("No importable Siyuan .sy documents found");
    }

    const physicalCache = new Map<string, PhysicalAsset>();
    const notePlans: NotePlan[] = [];
    const unsupportedNodes: Record<string, number> = {};
    const targetContentFormat: "tiptap-json" | "markdown" = params.contentFormat === "markdown" ? "markdown" : "tiptap-json";
    let importedAssets = 0;
    let unresolvedAssets = 0;

    try {
        for (const doc of docs) {
            const converted = siyuanSyToMarkdown(doc.ast);
            warnings.push(...converted.warnings);
            mergeUnsupported(unsupportedNodes, converted.stats.unsupportedNodes);

            const noteId = uuid();
            const attachmentRows: AttachmentRow[] = [];
            const urlMap = new Map<string, string>();
            const urlMimeMap = new Map<string, string>();
            const rowByEntryPath = new Map<string, AttachmentRow>();
            const refs = uniqueSorted([
                ...converted.stats.images,
                ...converted.stats.attachments.filter((ref) => EMBEDDABLE_ASSET_RE.test(ref)),
            ]);

            for (const ref of refs) {
                const entry = resolveAssetEntry(assetMap, doc.path, ref);
                if (!entry) {
                    unresolvedAssets++;
                    warnings.push(`Siyuan asset not found: ${ref}`);
                    continue;
                }

                const entryPath = normalizeZipPath(entry.path);
                let row = rowByEntryPath.get(entryPath);
                if (!row) {
                    const physical = await savePhysicalAsset({
                        entry,
                        userId: params.userId,
                        workspaceId: params.workspaceId,
                        physicalCache,
                        importedFiles,
                    });
                    row = {
                        id: uuid(),
                        noteId,
                        filename: physical.filename,
                        mimeType: physical.mimeType,
                        size: physical.size,
                        path: physical.path,
                        hash: physical.hash,
                    };
                    rowByEntryPath.set(entryPath, row);
                    attachmentRows.push(row);
                    importedAssets++;
                }

                const attachmentUrl = `/api/attachments/${row.id}`;
                urlMimeMap.set(attachmentUrl, row.mimeType || "application/octet-stream");
                for (const alias of normalizeAssetRef(ref)) urlMap.set(alias, attachmentUrl);
                for (const alias of normalizeAssetRef(entryPath)) urlMap.set(alias, attachmentUrl);
            }

            const markdown = converted.markdown || doc.title;
            const rewritten = rewriteAssetRefs(markdown, urlMap);
            const finalContent = targetContentFormat === "markdown"
                ? rewriteMarkdownAttachmentRender(rewritten, urlMimeMap)
                : siyuanSyToTiptapJson(doc.ast, { resolveAssetUrl: (raw) => resolveAssetUrl(urlMap, raw) });
            notePlans.push({
                id: noteId,
                title: converted.title || doc.title,
                content: finalContent,
                contentText: converted.plainText,
                tags: uniqueSorted(converted.stats.tags),
                notebookPath: buildSiyuanNotebookPath(doc.path, docById, boxNames),
                updatedAt: converted.updatedAt || doc.updatedAt,
                attachments: attachmentRows,
            });
        }

        const notebookIds = new Set<string>();
        const importedNotes: Array<{ id: string; title: string; notebookId: string; version: number }> = [];
        const nbCache = new Map<string, string>();

        const findChild = db.prepare(
            "SELECT id FROM notebooks WHERE userId = ? AND name = ? AND parentId IS ? AND workspaceId IS ? AND isDeleted = 0",
        );
        const insertNotebook = db.prepare(
            "INSERT INTO notebooks (id, userId, parentId, name, icon, workspaceId) VALUES (?, ?, ?, ?, ?, ?)",
        );
        const insertNote = db.prepare(`
            INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, createdAt, updatedAt, workspaceId)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertAttachment = db.prepare(`
            INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash, uploadSource)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'siyuan_import')
        `);
        const selectTagByName = db.prepare("SELECT id FROM tags WHERE userId = ? AND name = ? LIMIT 1");
        const insertTagWithWorkspace = db.prepare(
            "INSERT OR IGNORE INTO tags (id, userId, name, color, workspaceId) VALUES (?, ?, ?, ?, ?)",
        );
        const insertTagWithoutWorkspace = db.prepare(
            "INSERT OR IGNORE INTO tags (id, userId, name, color) VALUES (?, ?, ?, ?)",
        );
        const insertNoteTag = db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)");

        let tagsSupportsWorkspaceId = false;
        try {
            db.prepare("SELECT workspaceId FROM tags LIMIT 1").get();
            tagsSupportsWorkspaceId = true;
        } catch {
            tagsSupportsWorkspaceId = false;
        }

        const getOrCreateNotebookByPath = (notebookPath: string[]): string => {
            if (params.targetNotebookId) return params.targetNotebookId;
            const segs = notebookPath.map((seg) => seg.trim()).filter(Boolean);
            if (segs.length === 0) segs.push("导入的思源笔记");
            const cacheKey = segs.join("\u0001");
            const cached = nbCache.get(cacheKey);
            if (cached) return cached;

            let parentId: string | null = null;
            let currentId = "";
            for (const seg of segs) {
                const childKey = `${parentId || ""}\u0001${seg}`;
                const childCached = nbCache.get(childKey);
                if (childCached) {
                    currentId = childCached;
                    parentId = currentId;
                    continue;
                }
                const existing = findChild.get(params.userId, seg, parentId, params.workspaceId) as { id: string } | undefined;
                if (existing) {
                    currentId = existing.id;
                } else {
                    currentId = uuid();
                    insertNotebook.run(currentId, params.userId, parentId, seg, "📥", params.workspaceId);
                }
                nbCache.set(childKey, currentId);
                parentId = currentId;
            }

            nbCache.set(cacheKey, currentId);
            return currentId;
        };

        const now = new Date().toISOString();
        const tx = db.transaction(() => {
            for (const note of notePlans) {
                const notebookId = getOrCreateNotebookByPath(note.notebookPath);
                notebookIds.add(notebookId);
                const createdAt = note.updatedAt || now;
                const updatedAt = note.updatedAt || createdAt;
                insertNote.run(
                    note.id,
                    params.userId,
                    notebookId,
                    note.title,
                    note.content,
                    note.contentText,
                    targetContentFormat,
                    createdAt,
                    updatedAt,
                    params.workspaceId,
                );
                for (const attachment of note.attachments) {
                    insertAttachment.run(
                        attachment.id,
                        attachment.noteId,
                        params.userId,
                        attachment.filename,
                        attachment.mimeType,
                        attachment.size,
                        attachment.path,
                        params.workspaceId,
                        attachment.hash,
                    );
                }
                for (const tagName of note.tags) {
                    let existing = selectTagByName.get(params.userId, tagName) as { id: string } | undefined;
                    if (!existing) {
                        const newTagId = uuid();
                        if (tagsSupportsWorkspaceId) {
                            insertTagWithWorkspace.run(newTagId, params.userId, tagName, "#58a6ff", params.workspaceId);
                        } else {
                            insertTagWithoutWorkspace.run(newTagId, params.userId, tagName, "#58a6ff");
                        }
                        existing = selectTagByName.get(params.userId, tagName) as { id: string } | undefined;
                        if (!existing) {
                            existing = { id: newTagId };
                        }
                    }
                    insertNoteTag.run(note.id, existing.id);
                }
                syncAttachmentReferences(db, note.id, note.content);
                importedNotes.push({ id: note.id, title: note.title, notebookId, version: 1 });
            }
        });
        tx();

        return {
            success: true,
            count: importedNotes.length,
            notebookId: importedNotes[0]?.notebookId || params.targetNotebookId || "",
            notebookIds: Array.from(notebookIds),
            notes: importedNotes,
            workspaceId: params.workspaceId,
            warnings: uniqueSorted(warnings),
            stats: {
                syFiles: docs.length,
                importedDocuments: importedNotes.length,
                assets: totalAssets,
                importedAssets,
                unresolvedAssets,
                unsupportedNodes,
            },
        };
    } catch (err) {
        for (const filePath of importedFiles) {
            try { await deleteAttachmentObject(filePath); } catch { /* ignore cleanup */ }
        }
        throw err;
    }
}
