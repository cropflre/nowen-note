import { getDb } from "../db/schema";
import { decodeSiyuanEmoji, type SiyuanNode } from "../lib/siyuanSyParser";
import {
    importSiyuanPackageFromZipFile as importLegacySiyuanPackage,
    SiyuanZipBudgetError,
    type PreparedSiyuanDocument,
    type SiyuanImportProgress,
    type SiyuanPackageImportResult,
    type ZipEntryLike,
} from "./siyuanPackageImportLegacy";

const unzipper = require("unzipper");

interface ImportParams {
    userId: string;
    workspaceId: string | null;
    targetNotebookId?: string;
    contentFormat?: "tiptap-json" | "markdown";
    onProgress?: (progress: SiyuanImportProgress) => void;
}

interface BoxMeta {
    id: string;
    name: string;
    icon: string;
    sort: number | null;
    archiveIndex: number;
}

interface DocMeta {
    id: string;
    path: string;
    title: string;
    icon: string;
    boxId: string;
    parentDocIds: string[];
    archiveIndex: number;
    ast: SiyuanNode;
}

interface PackageMetadata {
    entries: ZipEntryLike[];
    boxes: Map<string, BoxMeta>;
    docs: DocMeta[];
    docsById: Map<string, DocMeta>;
    docSortByBox: Map<string, Map<string, number>>;
    requiresMarkdown: boolean;
    warnings: string[];
}

export { SiyuanZipBudgetError };
export type { SiyuanPackageImportResult };

const SY_RE = /\.sy$/i;
const CONF_RE = /(^|\/)\.siyuan\/conf\.json$/i;
const SORT_RE = /(^|\/)\.siyuan\/sort\.json$/i;
const CUSTOM_ICON_ENTRY_RE = /(^|\/)emojis\/.+\.(?:svg|png|jpe?g|gif|webp|bmp|ico|avif)$/i;
const CUSTOM_ICON_REF_RE = /\.(?:svg|png|jpe?g|gif|webp|bmp|ico|avif)(?:[?#].*)?$/i;
const FIDELITY_NODE_TYPES = new Set(["NodeInlineHTML", "NodeHTMLBlock"]);
const DEFAULT_MAX_ZIP_ENTRIES = 50_000;
const DEFAULT_MAX_SY_FILES = 20_000;
const DEFAULT_MAX_SINGLE_SY_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_METADATA_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_CUSTOM_ICON_BYTES = 256 * 1024;

function positiveEnv(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const METADATA_BUDGETS = {
    maxEntries: positiveEnv("SIYUAN_IMPORT_MAX_ZIP_ENTRIES", DEFAULT_MAX_ZIP_ENTRIES),
    maxSyFiles: positiveEnv("SIYUAN_IMPORT_MAX_SY_FILES", DEFAULT_MAX_SY_FILES),
    maxSingleSyBytes: positiveEnv("SIYUAN_IMPORT_MAX_SINGLE_SY_BYTES", DEFAULT_MAX_SINGLE_SY_BYTES),
    maxMetadataBytes: positiveEnv("SIYUAN_IMPORT_MAX_METADATA_BYTES", DEFAULT_MAX_METADATA_BYTES),
    maxCustomIconBytes: positiveEnv("SIYUAN_IMPORT_MAX_CUSTOM_ICON_BYTES", DEFAULT_MAX_CUSTOM_ICON_BYTES),
};

function normalizePath(value: string): string {
    return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function stripQueryHash(value: string): string {
    return value.split(/[?#]/)[0];
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

function entrySize(entry: ZipEntryLike): number {
    const raw = entry.vars?.uncompressedSize ?? entry.uncompressedSize;
    return Number.isFinite(raw) && raw !== undefined && raw >= 0 ? raw : 0;
}

function customIconTail(value: string): string {
    let normalized = safeDecodeUri(stripQueryHash(normalizePath(value).trim()))
        .replace(/^emoji:/i, "")
        .replace(/^\.\//, "");
    const markerIndex = normalized.toLowerCase().lastIndexOf("emojis/");
    if (markerIndex >= 0) normalized = normalized.slice(markerIndex + "emojis/".length);
    normalized = normalized.replace(/^\/+/, "");
    if (!normalized || normalized.includes("\0")) return "";
    const parts = normalized.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) return "";
    return parts.join("/");
}

function customIconAliases(value: string): string[] {
    const normalized = safeDecodeUri(stripQueryHash(normalizePath(value).trim())).replace(/^\.\//, "");
    const tail = customIconTail(normalized);
    if (!tail) return [];
    return Array.from(new Set([
        normalized,
        tail,
        `emojis/${tail}`,
        `data/emojis/${tail}`,
    ].map((item) => item.toLowerCase())));
}

function addCustomIconAliases(
    iconEntries: Map<string, ZipEntryLike>,
    ambiguousAliases: Set<string>,
    entryPath: string,
    entry: ZipEntryLike,
): void {
    for (const alias of customIconAliases(entryPath)) {
        if (ambiguousAliases.has(alias)) continue;
        const existing = iconEntries.get(alias);
        if (existing && existing !== entry) {
            iconEntries.delete(alias);
            ambiguousAliases.add(alias);
            continue;
        }
        iconEntries.set(alias, entry);
    }
}

function resolveCustomIconEntry(
    raw: string,
    iconEntries: Map<string, ZipEntryLike>,
    ambiguousAliases: Set<string>,
): ZipEntryLike | null {
    for (const alias of customIconAliases(raw)) {
        if (ambiguousAliases.has(alias)) continue;
        const entry = iconEntries.get(alias);
        if (entry) return entry;
    }
    return null;
}

function customIconMime(value: string): string {
    const lower = stripQueryHash(value).toLowerCase();
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".bmp")) return "image/bmp";
    if (lower.endsWith(".ico")) return "image/x-icon";
    if (lower.endsWith(".avif")) return "image/avif";
    return "";
}

function sanitizeSvgIcon(buffer: Buffer): Buffer | null {
    let svg = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
    if (!/<svg\b/i.test(svg)) return null;

    svg = svg
        .replace(/<\?xml[\s\S]*?\?>/gi, "")
        .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
        .replace(/<!ENTITY[\s\S]*?>/gi, "")
        .replace(/<(?:script|foreignObject|iframe|object|embed|link|meta|style)\b[\s\S]*?<\/(?:script|foreignObject|iframe|object|embed|link|meta|style)\s*>/gi, "")
        .replace(/<(?:script|foreignObject|iframe|object|embed|link|meta|style)\b[^>]*\/?\s*>/gi, "")
        .replace(/\s+on[a-z0-9:_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
        .replace(/\s+(?:href|xlink:href|src)\s*=\s*(["'])(.*?)\1/gi, (match, _quote, target) => (
            String(target).trim().startsWith("#") ? match : ""
        ))
        .replace(/\s+style\s*=\s*(["'])(.*?)\1/gi, (match, _quote, style) => (
            /(?:url\s*\(|@import|expression\s*\()/i.test(String(style)) ? "" : match
        ))
        .replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match, _quote, target) => (
            String(target).trim().startsWith("#") ? match : "none"
        ));

    if (!/<svg\b/i.test(svg)) return null;
    return Buffer.from(svg, "utf8");
}

async function resolveSiyuanIcon(args: {
    value: unknown;
    iconEntries: Map<string, ZipEntryLike>;
    ambiguousAliases: Set<string>;
    iconCache: Map<string, string>;
    warnings: Set<string>;
}): Promise<string> {
    const unicode = decodeSiyuanEmoji(args.value);
    if (unicode) return unicode;
    if (typeof args.value !== "string") return "";

    const raw = args.value.trim();
    if (!raw || !CUSTOM_ICON_REF_RE.test(raw)) return "";
    const entry = resolveCustomIconEntry(raw, args.iconEntries, args.ambiguousAliases);
    if (!entry) {
        args.warnings.add(`思源自定义图标资源未找到：${raw}`);
        return "";
    }

    const entryPath = normalizePath(entry.path);
    if (args.iconCache.has(entryPath)) return args.iconCache.get(entryPath) || "";
    if (entrySize(entry) > METADATA_BUDGETS.maxCustomIconBytes) {
        args.warnings.add(`思源自定义图标过大，已跳过：${entryPath}`);
        args.iconCache.set(entryPath, "");
        return "";
    }

    const mime = customIconMime(entryPath);
    if (!mime) return "";
    let buffer = await entry.buffer();
    if (buffer.byteLength > METADATA_BUDGETS.maxCustomIconBytes) {
        args.warnings.add(`思源自定义图标过大，已跳过：${entryPath}`);
        args.iconCache.set(entryPath, "");
        return "";
    }
    if (mime === "image/svg+xml") {
        const sanitized = sanitizeSvgIcon(buffer);
        if (!sanitized) {
            args.warnings.add(`思源自定义 SVG 图标格式无效，已跳过：${entryPath}`);
            args.iconCache.set(entryPath, "");
            return "";
        }
        buffer = sanitized;
    }

    const icon = `data:${mime};base64,${buffer.toString("base64")}`;
    args.iconCache.set(entryPath, icon);
    return icon;
}

function docIdFromPath(value: string): string {
    return normalizePath(value).split("/").pop()?.replace(/\.sy$/i, "") || "";
}

function boxIdFromMetaPath(value: string): string {
    const parts = normalizePath(value).split("/");
    const index = parts.findIndex((part) => part === ".siyuan");
    return index > 0 ? parts[index - 1] : "";
}

function numberOrNull(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function normalizeTitle(ast: SiyuanNode, fallback: string): string {
    const raw = ast.Properties?.title || ast.Properties?.name || ast.Properties?.Title || ast.Properties?.Name || ast.Data;
    if (typeof raw !== "string") return fallback;
    return raw
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/\s+#{1,6}\s*$/, "")
        .trim() || fallback;
}

function containsFidelityNode(node: SiyuanNode): boolean {
    if (node.Type === "NodeHTMLBlock") {
        const raw = String(node.Data || node.Properties?.Data || "");
        if (/<(?:iframe|script|mark)\b/i.test(raw)) return true;
    } else if (node.Type === "NodeInlineHTML") {
        return true;
    }
    return (node.Children || []).some(containsFidelityNode);
}

function resolveBoxId(docPath: string, boxIds: Iterable<string>): string {
    const parts = normalizePath(docPath).split("/");
    const known = new Set(boxIds);
    const direct = parts.slice(0, -1).find((part) => known.has(part));
    if (direct) return direct;
    if (parts[0]?.toLowerCase() === "data" && parts[1]) return parts[1];
    return parts[0] || "imported-siyuan";
}

function parentDocIds(docPath: string, boxId: string): string[] {
    const parts = normalizePath(docPath).split("/");
    const boxIndex = parts.indexOf(boxId);
    return parts
        .slice(boxIndex >= 0 ? boxIndex + 1 : 0, -1)
        .filter((part) => part && part !== ".siyuan" && part !== "assets");
}

async function readSmallJson(entry: ZipEntryLike): Promise<any> {
    if (entrySize(entry) > METADATA_BUDGETS.maxMetadataBytes) {
        throw new SiyuanZipBudgetError(`思源元数据文件过大：${normalizePath(entry.path)}`);
    }
    return JSON.parse((await entry.buffer()).toString("utf8").replace(/^\uFEFF/, ""));
}

async function readPackageMetadata(
    zipFilePath: string,
    onProgress?: (progress: SiyuanImportProgress) => void,
): Promise<PackageMetadata> {
    const directory = await unzipper.Open.file(zipFilePath);
    const entries = directory.files as ZipEntryLike[];
    if (entries.length > METADATA_BUDGETS.maxEntries) {
        throw new SiyuanZipBudgetError(`思源导入包文件数量过多，最多支持 ${METADATA_BUDGETS.maxEntries} 个条目`);
    }

    const boxes = new Map<string, BoxMeta>();
    const rawDocs: Array<{ path: string; ast: SiyuanNode; archiveIndex: number }> = [];
    const docSortByBox = new Map<string, Map<string, number>>();
    const iconEntries = new Map<string, ZipEntryLike>();
    const ambiguousIconAliases = new Set<string>();
    const iconCache = new Map<string, string>();
    const warnings = new Set<string>();
    let syFiles = 0;
    let requiresMarkdown = false;

    onProgress?.({
        phase: "scanning",
        message: `正在扫描思源数据包，共 ${entries.length} 个条目`,
        current: 0,
        total: entries.length,
    });

    for (const [archiveIndex, entry] of entries.entries()) {
        if (archiveIndex > 0 && archiveIndex % 100 === 0) {
            onProgress?.({
                phase: "scanning",
                message: `正在扫描数据包条目 ${archiveIndex} / ${entries.length}`,
                current: archiveIndex,
                total: entries.length,
            });
        }
        if (entry.type === "Directory") continue;
        const entryPath = normalizePath(entry.path);

        if (CUSTOM_ICON_ENTRY_RE.test(entryPath)) {
            addCustomIconAliases(iconEntries, ambiguousIconAliases, entryPath, entry);
            continue;
        }

        if (CONF_RE.test(entryPath)) {
            try {
                const parsed = await readSmallJson(entry);
                const boxId = boxIdFromMetaPath(entryPath);
                if (boxId) {
                    boxes.set(boxId, {
                        id: boxId,
                        name: String(parsed?.name || parsed?.boxName || parsed?.title || boxId).trim() || boxId,
                        icon: typeof parsed?.icon === "string" ? parsed.icon.trim() : "",
                        sort: numberOrNull(parsed?.sort),
                        archiveIndex,
                    });
                }
            } catch (error) {
                if (error instanceof SiyuanZipBudgetError) throw error;
            }
            continue;
        }

        if (SORT_RE.test(entryPath)) {
            try {
                const parsed = await readSmallJson(entry);
                const boxId = boxIdFromMetaPath(entryPath);
                if (boxId && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    const map = new Map<string, number>();
                    for (const [docId, value] of Object.entries(parsed as Record<string, unknown>)) {
                        const order = numberOrNull(value);
                        if (order !== null) map.set(docId, order);
                    }
                    docSortByBox.set(boxId, map);
                }
            } catch (error) {
                if (error instanceof SiyuanZipBudgetError) throw error;
            }
            continue;
        }

        if (!SY_RE.test(entryPath)) continue;
        syFiles += 1;
        if (syFiles > METADATA_BUDGETS.maxSyFiles) {
            throw new SiyuanZipBudgetError(`思源导入包 .sy 文件过多，最多支持 ${METADATA_BUDGETS.maxSyFiles} 个`);
        }
        if (entrySize(entry) > METADATA_BUDGETS.maxSingleSyBytes) {
            throw new SiyuanZipBudgetError(`思源文档过大：${entryPath}`);
        }
        try {
            const ast = JSON.parse((await entry.buffer()).toString("utf8").replace(/^\uFEFF/, "")) as SiyuanNode;
            rawDocs.push({ path: entryPath, ast, archiveIndex });
            if (containsFidelityNode(ast)) requiresMarkdown = true;
        } catch {
            warnings.add(`Failed to parse Siyuan document: ${entryPath}`);
        }
    }

    for (const box of boxes.values()) {
        box.icon = await resolveSiyuanIcon({
            value: box.icon,
            iconEntries,
            ambiguousAliases: ambiguousIconAliases,
            iconCache,
            warnings,
        });
    }

    // Mirror the legacy importer's id-alias and path de-duplication exactly. This keeps
    // result.notes[index] paired with the same source document even for malformed exports
    // containing duplicate IDs or an AST root ID that differs from its filename.
    const aliasedDocs = new Map<string, DocMeta>();
    for (const { path, ast, archiveIndex } of rawDocs) {
        const id = docIdFromPath(path);
        const boxId = resolveBoxId(path, boxes.keys());
        const meta: DocMeta = {
            id,
            path,
            title: normalizeTitle(ast, id),
            icon: await resolveSiyuanIcon({
                value: ast.Properties?.icon,
                iconEntries,
                ambiguousAliases: ambiguousIconAliases,
                iconCache,
                warnings,
            }),
            boxId,
            parentDocIds: parentDocIds(path, boxId),
            archiveIndex,
            ast,
        };
        aliasedDocs.set(id, meta);
        if (ast.ID && ast.ID !== id) aliasedDocs.set(ast.ID, meta);
    }
    const docs = Array.from(new Map(Array.from(aliasedDocs.values()).map((doc) => [doc.path, doc])).values())
        .sort((a, b) => a.path.localeCompare(b.path));
    const docsById = new Map<string, DocMeta>();
    for (const doc of docs) {
        docsById.set(doc.id, doc);
        if (doc.ast.ID && doc.ast.ID !== doc.id) docsById.set(doc.ast.ID, doc);
    }

    return { entries, boxes, docs, docsById, docSortByBox, requiresMarkdown, warnings: [...warnings] };
}

function buildDocRanks(metadata: PackageMetadata): Map<string, number> {
    const groups = new Map<string, DocMeta[]>();
    for (const doc of metadata.docs) {
        const key = `${doc.boxId}\u0001${doc.parentDocIds.join("/")}`;
        const group = groups.get(key) || [];
        group.push(doc);
        groups.set(key, group);
    }

    const ranks = new Map<string, number>();
    for (const group of groups.values()) {
        const sorted = [...group].sort((a, b) => {
            const aOrder = metadata.docSortByBox.get(a.boxId)?.get(a.id);
            const bOrder = metadata.docSortByBox.get(b.boxId)?.get(b.id);
            if (aOrder !== undefined || bOrder !== undefined) {
                if (aOrder === undefined) return 1;
                if (bOrder === undefined) return -1;
                if (aOrder !== bOrder) return aOrder - bOrder;
            }
            return a.archiveIndex - b.archiveIndex || a.path.localeCompare(b.path);
        });
        sorted.forEach((doc, index) => ranks.set(doc.id, index * 1024));
    }
    return ranks;
}

function buildBoxRanks(metadata: PackageMetadata): Map<string, number> {
    const boxes = [...metadata.boxes.values()].sort((a, b) => {
        if (a.sort !== null || b.sort !== null) {
            if (a.sort === null) return 1;
            if (b.sort === null) return -1;
            if (a.sort !== b.sort) return a.sort - b.sort;
        }
        return a.archiveIndex - b.archiveIndex || a.name.localeCompare(b.name);
    });
    return new Map(boxes.map((box, index) => [box.id, index * 1024]));
}

function listScopeNotebookIds(userId: string, workspaceId: string | null): Set<string> {
    const rows = workspaceId
        ? getDb().prepare("SELECT id FROM notebooks WHERE userId = ? AND workspaceId = ?").all(userId, workspaceId)
        : getDb().prepare("SELECT id FROM notebooks WHERE userId = ? AND workspaceId IS NULL").all(userId);
    return new Set((rows as Array<{ id: string }>).map((row) => row.id));
}

function ensureNoteIconsTable(): void {
    getDb().exec(`
        CREATE TABLE IF NOT EXISTS note_icons (
            noteId TEXT PRIMARY KEY,
            icon TEXT NOT NULL,
            updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
        );
    `);
}

function applyImportedMetadata(
    metadata: PackageMetadata,
    result: SiyuanPackageImportResult,
    params: ImportParams,
    existingNotebookIds: Set<string>,
): string[] {
    const warnings: string[] = [];
    const db = getDb();
    const docRanks = buildDocRanks(metadata);
    const boxRanks = buildBoxRanks(metadata);
    const currentNotebookIds = listScopeNotebookIds(params.userId, params.workspaceId);
    const newNotebookIds = new Set([...currentNotebookIds].filter((id) => !existingNotebookIds.has(id)));

    if (metadata.docs.length !== result.notes.length) {
        warnings.push(`思源排序元数据仅匹配到 ${Math.min(metadata.docs.length, result.notes.length)} / ${result.notes.length} 篇笔记`);
    }

    ensureNoteIconsTable();
    const updateNoteOrder = db.prepare("UPDATE notes SET sortOrder = ? WHERE id = ?");
    const upsertNoteIcon = db.prepare(`
        INSERT INTO note_icons (noteId, icon, updatedAt)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(noteId) DO UPDATE SET icon = excluded.icon, updatedAt = datetime('now')
    `);
    const findChild = db.prepare(
        "SELECT id FROM notebooks WHERE userId = ? AND name = ? AND parentId IS ? AND workspaceId IS ? AND isDeleted = 0",
    );
    const updateNotebookOrder = db.prepare("UPDATE notebooks SET sortOrder = ? WHERE id = ?");
    const updateNotebookIcon = db.prepare("UPDATE notebooks SET icon = ? WHERE id = ?");
    const touchedNotebooks = new Set<string>();

    const applyNotebookPath = (doc: DocMeta) => {
        if (params.targetNotebookId) return;
        const box = metadata.boxes.get(doc.boxId) || {
            id: doc.boxId,
            name: doc.boxId,
            icon: "",
            sort: null,
            archiveIndex: doc.archiveIndex,
        };
        const segments: Array<{ name: string; icon: string; order: number }> = [{
            name: box.name,
            icon: box.icon,
            order: boxRanks.get(box.id) ?? 0,
        }];
        for (const parentId of doc.parentDocIds) {
            const parent = metadata.docsById.get(parentId);
            segments.push({
                name: parent?.title || parentId,
                icon: parent?.icon || "",
                order: parent ? (docRanks.get(parent.id) ?? 0) : 0,
            });
        }

        let parentId: string | null = null;
        for (const segment of segments) {
            const row = findChild.get(params.userId, segment.name, parentId, params.workspaceId) as { id: string } | undefined;
            if (!row) break;
            if (newNotebookIds.has(row.id) && !touchedNotebooks.has(row.id)) {
                updateNotebookOrder.run(segment.order, row.id);
                if (segment.icon) updateNotebookIcon.run(segment.icon, row.id);
                touchedNotebooks.add(row.id);
            }
            parentId = row.id;
        }
    };

    db.transaction(() => {
        const count = Math.min(metadata.docs.length, result.notes.length);
        for (let index = 0; index < count; index += 1) {
            const doc = metadata.docs[index];
            const imported = result.notes[index];
            updateNoteOrder.run(docRanks.get(doc.id) ?? index * 1024, imported.id);
            if (doc.icon) upsertNoteIcon.run(imported.id, doc.icon);
            applyNotebookPath(doc);
        }
    })();

    return warnings;
}

/**
 * Enhanced SiYuan package import.
 *
 * The original streaming importer remains the data plane. This wrapper reads bounded
 * metadata before import and restores information it previously discarded: notebook /
 * document order, notebook / document emoji icons and raw HTML / iframe fidelity.
 */
export async function importSiyuanPackageFromZipFile(
    zipFilePath: string,
    params: ImportParams,
): Promise<SiyuanPackageImportResult> {
    const metadata = await readPackageMetadata(zipFilePath, params.onProgress);
    const existingNotebookIds = listScopeNotebookIds(params.userId, params.workspaceId);
    const forceMarkdown = metadata.requiresMarkdown && params.contentFormat !== "markdown";
    const result = await importLegacySiyuanPackage(zipFilePath, {
        ...params,
        contentFormat: forceMarkdown ? "markdown" : params.contentFormat,
        preparedPackage: {
            entries: metadata.entries,
            documents: metadata.docs.map<PreparedSiyuanDocument>((doc) => ({
                id: doc.id,
                path: doc.path,
                title: doc.title,
                ast: doc.ast,
            })),
            boxNames: new Map(Array.from(metadata.boxes, ([id, box]) => [id, box.name])),
        },
    });

    const warnings = new Set([...(result.warnings || []), ...metadata.warnings]);
    for (const warning of applyImportedMetadata(metadata, result, params, existingNotebookIds)) warnings.add(warning);
    if (forceMarkdown) {
        warnings.add("检测到 HTML 或 iframe 内容，已自动使用 Markdown 模式以保留原始结构并安全预览。");
    }
    return { ...result, warnings: [...warnings].sort((a, b) => a.localeCompare(b)) };
}
