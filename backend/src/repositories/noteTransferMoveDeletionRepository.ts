import { randomUUID } from "node:crypto";

import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbStatement,
} from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";
import type { AttachmentDeletionCandidate } from "../services/attachment-deletion-runtime";
import { NoteTransferOperationError } from "./noteTransferOperationRepository";

export type NoteTransferMoveDeletionStage = "database" | "cleanup";
export type NoteTransferMoveDeletionStatus = "pending" | "processing" | "completed" | "failed";

export type NoteTransferMoveDeletionClaim = {
  operationId: string;
  actorUserId: string;
  sourceNoteId: string;
  sourceVersion: number;
  sourceWorkspaceId: string | null;
  sourceNotebookId: string;
  sourceAttachmentCandidates: AttachmentDeletionCandidate[];
  stage: NoteTransferMoveDeletionStage;
  status: NoteTransferMoveDeletionStatus;
  attempts: number;
  leaseToken: string;
};

export type NoteTransferMoveDeletionSummary = {
  complete: boolean;
  operationStatus: string;
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  exhausted: number;
};

type ClaimRow = Omit<
  NoteTransferMoveDeletionClaim,
  "sourceVersion" | "sourceAttachmentCandidates" | "attempts" | "leaseToken"
> & {
  sourceVersion: number | string;
  sourceAttachmentCandidates: AttachmentDeletionCandidate[] | string;
  attempts: number | string;
};

type SummaryRow = {
  operationStatus: string;
  total: number | string;
  pending: number | string;
  processing: number | string;
  completed: number | string;
  failed: number | string;
  exhausted: number | string;
};

type SourceStateRow = {
  version: number | string;
  workspaceId: string | null;
  notebookId: string;
  isLocked: boolean | number | string;
};

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = String(value || "").trim();
  if (normalized.length < 8 || normalized.length > 128) {
    throw new NoteTransferOperationError(
      "NOTE_TRANSFER_IDEMPOTENCY_KEY_INVALID",
      "幂等键长度需为 8～128 个字符",
    );
  }
  return normalized;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toBoolean(value: boolean | number | string): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function mapClaim(row: ClaimRow | null, leaseToken: string): NoteTransferMoveDeletionClaim | null {
  if (!row) return null;
  return {
    ...row,
    sourceVersion: toNumber(row.sourceVersion),
    sourceAttachmentCandidates: parseJson(row.sourceAttachmentCandidates),
    attempts: toNumber(row.attempts),
    leaseToken,
  };
}

const READY_OPERATION_SQL = `(
  (operation.mode = 'move' AND operation.status IN ('target_committed', 'source_deleting'))
)`;

const EFFECTS_COMPLETE_SQL = `
  EXISTS (
    SELECT 1 FROM note_transfer_effect_outbox effect
     WHERE effect.operationId = operation.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM note_transfer_effect_outbox effect
     WHERE effect.operationId = operation.id AND effect.status <> 'completed'
  )
`;

export function createNoteTransferMoveDeletionRepository(adapter?: DatabaseAdapter) {
  const db = resolveAdapter(adapter);

  async function getOperation(input: { actorUserId: string; idempotencyKey: string }) {
    const key = normalizeIdempotencyKey(input.idempotencyKey);
    const row = await db.queryOne<{ id: string; mode: string; status: string }>(
      `SELECT id, mode, status
         FROM note_transfer_operations
        WHERE userId = ? AND idempotencyKey = ?`,
      [input.actorUserId, key],
    );
    if (!row) {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_PLAN_NOT_FOUND",
        "转移计划不存在",
        404,
      );
    }
    if (row.mode !== "move") {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_MOVE_REQUIRED",
        "只有移动操作需要删除源笔记",
        409,
        { operationId: row.id, mode: row.mode },
      );
    }
    return { ...row, key };
  }

  async function assertReady(input: { actorUserId: string; idempotencyKey: string }): Promise<string> {
    const operation = await getOperation(input);
    if (operation.status === "completed") return operation.id;
    if (operation.status !== "target_committed" && operation.status !== "source_deleting") {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_MOVE_NOT_READY",
        `当前状态 ${operation.status} 尚不能删除源笔记`,
        409,
        { operationId: operation.id, status: operation.status },
      );
    }
    const effects = await db.queryOne<{ total: number | string; completed: number | string }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
         FROM note_transfer_effect_outbox
        WHERE operationId = ?`,
      [operation.id],
    );
    const total = toNumber(effects?.total);
    if (total === 0 || toNumber(effects?.completed) !== total) {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_MOVE_EFFECTS_PENDING",
        "目标提交事件全部完成后才能删除源笔记",
        409,
        { operationId: operation.id, total, completed: toNumber(effects?.completed) },
      );
    }
    return operation.id;
  }

  async function claim(sql: string, params: unknown[], leaseSeconds: number) {
    const leaseToken = randomUUID();
    const row = await db.queryOne<ClaimRow>(sql, [
      ...params,
      leaseToken,
      Math.max(30, leaseSeconds),
    ]);
    return mapClaim(row ?? null, leaseToken);
  }

  async function advanceMissingSource(claim: NoteTransferMoveDeletionClaim): Promise<void> {
    const result = await db.execute(
      `UPDATE note_transfer_move_source_deletions
          SET stage = 'cleanup', status = 'processing',
              databaseDeletedAt = COALESCE(databaseDeletedAt, CURRENT_TIMESTAMP),
              lastError = NULL, updatedAt = CURRENT_TIMESTAMP
        WHERE operationId = ? AND sourceNoteId = ?
          AND status = 'processing' AND stage = 'database' AND leaseToken = ?`,
      [claim.operationId, claim.sourceNoteId, claim.leaseToken],
    );
    if (result.changes !== 1) {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_MOVE_LEASE_LOST",
        "源删除租约已失效",
        409,
        { operationId: claim.operationId, sourceNoteId: claim.sourceNoteId },
      );
    }
  }

  return {
    assertReady,

    async claimNextForOperation(input: {
      actorUserId: string;
      idempotencyKey: string;
      maxAttempts: number;
      leaseSeconds: number;
    }): Promise<NoteTransferMoveDeletionClaim | null> {
      const operationId = await assertReady(input);
      return claim(
        `WITH candidate AS (
           SELECT deletion.operationId, deletion.sourceNoteId
             FROM note_transfer_move_source_deletions deletion
             JOIN note_transfer_operations operation ON operation.id = deletion.operationId
            WHERE deletion.operationId = ?
              AND ${READY_OPERATION_SQL}
              AND ${EFFECTS_COMPLETE_SQL}
              AND deletion.attempts < ?
              AND deletion.availableAt <= CURRENT_TIMESTAMP
              AND (
                deletion.status IN ('pending', 'failed')
                OR (
                  deletion.status = 'processing'
                  AND (deletion.leaseExpiresAt IS NULL OR deletion.leaseExpiresAt <= CURRENT_TIMESTAMP)
                )
              )
            ORDER BY deletion.createdAt, deletion.sourceNoteId
            FOR UPDATE OF deletion SKIP LOCKED
            LIMIT 1
         ), advance AS (
           UPDATE note_transfer_operations operation
              SET status = 'source_deleting', updatedAt = CURRENT_TIMESTAMP
            WHERE operation.id = (SELECT operationId FROM candidate)
              AND operation.status = 'target_committed'
         )
         UPDATE note_transfer_move_source_deletions deletion
            SET status = 'processing', attempts = deletion.attempts + 1,
                leaseToken = ?,
                leaseExpiresAt = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                lastError = NULL, updatedAt = CURRENT_TIMESTAMP
           FROM candidate
          WHERE deletion.operationId = candidate.operationId
            AND deletion.sourceNoteId = candidate.sourceNoteId
         RETURNING deletion.operationId,
                   (SELECT userId FROM note_transfer_operations WHERE id = deletion.operationId) AS actorUserId,
                   deletion.sourceNoteId, deletion.sourceVersion,
                   deletion.sourceWorkspaceId, deletion.sourceNotebookId,
                   deletion.sourceAttachmentCandidates, deletion.stage,
                   deletion.status, deletion.attempts`,
        [operationId, input.maxAttempts],
        input.leaseSeconds,
      );
    },

    async claimNextAny(input: {
      maxAttempts: number;
      leaseSeconds: number;
    }): Promise<NoteTransferMoveDeletionClaim | null> {
      return claim(
        `WITH candidate AS (
           SELECT deletion.operationId, deletion.sourceNoteId
             FROM note_transfer_move_source_deletions deletion
             JOIN note_transfer_operations operation ON operation.id = deletion.operationId
            WHERE ${READY_OPERATION_SQL}
              AND ${EFFECTS_COMPLETE_SQL}
              AND deletion.attempts < ?
              AND deletion.availableAt <= CURRENT_TIMESTAMP
              AND (
                deletion.status IN ('pending', 'failed')
                OR (
                  deletion.status = 'processing'
                  AND (deletion.leaseExpiresAt IS NULL OR deletion.leaseExpiresAt <= CURRENT_TIMESTAMP)
                )
              )
            ORDER BY deletion.createdAt, deletion.sourceNoteId
            FOR UPDATE OF deletion SKIP LOCKED
            LIMIT 1
         ), advance AS (
           UPDATE note_transfer_operations operation
              SET status = 'source_deleting', updatedAt = CURRENT_TIMESTAMP
            WHERE operation.id = (SELECT operationId FROM candidate)
              AND operation.status = 'target_committed'
         )
         UPDATE note_transfer_move_source_deletions deletion
            SET status = 'processing', attempts = deletion.attempts + 1,
                leaseToken = ?,
                leaseExpiresAt = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                lastError = NULL, updatedAt = CURRENT_TIMESTAMP
           FROM candidate
          WHERE deletion.operationId = candidate.operationId
            AND deletion.sourceNoteId = candidate.sourceNoteId
         RETURNING deletion.operationId,
                   (SELECT userId FROM note_transfer_operations WHERE id = deletion.operationId) AS actorUserId,
                   deletion.sourceNoteId, deletion.sourceVersion,
                   deletion.sourceWorkspaceId, deletion.sourceNotebookId,
                   deletion.sourceAttachmentCandidates, deletion.stage,
                   deletion.status, deletion.attempts`,
        [input.maxAttempts],
        input.leaseSeconds,
      );
    },

    async deleteSourceDatabase(claim: NoteTransferMoveDeletionClaim): Promise<void> {
      if (claim.stage === "cleanup") return;
      const current = await db.queryOne<SourceStateRow>(
        `SELECT version, workspaceId, notebookId, isLocked
           FROM notes WHERE id = ?`,
        [claim.sourceNoteId],
      );
      if (!current) {
        await advanceMissingSource(claim);
        return;
      }

      const statements: DbStatement[] = [{
        sql: `SELECT note.id
                FROM notes note
                LEFT JOIN workspaces workspace ON workspace.id = note.workspaceId
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
               WHERE note.id = ? AND note.version = ? AND note.isLocked = false
                 AND COALESCE(note.workspaceId, '') = COALESCE(?, '')
                 AND note.notebookId = ?
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
          claim.actorUserId,
          claim.actorUserId,
          claim.actorUserId,
          claim.sourceNoteId,
          claim.sourceVersion,
          claim.sourceWorkspaceId,
          claim.sourceNotebookId,
          claim.actorUserId,
          claim.actorUserId,
        ],
        requireChanges: 1,
      }, {
        sql: `DELETE FROM notes
               WHERE id = ? AND version = ? AND isLocked = false
                 AND COALESCE(workspaceId, '') = COALESCE(?, '')
                 AND notebookId = ?`,
        params: [
          claim.sourceNoteId,
          claim.sourceVersion,
          claim.sourceWorkspaceId,
          claim.sourceNotebookId,
        ],
        requireChanges: 1,
      }];

      if (claim.sourceWorkspaceId) {
        statements.push({
          sql: `DELETE FROM tags
                 WHERE workspaceId = ?
                   AND NOT EXISTS (
                     SELECT 1 FROM note_tags relation
                     JOIN notes note ON note.id = relation.noteId
                    WHERE relation.tagId = tags.id
                      AND note.workspaceId = ? AND note.isTrashed = false
                   )`,
          params: [claim.sourceWorkspaceId, claim.sourceWorkspaceId],
        });
      } else {
        statements.push({
          sql: `DELETE FROM tags
                 WHERE userId = ? AND workspaceId IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM note_tags relation
                     JOIN notes note ON note.id = relation.noteId
                    WHERE relation.tagId = tags.id
                      AND note.userId = ? AND note.isTrashed = false
                   )`,
          params: [claim.actorUserId, claim.actorUserId],
        });
      }
      statements.push({
        sql: `UPDATE note_transfer_move_source_deletions
                 SET stage = 'cleanup', status = 'processing',
                     databaseDeletedAt = CURRENT_TIMESTAMP,
                     lastError = NULL, updatedAt = CURRENT_TIMESTAMP
               WHERE operationId = ? AND sourceNoteId = ?
                 AND status = 'processing' AND stage = 'database' AND leaseToken = ?`,
        params: [claim.operationId, claim.sourceNoteId, claim.leaseToken],
        requireChanges: 1,
      });

      try {
        await db.executeStatements(statements);
      } catch (error) {
        if (!(error instanceof DbStatementChangeError)) throw error;
        const latest = await db.queryOne<SourceStateRow>(
          `SELECT version, workspaceId, notebookId, isLocked
             FROM notes WHERE id = ?`,
          [claim.sourceNoteId],
        );
        if (!latest) {
          await advanceMissingSource(claim);
          return;
        }
        if (toBoolean(latest.isLocked)) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_MOVE_SOURCE_LOCKED",
            "源笔记在目标提交后被锁定，已保留源数据",
            409,
            { sourceNoteId: claim.sourceNoteId },
          );
        }
        if (
          toNumber(latest.version) !== claim.sourceVersion
          || latest.workspaceId !== claim.sourceWorkspaceId
          || latest.notebookId !== claim.sourceNotebookId
        ) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_MOVE_SOURCE_CHANGED",
            "源笔记在目标提交后发生变化，已保留源数据",
            409,
            {
              sourceNoteId: claim.sourceNoteId,
              expectedVersion: claim.sourceVersion,
              actualVersion: toNumber(latest.version),
            },
          );
        }
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_MOVE_SOURCE_FORBIDDEN",
          "源笔记删除权限已变化，已保留源数据",
          409,
          { sourceNoteId: claim.sourceNoteId },
        );
      }
    },

    async markComplete(input: {
      operationId: string;
      sourceNoteId: string;
      leaseToken: string;
      cleanupWarnings: string[];
    }): Promise<void> {
      await db.executeStatements([{
        sql: `UPDATE note_transfer_move_source_deletions
                 SET status = 'completed', stage = 'cleanup',
                     cleanupWarnings = CAST(? AS JSONB),
                     completedAt = CURRENT_TIMESTAMP,
                     leaseToken = NULL, leaseExpiresAt = NULL,
                     lastError = NULL, updatedAt = CURRENT_TIMESTAMP
               WHERE operationId = ? AND sourceNoteId = ?
                 AND status = 'processing' AND stage = 'cleanup' AND leaseToken = ?`,
        params: [
          JSON.stringify(input.cleanupWarnings),
          input.operationId,
          input.sourceNoteId,
          input.leaseToken,
        ],
        requireChanges: 1,
      }, {
        sql: `UPDATE note_transfer_operations operation
                 SET status = 'completed',
                     result = COALESCE(operation.result, '{}'::jsonb) || jsonb_build_object(
                       'sourceDeletionCompletedAt', CURRENT_TIMESTAMP,
                       'sourceDeletedNoteCount', operation.sourceNoteCount
                     ),
                     updatedAt = CURRENT_TIMESTAMP
               WHERE operation.id = ? AND operation.mode = 'move'
                 AND operation.status = 'source_deleting'
                 AND NOT EXISTS (
                   SELECT 1 FROM note_transfer_move_source_deletions deletion
                    WHERE deletion.operationId = operation.id
                      AND deletion.status <> 'completed'
                 )`,
        params: [input.operationId],
      }]);
    },

    async markFailed(input: {
      operationId: string;
      sourceNoteId: string;
      leaseToken: string;
      error: string;
      retryDelaySeconds: number;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE note_transfer_move_source_deletions
            SET status = 'failed', lastError = ?,
                availableAt = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                leaseToken = NULL, leaseExpiresAt = NULL,
                updatedAt = CURRENT_TIMESTAMP
          WHERE operationId = ? AND sourceNoteId = ?
            AND status = 'processing' AND leaseToken = ?`,
        [
          input.error.slice(0, 2_000),
          Math.max(0, input.retryDelaySeconds),
          input.operationId,
          input.sourceNoteId,
          input.leaseToken,
        ],
      );
      if (result.changes !== 1) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_MOVE_LEASE_LOST",
          "源删除租约已失效",
          409,
          { operationId: input.operationId, sourceNoteId: input.sourceNoteId },
        );
      }
    },

    async summarize(input: {
      actorUserId: string;
      idempotencyKey: string;
      maxAttempts: number;
    }): Promise<NoteTransferMoveDeletionSummary> {
      const operation = await getOperation(input);
      if (operation.status !== "completed") await assertReady(input);
      const row = await db.queryOne<SummaryRow>(
        `SELECT operation.status AS operationStatus,
                COUNT(deletion.*)::int AS total,
                COUNT(*) FILTER (WHERE deletion.status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE deletion.status = 'processing')::int AS processing,
                COUNT(*) FILTER (WHERE deletion.status = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE deletion.status = 'failed')::int AS failed,
                COUNT(*) FILTER (
                  WHERE deletion.status = 'failed' AND deletion.attempts >= ?
                )::int AS exhausted
           FROM note_transfer_operations operation
           LEFT JOIN note_transfer_move_source_deletions deletion
             ON deletion.operationId = operation.id
          WHERE operation.id = ?
          GROUP BY operation.status`,
        [input.maxAttempts, operation.id],
      );
      const summary = {
        operationStatus: row?.operationStatus || operation.status,
        total: toNumber(row?.total),
        pending: toNumber(row?.pending),
        processing: toNumber(row?.processing),
        completed: toNumber(row?.completed),
        failed: toNumber(row?.failed),
        exhausted: toNumber(row?.exhausted),
      };
      return {
        ...summary,
        complete: summary.total > 0
          && summary.completed === summary.total
          && summary.operationStatus === "completed",
      };
    },

    async countPending(): Promise<number> {
      const row = await db.queryOne<{ count: number | string }>(
        `SELECT COUNT(*)::int AS count
           FROM note_transfer_move_source_deletions deletion
           JOIN note_transfer_operations operation ON operation.id = deletion.operationId
          WHERE operation.mode = 'move'
            AND operation.status IN ('target_committed', 'source_deleting')
            AND deletion.status <> 'completed'`,
      );
      return toNumber(row?.count);
    },
  };
}
