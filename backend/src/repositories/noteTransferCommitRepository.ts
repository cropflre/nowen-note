import { createHash } from "node:crypto";

import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbStatement,
} from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";
import type { NoteBlockIndexRow } from "../lib/noteBlocks";
import {
  NoteTransferOperationError,
  type PreparedNoteTransferOperation,
} from "./noteTransferOperationRepository";
import type { NoteLinkEntry } from "./types";

export type NoteTransferCommitSourceNote = {
  id: string;
  userId: string;
  workspaceId: string | null;
  notebookId: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  isPinned: boolean;
  sortOrder: number;
  version: number;
};

export type NoteTransferCommitSourceTag = {
  sourceNoteId: string;
  sourceTagId: string;
  name: string;
  color: string;
};

export type NoteTransferCommitTargetNote = {
  sourceNoteId: string;
  targetNoteId: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  isPinned: boolean;
  sortOrder: number;
  blocks: NoteBlockIndexRow[];
  links: Array<NoteLinkEntry & { id: string }>;
};

export type NoteTransferCommitTargetTag = {
  sourceNoteId: string;
  sourceTagId: string;
  targetNoteId: string;
  targetTagId: string;
  name: string;
  color: string;
};

export type NoteTransferCommitResult = {
  operationId: string;
  mode: "copy";
  sourceNoteCount: number;
  targetWorkspaceId: string | null;
  targetNotebookId: string;
  targetNoteIds: Record<string, string>;
  attachmentCount: number;
  tagCount: number;
  noteLinkCount: number;
  blockCount: number;
  warnings: string[];
};

export type NoteTransferCommitResponse = {
  operation: PreparedNoteTransferOperation;
  result: NoteTransferCommitResult;
  reused: boolean;
};

type SourceNoteRow = Omit<
  NoteTransferCommitSourceNote,
  "isPinned" | "sortOrder" | "version"
> & {
  isPinned: boolean | number | string;
  sortOrder: number | string | null;
  version: number | string;
};

type SourceTagRow = {
  sourceNoteId: string;
  sourceTagId: string;
  name: string;
  color: string | null;
};

type CompletionRow = {
  status: string;
  result: NoteTransferCommitResult | string | null;
};

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function toBoolean(value: boolean | number | string): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

function toNumber(value: number | string | null): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function parseJson<T>(value: T | string | null, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function targetGuard(input: {
  actorUserId: string;
  targetNotebookId: string;
  targetWorkspaceId: string | null;
}): DbStatement {
  return {
    sql: `SELECT notebook.id
            FROM notebooks notebook
            LEFT JOIN workspaces workspace
              ON workspace.id = notebook.workspaceId
            LEFT JOIN workspace_members workspace_member
              ON workspace_member.workspaceId = notebook.workspaceId
             AND workspace_member.userId = ?
            LEFT JOIN notebook_members notebook_member
              ON notebook_member.notebookId = notebook.id
             AND notebook_member.userId = ?
             AND notebook_member.status = 'active'
           WHERE notebook.id = ?
             AND notebook.isDeleted = false
             AND COALESCE(notebook.workspaceId, '') = COALESCE(?, '')
             AND (
               notebook.userId = ?
               OR CASE
                 WHEN notebook_member.role IS NOT NULL THEN
                   notebook_member.role IN ('owner', 'admin', 'manage', 'editor', 'write')
                 WHEN notebook.workspaceId IS NULL THEN false
                 WHEN workspace.ownerId = ? THEN true
                 ELSE workspace_member.role IN ('owner', 'admin', 'editor')
               END
             )
           FOR UPDATE OF notebook`,
    params: [
      input.actorUserId,
      input.actorUserId,
      input.targetNotebookId,
      input.targetWorkspaceId,
      input.actorUserId,
      input.actorUserId,
    ],
    requireChanges: 1,
  };
}

function sourceSnapshotGuard(input: {
  actorUserId: string;
  sourceWorkspaceId: string | null;
  note: NoteTransferCommitSourceNote;
}): DbStatement {
  return {
    sql: `SELECT note.id
            FROM notes note
            LEFT JOIN workspaces workspace
              ON workspace.id = note.workspaceId
            LEFT JOIN workspace_members workspace_member
              ON workspace_member.workspaceId = note.workspaceId
             AND workspace_member.userId = ?
            LEFT JOIN notebook_members notebook_member
              ON notebook_member.notebookId = note.notebookId
             AND notebook_member.userId = ?
             AND notebook_member.status = 'active'
            LEFT JOIN note_acl note_permission
              ON note_permission.noteId = note.id
             AND note_permission.userId = ?
           WHERE note.id = ?
             AND note.version = ?
             AND note.isTrashed = false
             AND COALESCE(note.workspaceId, '') = COALESCE(?, '')
             AND note.notebookId = ?
             AND note.title = ?
             AND COALESCE(note.content, '') = ?
             AND COALESCE(note.contentText, '') = ?
             AND COALESCE(note.contentFormat, 'tiptap-json') = ?
             AND note.isPinned = ?
             AND COALESCE(note.sortOrder, 0) = ?
             AND (
               note.userId = ?
               OR CASE
                 WHEN notebook_member.role IS NOT NULL THEN
                   notebook_member.role IN ('owner', 'admin', 'manage')
                 WHEN note.workspaceId IS NULL THEN false
                 WHEN note_permission.permission IS NOT NULL THEN
                   note_permission.permission = 'manage'
                 WHEN workspace.ownerId = ? THEN true
                 ELSE workspace_member.role IN ('owner', 'admin')
               END
             )
           FOR UPDATE OF note`,
    params: [
      input.actorUserId,
      input.actorUserId,
      input.actorUserId,
      input.note.id,
      input.note.version,
      input.sourceWorkspaceId,
      input.note.notebookId,
      input.note.title,
      input.note.content,
      input.note.contentText,
      input.note.contentFormat,
      input.note.isPinned,
      input.note.sortOrder,
      input.actorUserId,
      input.actorUserId,
    ],
    requireChanges: 1,
  };
}

function tagScopePredicate(targetWorkspaceId: string | null): string {
  return targetWorkspaceId === null
    ? `tag.userId = ? AND tag.workspaceId IS NULL`
    : `tag.workspaceId = ?`;
}

function tagScopeValue(actorUserId: string, targetWorkspaceId: string | null): string {
  return targetWorkspaceId === null ? actorUserId : targetWorkspaceId;
}

export function deterministicTransferUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

export function createNoteTransferCommitRepository(adapter?: DatabaseAdapter) {
  const db = resolveAdapter(adapter);

  async function loadCompleted(
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<NoteTransferCommitResult | null> {
    const row = await db.queryOne<CompletionRow>(
      `SELECT status, result
         FROM note_transfer_operations
        WHERE userId = ? AND idempotencyKey = ?`,
      [actorUserId, idempotencyKey],
    );
    if (row?.status !== "completed") return null;
    return parseJson<NoteTransferCommitResult | null>(row.result, null);
  }

  return {
    async loadSourceSnapshot(
      operation: PreparedNoteTransferOperation,
    ): Promise<{
      notes: NoteTransferCommitSourceNote[];
      tags: NoteTransferCommitSourceTag[];
    }> {
      const ids = operation.plan.sourceNoteIds;
      if (ids.length === 0) return { notes: [], tags: [] };

      const noteRows = await db.queryMany<SourceNoteRow>(
        `SELECT id, userId, workspaceId, notebookId, title,
                COALESCE(content, '') AS content,
                COALESCE(contentText, '') AS contentText,
                COALESCE(contentFormat, 'tiptap-json') AS contentFormat,
                isPinned, sortOrder, version
           FROM notes
          WHERE id IN (${placeholders(ids.length)})`,
        ids,
      );
      const byId = new Map(noteRows.map((row) => [row.id, row]));
      const notes = ids.map((id) => {
        const row = byId.get(id);
        if (!row) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_PLAN_STALE",
            "源笔记不存在，请重新预检",
            409,
            { sourceNoteId: id },
          );
        }
        return {
          id: row.id,
          userId: row.userId,
          workspaceId: row.workspaceId,
          notebookId: row.notebookId,
          title: row.title,
          content: row.content,
          contentText: row.contentText,
          contentFormat: row.contentFormat,
          isPinned: toBoolean(row.isPinned),
          sortOrder: toNumber(row.sortOrder),
          version: toNumber(row.version),
        };
      });

      const tagRows = operation.includeTags
        ? await db.queryMany<SourceTagRow>(
          `SELECT note_tag.noteId AS sourceNoteId,
                  tag.id AS sourceTagId,
                  tag.name,
                  tag.color
             FROM note_tags note_tag
             JOIN tags tag ON tag.id = note_tag.tagId
            WHERE note_tag.noteId IN (${placeholders(ids.length)})
            ORDER BY note_tag.noteId, lower(trim(tag.name)), tag.id`,
          ids,
        )
        : [];

      return {
        notes,
        tags: tagRows.map((row) => ({
          sourceNoteId: row.sourceNoteId,
          sourceTagId: row.sourceTagId,
          name: row.name.trim(),
          color: row.color || "#58a6ff",
        })),
      };
    },

    async loadCompleted(input: {
      actorUserId: string;
      idempotencyKey: string;
    }): Promise<NoteTransferCommitResult | null> {
      return loadCompleted(input.actorUserId, input.idempotencyKey);
    },

    async commitCopy(input: {
      actorUserId: string;
      idempotencyKey: string;
      operation: PreparedNoteTransferOperation;
      sourceNotes: NoteTransferCommitSourceNote[];
      targetNotes: NoteTransferCommitTargetNote[];
      targetTags: NoteTransferCommitTargetTag[];
      result: NoteTransferCommitResult;
    }): Promise<{ result: NoteTransferCommitResult; reused: boolean }> {
      const completed = await loadCompleted(input.actorUserId, input.idempotencyKey);
      if (completed) return { result: completed, reused: true };

      const operation = input.operation;
      if (operation.mode !== "copy") {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_MOVE_COMMIT_PENDING",
          "移动模式将在复制提交与源删除恢复边界完成后开放",
          409,
          { operationId: operation.id },
        );
      }
      if (operation.status !== "staging") {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_STATE_CONFLICT",
          `当前状态 ${operation.status} 无法提交目标笔记`,
          409,
          { operationId: operation.id, status: operation.status },
        );
      }
      if (input.sourceNotes.length !== operation.sourceNoteCount
        || input.targetNotes.length !== operation.sourceNoteCount) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_PLAN_STALE",
          "提交快照中的笔记数量与计划不一致",
          409,
          { operationId: operation.id },
        );
      }

      const statements: DbStatement[] = [
        targetGuard({
          actorUserId: input.actorUserId,
          targetNotebookId: operation.targetNotebookId,
          targetWorkspaceId: operation.targetWorkspaceId,
        }),
        ...input.sourceNotes.map((note) => sourceSnapshotGuard({
          actorUserId: input.actorUserId,
          sourceWorkspaceId: operation.sourceWorkspaceId,
          note,
        })),
      ];

      if (operation.includeAttachments) {
        statements.push({
          sql: `SELECT 1
                  WHERE (
                    SELECT COUNT(*)
                      FROM note_transfer_staged_attachments
                     WHERE operationId = ?
                  ) = ?
                    AND NOT EXISTS (
                      SELECT 1
                        FROM note_transfer_staged_attachments manifest
                       WHERE manifest.operationId = ?
                         AND (
                           manifest.status <> 'staged'
                           OR manifest.verifiedSize IS NULL
                           OR manifest.verifiedSize <> manifest.size
                           OR manifest.verifiedHash IS NULL
                         )
                    )
                    AND NOT EXISTS (
                      SELECT 1
                        FROM note_transfer_staged_attachments manifest
                        LEFT JOIN attachments source
                          ON source.id = manifest.sourceAttachmentId
                         AND source.noteId = manifest.sourceNoteId
                       WHERE manifest.operationId = ?
                         AND (
                           source.id IS NULL
                           OR source.path <> manifest.sourcePath
                           OR source.filename <> manifest.filename
                           OR COALESCE(source.mimeType, 'application/octet-stream') <> manifest.mimeType
                           OR source.size <> manifest.size
                           OR COALESCE(source.hash, '') <> COALESCE(manifest.hash, '')
                         )
                    )`,
          params: [
            operation.id,
            operation.plan.attachmentCount,
            operation.id,
            operation.id,
          ],
          requireChanges: 1,
        });
      }

      if (operation.includeTags) {
        statements.push({
          sql: `SELECT 1
                  WHERE (
                    SELECT COUNT(*)
                      FROM note_tags note_tag
                     WHERE note_tag.noteId IN (${placeholders(operation.plan.sourceNoteIds.length)})
                  ) = ?`,
          params: [...operation.plan.sourceNoteIds, input.targetTags.length],
          requireChanges: 1,
        });
        for (const relation of input.targetTags) {
          statements.push({
            sql: `SELECT 1
                    FROM note_tags note_tag
                    JOIN tags tag ON tag.id = note_tag.tagId
                   WHERE note_tag.noteId = ?
                     AND tag.id = ?
                     AND trim(tag.name) = ?
                     AND COALESCE(tag.color, '#58a6ff') = ?`,
            params: [
              relation.sourceNoteId,
              relation.sourceTagId,
              relation.name,
              relation.color,
            ],
            requireChanges: 1,
          });
        }
      }

      statements.push({
        sql: `UPDATE note_transfer_operations
                 SET status = 'committing', errorCode = NULL, errorMessage = NULL,
                     updatedAt = CURRENT_TIMESTAMP
               WHERE id = ? AND userId = ? AND idempotencyKey = ?
                 AND status = 'staging'`,
        params: [operation.id, input.actorUserId, input.idempotencyKey],
        requireChanges: 1,
      });

      for (const note of input.targetNotes) {
        statements.push({
          sql: `INSERT INTO notes (
                  id, userId, workspaceId, notebookId, title,
                  content, contentText, contentFormat,
                  isPinned, isFavorite, isLocked, isArchived, isTrashed,
                  version, sortOrder, createdAt, updatedAt
                ) VALUES (
                  ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  false, false, false, false,
                  1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )`,
          params: [
            note.targetNoteId,
            input.actorUserId,
            operation.targetWorkspaceId,
            operation.targetNotebookId,
            note.title,
            note.content,
            note.contentText,
            note.contentFormat,
            note.isPinned,
            note.sortOrder,
          ],
          requireChanges: 1,
        });
      }

      const uniqueTags = new Map<string, NoteTransferCommitTargetTag>();
      for (const relation of input.targetTags) {
        const key = relation.name.trim().toLowerCase();
        if (!uniqueTags.has(key)) uniqueTags.set(key, relation);
      }
      const scopeValue = tagScopeValue(input.actorUserId, operation.targetWorkspaceId);
      for (const tag of uniqueTags.values()) {
        statements.push({
          sql: `INSERT INTO tags (id, userId, workspaceId, name, color, createdAt)
                SELECT ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
                 WHERE NOT EXISTS (
                   SELECT 1
                     FROM tags tag
                    WHERE ${tagScopePredicate(operation.targetWorkspaceId)}
                      AND lower(trim(tag.name)) = lower(trim(?))
                 )
                ON CONFLICT DO NOTHING`,
          params: [
            tag.targetTagId,
            input.actorUserId,
            operation.targetWorkspaceId,
            tag.name,
            tag.color,
            scopeValue,
            tag.name,
          ],
        });
      }
      for (const relation of input.targetTags) {
        statements.push({
          sql: `INSERT INTO note_tags (noteId, tagId)
                SELECT ?, tag.id
                  FROM tags tag
                 WHERE ${tagScopePredicate(operation.targetWorkspaceId)}
                   AND lower(trim(tag.name)) = lower(trim(?))
                ON CONFLICT DO NOTHING`,
          params: [
            relation.targetNoteId,
            scopeValue,
            relation.name,
          ],
          requireChanges: 1,
        });
      }

      for (const attachment of operation.stagedAttachments) {
        statements.push({
          sql: `INSERT INTO attachments (
                  id, noteId, userId, workspaceId, filename, mimeType,
                  size, path, hash, uploadSource, folderId, createdAt
                )
                SELECT targetAttachmentId, targetNoteId, ?, ?, filename, mimeType,
                       verifiedSize, stagedPath, verifiedHash, 'note-transfer', NULL,
                       CURRENT_TIMESTAMP
                  FROM note_transfer_staged_attachments
                 WHERE operationId = ? AND sourceAttachmentId = ?
                   AND status = 'staged'
                   AND verifiedSize = size AND verifiedHash IS NOT NULL`,
          params: [
            input.actorUserId,
            operation.targetWorkspaceId,
            operation.id,
            attachment.sourceAttachmentId,
          ],
          requireChanges: 1,
        });
        statements.push({
          sql: `INSERT INTO attachment_references (attachmentId, noteId, createdAt)
                VALUES (?, ?, CURRENT_TIMESTAMP)`,
          params: [attachment.targetAttachmentId, attachment.targetNoteId],
          requireChanges: 1,
        });
      }

      for (const note of input.targetNotes) {
        for (const block of note.blocks) {
          statements.push({
            sql: `INSERT INTO note_blocks_index (
                    noteId, blockId, blockType, parentBlockId, blockOrder,
                    plainText, contentHash, path, startOffset, endOffset,
                    createdAt, updatedAt
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            params: [
              note.targetNoteId,
              block.blockId,
              block.blockType,
              block.parentBlockId,
              block.blockOrder,
              block.plainText,
              block.contentHash,
              block.path,
              block.startOffset,
              block.endOffset,
            ],
            requireChanges: 1,
          });
        }
        for (const link of note.links) {
          statements.push({
            sql: `INSERT INTO note_links (
                    id, userId, sourceNoteId, targetNoteId,
                    targetBlockId, sourceBlockId, linkType,
                    linkText, excerpt, createdAt, updatedAt
                  )
                  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                   WHERE EXISTS (SELECT 1 FROM notes WHERE id = ?)
                  ON CONFLICT DO NOTHING`,
            params: [
              link.id,
              input.actorUserId,
              note.targetNoteId,
              link.targetNoteId,
              link.targetBlockId,
              link.sourceBlockId,
              link.linkType,
              link.linkText,
              link.excerpt,
              link.targetNoteId,
            ],
          });
        }
      }

      statements.push({
        sql: `UPDATE note_transfer_operation_items
                 SET status = 'committed', updatedAt = CURRENT_TIMESTAMP
               WHERE operationId = ? AND status IN ('planned', 'staged')`,
        params: [operation.id],
        requireChanges: operation.sourceNoteCount,
      });
      if (operation.plan.attachmentCount > 0) {
        statements.push({
          sql: `UPDATE note_transfer_staged_attachments
                   SET status = 'committed', cleanupStatus = 'retained',
                       cleanupLeaseToken = NULL, cleanupLeaseExpiresAt = NULL,
                       cleanupLastError = NULL, updatedAt = CURRENT_TIMESTAMP
                 WHERE operationId = ? AND status = 'staged'`,
          params: [operation.id],
          requireChanges: operation.plan.attachmentCount,
        });
      }
      statements.push({
        sql: `UPDATE note_transfer_operations
                 SET status = 'completed', result = CAST(? AS JSONB),
                     errorCode = NULL, errorMessage = NULL,
                     updatedAt = CURRENT_TIMESTAMP
               WHERE id = ? AND userId = ? AND idempotencyKey = ?
                 AND status = 'committing'`,
        params: [
          JSON.stringify(input.result),
          operation.id,
          input.actorUserId,
          input.idempotencyKey,
        ],
        requireChanges: 1,
      });

      try {
        await db.executeStatements(statements);
      } catch (error) {
        const raced = await loadCompleted(input.actorUserId, input.idempotencyKey).catch(() => null);
        if (raced) return { result: raced, reused: true };
        if (error instanceof DbStatementChangeError) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_COMMIT_STALE",
            "源笔记、标签、附件或目标权限已变化，请重新预检",
            409,
            { operationId: operation.id },
          );
        }
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code || "")
          : "";
        if (code === "23505") {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_TARGET_CONFLICT",
            "目标资源 ID 或唯一约束发生冲突，未写入任何目标数据",
            409,
            { operationId: operation.id },
          );
        }
        throw error;
      }

      return { result: input.result, reused: false };
    },
  };
}
