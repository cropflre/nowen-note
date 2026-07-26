import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbStatement,
} from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";
import {
  cleanupDeletedNoteAttachments,
  type AttachmentDeletionCandidate,
  type AttachmentDeletionCleanupResult,
} from "./attachment-deletion-runtime";
import { createNoteCoreRuntime, NoteCoreRuntimeError } from "./note-core-runtime";
import { yDestroyDoc } from "./yjs";

interface NoteDeletionRow {
  userId: string;
  workspaceId: string | null;
  isLocked: boolean | number;
}

export interface NoteDeletionResult {
  success: true;
  noteId: string;
  attachmentCount: number;
  removedFiles: number;
  skippedSharedPaths: number;
  cleanupWarnings: string[];
}

export interface NoteDeletionRuntimeOptions {
  cleanupAttachments?: (
    adapter: DatabaseAdapter,
    candidates: AttachmentDeletionCandidate[],
  ) => Promise<AttachmentDeletionCleanupResult>;
  destroyYDoc?: (noteId: string) => void;
}

function booleanNumber(value: boolean | number | null | undefined): number {
  return value === true || value === 1 ? 1 : 0;
}

export function createNoteDeletionRuntime(
  adapter?: DatabaseAdapter,
  options: NoteDeletionRuntimeOptions = {},
) {
  const db = adapter ?? getDatabaseAdapter();
  const core = createNoteCoreRuntime(db);
  const cleanupAttachments = options.cleanupAttachments ?? cleanupDeletedNoteAttachments;
  const destroyYDoc = options.destroyYDoc ?? yDestroyDoc;

  async function permanentDeleteNote(
    userId: string,
    noteId: string,
  ): Promise<NoteDeletionResult> {
    const resolved = await core.resolveNotePermissionAsync(noteId, userId);
    if (!resolved.scope) {
      throw new NoteCoreRuntimeError("Note not found", "NOT_FOUND", 404);
    }
    if (resolved.permission !== "manage") {
      throw new NoteCoreRuntimeError(
        "仅笔记 owner 或工作区管理员可永久删除",
        "FORBIDDEN",
        403,
      );
    }

    const note = await db.queryOne<NoteDeletionRow>(
      `SELECT "userId" AS "userId", "workspaceId" AS "workspaceId",
              "isLocked" AS "isLocked"
         FROM notes WHERE id = ?`,
      [noteId],
    );
    if (!note) throw new NoteCoreRuntimeError("Note not found", "NOT_FOUND", 404);
    if (booleanNumber(note.isLocked) === 1) {
      throw new NoteCoreRuntimeError("Note is locked", "NOTE_LOCKED", 403);
    }

    const attachments = await db.queryMany<AttachmentDeletionCandidate>(
      `SELECT id, path FROM attachments WHERE "noteId" = ?`,
      [noteId],
    );

    const statements: DbStatement[] = [{
      sql: `DELETE FROM notes WHERE id = ? AND "isLocked" = 0`,
      params: [noteId],
      requireChanges: 1,
    }];
    if (!note.workspaceId) {
      statements.push({
        sql: `DELETE FROM tags
               WHERE "userId" = ?
                 AND "workspaceId" IS NULL
                 AND NOT EXISTS (
                   SELECT 1
                     FROM note_tags nt
                     JOIN notes n ON n.id = nt."noteId"
                    WHERE nt."tagId" = tags.id
                      AND n."userId" = ?
                      AND n."isTrashed" = 0
                 )`,
        params: [note.userId, note.userId],
      });
    }

    try {
      await db.executeStatements(statements);
    } catch (error) {
      if (error instanceof DbStatementChangeError) {
        const latest = await db.queryOne<{ isLocked: boolean | number }>(
          `SELECT "isLocked" AS "isLocked" FROM notes WHERE id = ?`,
          [noteId],
        );
        if (!latest) throw new NoteCoreRuntimeError("Note not found", "NOT_FOUND", 404);
        if (booleanNumber(latest.isLocked) === 1) {
          throw new NoteCoreRuntimeError("Note is locked", "NOTE_LOCKED", 403);
        }
        throw new NoteCoreRuntimeError(
          "Note deletion conflict",
          "DELETE_CONFLICT",
          409,
        );
      }
      throw error;
    }

    const cleanupWarnings: string[] = [];
    let removedFiles = 0;
    let skippedSharedPaths = 0;
    try {
      const cleanup = await cleanupAttachments(db, attachments);
      removedFiles = cleanup.removedFiles;
      skippedSharedPaths = cleanup.skippedSharedPaths;
      cleanupWarnings.push(...cleanup.warnings);
    } catch (error) {
      cleanupWarnings.push(
        `attachment cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      destroyYDoc(noteId);
    } catch (error) {
      cleanupWarnings.push(
        `Yjs room cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      success: true,
      noteId,
      attachmentCount: attachments.length,
      removedFiles,
      skippedSharedPaths,
      cleanupWarnings,
    };
  }

  return { permanentDeleteNote };
}

export default createNoteDeletionRuntime;
