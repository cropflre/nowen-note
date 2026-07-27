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
import {
  createNoteDeletionEffectsRuntime,
  type NoteDeletionCommittedEvent,
} from "./note-deletion-effects-runtime";
import { createNoteCoreRuntime, NoteCoreRuntimeError } from "./note-core-runtime";

interface NoteDeletionRow {
  userId: string;
  workspaceId: string | null;
  isLocked: boolean | number;
}

interface WorkspaceOwnerRow {
  ownerId: string;
}

interface WorkspaceRoleRow {
  role: string;
}

interface TrashTargetRow {
  id: string;
  noteBytes: number | string | null;
}

interface TrashAttachmentRow extends AttachmentDeletionCandidate {
  size: number | string | null;
}

interface CountRow {
  count: number | string | null;
}

interface TrashScope {
  workspaceId: string | null;
  value: string;
  ownerUserId: string;
}

export interface NoteDeletionResult {
  success: true;
  noteId: string;
  attachmentCount: number;
  removedFiles: number;
  skippedSharedPaths: number;
  cleanupWarnings: string[];
  sideEffectWarnings: string[];
}

export interface TrashEmptyResult {
  success: true;
  count: number;
  skipped: number;
  noteIds: string[];
  attachmentCount: number;
  removedFiles: number;
  skippedSharedPaths: number;
  cleanupWarnings: string[];
  sideEffectWarnings: string[];
  walTruncated: false;
  incrementalVacuumed: false;
  vacuumed: false;
  freedBytesEstimate: number;
}

export interface NoteDeletionRuntimeOptions {
  cleanupAttachments?: (
    adapter: DatabaseAdapter,
    candidates: AttachmentDeletionCandidate[],
  ) => Promise<AttachmentDeletionCleanupResult>;
  destroyYDoc?: (noteId: string) => void;
  dispatchEffects?: (event: NoteDeletionCommittedEvent) => Promise<string[]>;
}

function booleanNumber(value: boolean | number | null | undefined): number {
  return value === true || value === 1 ? 1 : 0;
}

function numericValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function workspaceRoleCanManage(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin" || role === "manage";
}

function trashScopeWhere(scope: TrashScope, alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return scope.workspaceId
    ? `${prefix}"workspaceId" = ?`
    : `${prefix}"userId" = ? AND ${prefix}"workspaceId" IS NULL`;
}

export function createNoteDeletionRuntime(
  adapter?: DatabaseAdapter,
  options: NoteDeletionRuntimeOptions = {},
) {
  const db = adapter ?? getDatabaseAdapter();
  const core = createNoteCoreRuntime(db);
  const cleanupAttachments = options.cleanupAttachments ?? cleanupDeletedNoteAttachments;
  const fallbackEffects = options.dispatchEffects ? null : createNoteDeletionEffectsRuntime(db);
  const dispatchEffects = options.dispatchEffects ?? fallbackEffects!.dispatch;
  // PostgreSQL runtime-only 尚未开放 Yjs room 路由，因此默认不存在需要销毁的
  // 内存房间；note_yupdates / note_ysnapshots 由外键级联清理。这里保留注入点，
  // 待 Yjs Runtime 迁移时由上层注入纯内存 room cleanup，避免静态导入
  // services/yjs.ts 触发 SQLite Repository 与 migrations 启动副作用。
  const destroyYDoc = options.destroyYDoc ?? (() => {});

  async function resolveTrashScope(
    userId: string,
    requestedWorkspaceId?: string,
  ): Promise<TrashScope> {
    const workspaceId = requestedWorkspaceId?.trim();
    if (!workspaceId || workspaceId === "personal") {
      return { workspaceId: null, value: userId, ownerUserId: userId };
    }

    const workspace = await db.queryOne<WorkspaceOwnerRow>(
      `SELECT "ownerId" AS "ownerId" FROM workspaces WHERE id = ?`,
      [workspaceId],
    );
    if (!workspace) {
      throw new NoteCoreRuntimeError(
        "仅工作区管理员可清空回收站",
        "FORBIDDEN",
        403,
      );
    }
    if (workspace.ownerId !== userId) {
      const member = await db.queryOne<WorkspaceRoleRow>(
        `SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?`,
        [workspaceId, userId],
      );
      if (!workspaceRoleCanManage(member?.role)) {
        throw new NoteCoreRuntimeError(
          "仅工作区管理员可清空回收站",
          "FORBIDDEN",
          403,
        );
      }
    }
    return { workspaceId, value: workspaceId, ownerUserId: workspace.ownerId };
  }

  async function cleanupAfterCommit(
    noteIds: string[],
    attachments: AttachmentDeletionCandidate[],
  ): Promise<{
    removedFiles: number;
    skippedSharedPaths: number;
    cleanupWarnings: string[];
  }> {
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

    for (const noteId of noteIds) {
      try {
        destroyYDoc(noteId);
      } catch (error) {
        cleanupWarnings.push(
          `Yjs room cleanup failed for ${noteId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { removedFiles, skippedSharedPaths, cleanupWarnings };
  }

  async function runEffects(event: NoteDeletionCommittedEvent): Promise<string[]> {
    try {
      return await dispatchEffects(event);
    } catch (error) {
      return [
        `deletion side effects failed: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
  }

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

    const cleanup = await cleanupAfterCommit([noteId], attachments);
    const sideEffectWarnings = await runEffects({
      kind: "note.deleted",
      actorUserId: userId,
      noteOwnerUserId: note.userId,
      workspaceId: note.workspaceId,
      noteId,
      attachmentCount: attachments.length,
      removedFiles: cleanup.removedFiles,
      skippedSharedPaths: cleanup.skippedSharedPaths,
      cleanupWarnings: cleanup.cleanupWarnings,
    });
    return {
      success: true,
      noteId,
      attachmentCount: attachments.length,
      ...cleanup,
      sideEffectWarnings,
    };
  }

  async function emptyTrash(
    userId: string,
    requestedWorkspaceId?: string,
  ): Promise<TrashEmptyResult> {
    const scope = await resolveTrashScope(userId, requestedWorkspaceId);
    const targetWhere = trashScopeWhere(scope);
    const targets = await db.queryMany<TrashTargetRow>(
      `SELECT id,
              COALESCE(LENGTH(title), 0)
                + COALESCE(LENGTH(content), 0)
                + COALESCE(LENGTH("contentText"), 0) AS "noteBytes"
         FROM notes
        WHERE ${targetWhere} AND "isTrashed" = 1 AND "isLocked" = 0
        ORDER BY id`,
      [scope.value],
    );
    const skippedRow = await db.queryOne<CountRow>(
      `SELECT COUNT(*) AS count
         FROM notes
        WHERE ${targetWhere} AND "isTrashed" = 1 AND "isLocked" = 1`,
      [scope.value],
    );
    const skipped = numericValue(skippedRow?.count);

    if (targets.length === 0) {
      return {
        success: true,
        count: 0,
        skipped,
        noteIds: [],
        attachmentCount: 0,
        removedFiles: 0,
        skippedSharedPaths: 0,
        cleanupWarnings: [],
        sideEffectWarnings: [],
        walTruncated: false,
        incrementalVacuumed: false,
        vacuumed: false,
        freedBytesEstimate: 0,
      };
    }

    const attachments = await db.queryMany<TrashAttachmentRow>(
      `SELECT a.id, a.path, a.size
         FROM attachments a
         JOIN notes n ON n.id = a."noteId"
        WHERE ${trashScopeWhere(scope, "n")}
          AND n."isTrashed" = 1
          AND n."isLocked" = 0`,
      [scope.value],
    );
    const noteIds = targets.map((target) => target.id);
    const freedBytesEstimate = targets.reduce(
      (total, target) => total + numericValue(target.noteBytes),
      0,
    ) + attachments.reduce(
      (total, attachment) => total + numericValue(attachment.size),
      0,
    );

    const statements: DbStatement[] = [{
      sql: `DELETE FROM notes
             WHERE ${targetWhere} AND "isTrashed" = 1 AND "isLocked" = 0`,
      params: [scope.value],
      requireChanges: targets.length,
    }];
    if (scope.workspaceId) {
      statements.push({
        sql: `DELETE FROM tags
               WHERE "workspaceId" = ?
                 AND NOT EXISTS (
                   SELECT 1
                     FROM note_tags nt
                     JOIN notes n ON n.id = nt."noteId"
                    WHERE nt."tagId" = tags.id
                      AND n."workspaceId" = ?
                      AND n."isTrashed" = 0
                 )`,
        params: [scope.workspaceId, scope.workspaceId],
      });
    } else {
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
        params: [scope.ownerUserId, scope.ownerUserId],
      });
    }

    try {
      await db.executeStatements(statements);
    } catch (error) {
      if (error instanceof DbStatementChangeError) {
        throw new NoteCoreRuntimeError(
          "回收站内容已变化，请重试",
          "TRASH_EMPTY_CONFLICT",
          409,
          {
            expectedCount: targets.length,
            actualCount: error.actualChanges,
          },
        );
      }
      throw error;
    }

    const cleanup = await cleanupAfterCommit(noteIds, attachments);
    const sideEffectWarnings = await runEffects({
      kind: "note.trash_emptied",
      actorUserId: userId,
      ownerUserId: scope.ownerUserId,
      workspaceId: scope.workspaceId,
      noteIds,
      skipped,
      attachmentCount: attachments.length,
      removedFiles: cleanup.removedFiles,
      skippedSharedPaths: cleanup.skippedSharedPaths,
      cleanupWarnings: cleanup.cleanupWarnings,
      freedBytesEstimate,
    });
    return {
      success: true,
      count: noteIds.length,
      skipped,
      noteIds,
      attachmentCount: attachments.length,
      ...cleanup,
      sideEffectWarnings,
      // PostgreSQL 不使用 SQLite WAL checkpoint / incremental_vacuum / VACUUM。
      // 保留旧响应字段供前端兼容，空间回收由 PostgreSQL autovacuum 及后续运维策略负责。
      walTruncated: false,
      incrementalVacuumed: false,
      vacuumed: false,
      freedBytesEstimate,
    };
  }

  return { permanentDeleteNote, emptyTrash };
}

export default createNoteDeletionRuntime;
