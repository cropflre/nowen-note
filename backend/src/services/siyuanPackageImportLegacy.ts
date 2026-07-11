import { getDb } from "../db/schema";
import {
    importSiyuanPackageFromZipFile as importSiyuanPackageCore,
    SiyuanZipBudgetError,
    type SiyuanPackageImportResult,
} from "./siyuanPackageImportLegacyCore";

interface ImportParams {
    userId: string;
    workspaceId: string | null;
    targetNotebookId?: string;
    contentFormat?: "tiptap-json" | "markdown";
}

interface ImportedTagLinkRow {
    noteId: string;
    tagId: string;
    tagName: string;
    noteWorkspaceId: string | null;
    tagWorkspaceId?: string | null;
}

const NOTE_BATCH_SIZE = 400;
const MAX_TAG_NAME_LENGTH = 30;

export { SiyuanZipBudgetError };
export type { SiyuanPackageImportResult };

function uniqueSorted(values: Iterable<string>): string[] {
    return Array.from(new Set(Array.from(values).map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
    );
}

function chunks<T>(values: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
        out.push(values.slice(index, index + size));
    }
    return out;
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
    const rows = getDb()
        .prepare("SELECT id FROM tags WHERE userId = ?")
        .all(userId) as Array<{ id: string }>;
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
        const query = `
            SELECT nt.noteId AS noteId, t.id AS tagId, t.name AS tagName${workspaceSelection}
            FROM note_tags nt
            JOIN notes n ON n.id = nt.noteId
            JOIN tags t ON t.id = nt.tagId
            WHERE nt.noteId IN (${placeholders})
        `;
        rows.push(...(db.prepare(query).all(...batch) as ImportedTagLinkRow[]));
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
        for (const row of rejected) {
            deleteLink.run(row.noteId, row.tagId);
        }
        for (const tagId of new Set(rejected.map((row) => row.tagId))) {
            if (!preExistingTagIds.has(tagId)) {
                deleteOrphanTag.run(tagId, tagId);
            }
        }
    })();

    return uniqueSorted(rejected.map((row) => {
        const name = String(row.tagName || "").trim() || "(empty)";
        if (row.reason === "workspace-conflict") {
            return `Siyuan tag skipped because the same account tag belongs to another space: ${name}`;
        }
        return `Siyuan tag skipped because the name is empty or exceeds ${MAX_TAG_NAME_LENGTH} characters: ${name}`;
    }));
}

/**
 * Run the legacy package importer, then enforce the same tag invariants as the
 * public tags API before the result is returned to callers:
 *
 * - note and tag must belong to the same workspace;
 * - tag names must be non-empty and at most 30 characters;
 * - newly-created invalid tags are removed when they have no remaining links;
 * - pre-existing account tags are never deleted by import cleanup.
 *
 * The core import remains transaction-oriented for notes and attachments, while
 * this synchronous audit prevents imported data from retaining relationships
 * that normal Nowen API calls are not allowed to create.
 */
export async function importSiyuanPackageFromZipFile(
    zipFilePath: string,
    params: ImportParams,
): Promise<SiyuanPackageImportResult> {
    const preExistingTagIds = listExistingTagIds(params.userId);
    const result = await importSiyuanPackageCore(zipFilePath, params);
    const cleanupWarnings = cleanImportedTagLinks(
        result.notes.map((note) => note.id),
        preExistingTagIds,
    );
    return {
        ...result,
        warnings: uniqueSorted([...result.warnings, ...cleanupWarnings]),
    };
}
