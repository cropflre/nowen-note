import { getDb } from "../db/schema";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import { enhanceSiyuanImportedTiptap } from "../lib/siyuanIssue284Tiptap";
import {
    importSiyuanPackageFromZipFile as importSiyuanPackageCore,
    SiyuanZipBudgetError,
    type PreparedSiyuanPackage,
    type SiyuanImportProgress,
    type SiyuanPackageImportResult,
} from "./siyuanPackageImportLegacyCore";
import { localizeSiyuanImportedMarkdownImages } from "./siyuanImportedRemoteImages";

interface ImportParams {
    userId: string;
    workspaceId: string | null;
    targetNotebookId?: string;
    contentFormat?: "tiptap-json" | "markdown";
    preparedPackage?: PreparedSiyuanPackage;
    onProgress?: (progress: SiyuanImportProgress) => void;
}

interface ImportedTagLinkRow {
    noteId: string;
    tagId: string;
    tagName: string;
    noteWorkspaceId: string | null;
    tagWorkspaceId?: string | null;
}

interface ImportedRichTextRow {
    id: string;
    content: string;
    contentText: string;
}

const NOTE_BATCH_SIZE = 400;
const MAX_TAG_NAME_LENGTH = 30;
const REMOTE_ASSET_MISSING_WARNING_RE = /^Siyuan asset not found:\s*(?:https?:|\/\/|data:)/i;

export { SiyuanZipBudgetError };
export type {
    PreparedSiyuanDocument,
    PreparedSiyuanPackage,
    SiyuanImportProgress,
    SiyuanPackageImportResult,
    ZipEntryLike,
} from "./siyuanPackageImportLegacyCore";

function uniqueSorted(values: Iterable<string>): string[] {
    return Array.from(new Set(Array.from(values).map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
    );
}

function chunks<T>(values: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
    return out;
}

function readImportedNoteVersions(noteIds: string[]): Map<string, number> {
    const versions = new Map<string, number>();
    if (noteIds.length === 0) return versions;
    const db = getDb();
    for (const batch of chunks(noteIds, NOTE_BATCH_SIZE)) {
        const placeholders = batch.map(() => "?").join(", ");
        const rows = db.prepare(`
            SELECT id, version
            FROM notes
            WHERE id IN (${placeholders})
        `).all(...batch) as Array<{ id: string; version: number }>;
        for (const row of rows) versions.set(row.id, Number(row.version) || 1);
    }
    return versions;
}

function tagsSupportWorkspaceId(): boolean {
    const db = getDb();
    try {
        db.prepare("SELECT workspaceId FROM tags LIMIT 1").get();
        return true;
    } catch {
        return false;
    }
}

function listExistingTagIds(userId: string): Set<string> {
    const rows = getDb().prepare("SELECT id FROM tags WHERE userId = ?").all(userId) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
}

function readImportedTagLinks(noteIds: string[], withWorkspaceId: boolean): ImportedTagLinkRow[] {
    if (noteIds.length === 0) return [];
    const db = getDb();
    const rows: ImportedTagLinkRow[] = [];
    for (const batch of chunks(noteIds, NOTE_BATCH_SIZE)) {
        const placeholders = batch.map(() => "?").join(", ");
        const workspaceSelection = withWorkspaceId
            ? ", n.workspaceId AS noteWorkspaceId, t.workspaceId AS tagWorkspaceId"
            : ", NULL AS noteWorkspaceId";
        rows.push(...(db.prepare(`
            SELECT nt.noteId AS noteId, t.id AS tagId, t.name AS tagName${workspaceSelection}
            FROM note_tags nt
            JOIN notes n ON n.id = nt.noteId
            JOIN tags t ON t.id = nt.tagId
            WHERE nt.noteId IN (${placeholders})
        `).all(...batch) as ImportedTagLinkRow[]));
    }
    return rows;
}

function cleanImportedTagLinks(noteIds: string[], preExistingTagIds: Set<string>): string[] {
    if (noteIds.length === 0) return [];
    const db = getDb();
    const withWorkspaceId = tagsSupportWorkspaceId();
    const rows = readImportedTagLinks(noteIds, withWorkspaceId);
    const rejected: Array<ImportedTagLinkRow & { reason: "invalid-name" | "workspace-conflict" }> = [];

    for (const row of rows) {
        const normalizedName = String(row.tagName || "").trim();
        if (!normalizedName || normalizedName.length > MAX_TAG_NAME_LENGTH) {
            rejected.push({ ...row, reason: "invalid-name" });
            continue;
        }
        if (withWorkspaceId && (row.noteWorkspaceId || null) !== (row.tagWorkspaceId || null)) {
            rejected.push({ ...row, reason: "workspace-conflict" });
        }
    }
    if (rejected.length === 0) return [];

    const deleteLink = db.prepare("DELETE FROM note_tags WHERE noteId = ? AND tagId = ?");
    const deleteOrphanTag = db.prepare(`
        DELETE FROM tags
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM note_tags WHERE tagId = ?)
    `);
    db.transaction(() => {
        for (const row of rejected) deleteLink.run(row.noteId, row.tagId);
        for (const tagId of new Set(rejected.map((row) => row.tagId))) {
            if (!preExistingTagIds.has(tagId)) deleteOrphanTag.run(tagId, tagId);
        }
    })();

    return uniqueSorted(rejected.map((row) => {
        const name = String(row.tagName || "").trim() || "(empty)";
        return row.reason === "workspace-conflict"
            ? `Siyuan tag skipped because the same account tag belongs to another space: ${name}`
            : `Siyuan tag skipped because the name is empty or exceeds ${MAX_TAG_NAME_LENGTH} characters: ${name}`;
    }));
}

function enhanceImportedRichText(noteIds: string[]): string[] {
    if (noteIds.length === 0) return [];
    const db = getDb();
    const rows: ImportedRichTextRow[] = [];
    for (const batch of chunks(noteIds, NOTE_BATCH_SIZE)) {
        const placeholders = batch.map(() => "?").join(", ");
        rows.push(...(db.prepare(`
            SELECT id, content, COALESCE(contentText, '') AS contentText
            FROM notes
            WHERE id IN (${placeholders}) AND contentFormat = 'tiptap-json'
        `).all(...batch) as ImportedRichTextRow[]));
    }
    if (rows.length === 0) return [];

    const totals = {
        callouts: 0,
        embedLinks: 0,
        audioLinks: 0,
        widgetLinks: 0,
        removedIal: 0,
        repairedInvalidDocument: 0,
    };
    const update = db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?");
    db.transaction(() => {
        for (const row of rows) {
            const enhanced = enhanceSiyuanImportedTiptap(row.content, row.contentText);
            update.run(enhanced.content, enhanced.contentText, row.id);
            syncAttachmentReferences(db, row.id, enhanced.content);
            totals.callouts += enhanced.stats.callouts;
            totals.embedLinks += enhanced.stats.embedLinks;
            totals.audioLinks += enhanced.stats.audioLinks;
            totals.widgetLinks += enhanced.stats.widgetLinks;
            totals.removedIal += enhanced.stats.removedIal;
            if (enhanced.repairedInvalidDocument) totals.repairedInvalidDocument += 1;
        }
    })();

    const warnings: string[] = [];
    if (totals.callouts > 0) warnings.push(`思源富文本：${totals.callouts} 个 Callout 已映射为带类型标题的安全引用块。`);
    if (totals.embedLinks > 0) warnings.push(`思源富文本：${totals.embedLinks} 个无法安全内嵌的 iframe 已保留为可识别链接卡片。`);
    if (totals.audioLinks > 0) warnings.push(`思源富文本：${totals.audioLinks} 个音频已保留为明确的附件链接。`);
    if (totals.widgetLinks > 0) warnings.push(`思源富文本：${totals.widgetLinks} 个挂件已保留为可识别链接卡片。`);
    if (totals.removedIal > 0) warnings.push(`思源富文本：已隐藏 ${totals.removedIal} 条仅用于源格式的 IAL 属性行。`);
    if (totals.repairedInvalidDocument > 0) {
        warnings.push(`思源富文本：${totals.repairedInvalidDocument} 篇异常文档已降级为可编辑纯文本，避免空白或编辑器崩溃。`);
    }
    return warnings;
}

/**
 * Run the transaction-oriented importer, then apply the invariants shared by the
 * public tags API and the editor schema. Advanced SiYuan nodes remain within the
 * supported Tiptap schema and every intentional downgrade is returned to the UI.
 */
export async function importSiyuanPackageFromZipFile(
    zipFilePath: string,
    params: ImportParams,
): Promise<SiyuanPackageImportResult> {
    const preExistingTagIds = listExistingTagIds(params.userId);
    const result = await importSiyuanPackageCore(zipFilePath, params);
    params.onProgress?.({
        phase: "finalizing",
        message: "正在完成富文本、图片和标签后处理",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const noteIds = result.notes.map((note) => note.id);
    const cleanupWarnings = cleanImportedTagLinks(noteIds, preExistingTagIds);
    let richTextWarnings: string[] = [];
    try {
        richTextWarnings = enhanceImportedRichText(noteIds);
    } catch (error) {
        console.error("[siyuan-import] rich-text post-processing failed", error);
        richTextWarnings = ["思源富文本后处理失败，已保留基础转换结果；请查看服务端日志并重新导入。"];
    }

    let remoteImageWarnings: string[] = [];
    try {
        const localized = await localizeSiyuanImportedMarkdownImages({
            userId: params.userId,
            notes: result.notes,
        });
        remoteImageWarnings = localized.warnings;
    } catch (error) {
        console.error("[siyuan-import] Markdown remote image localization failed", error);
        remoteImageWarnings = ["思源 Markdown 网络图片本地化失败，已保留原图床地址；请查看服务端日志后重试。"];
    }

    const currentVersions = readImportedNoteVersions(noteIds);
    const coreWarnings = result.warnings.filter((warning) => !REMOTE_ASSET_MISSING_WARNING_RE.test(warning));

    return {
        ...result,
        notes: result.notes.map((note) => ({
            ...note,
            version: currentVersions.get(note.id) ?? note.version,
        })),
        warnings: uniqueSorted([
            ...coreWarnings,
            ...cleanupWarnings,
            ...richTextWarnings,
            ...remoteImageWarnings,
        ]),
    };
}
