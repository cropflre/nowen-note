import { randomUUID } from "node:crypto";

import type { DatabaseAdapter } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";
import {
  createNoteTransferOperationRepository,
  NoteTransferOperationError,
  type NoteTransferOperationStatus,
  type PreparedNoteTransferOperation,
} from "./noteTransferOperationRepository";

export type NoteTransferOrchestrationPhase =
  | "prepared"
  | "staging"
  | "committing"
  | "effects"
  | "source_deletion"
  | "cleanup"
  | "completed"
  | "failed"
  | "cancelled";

export type NoteTransferProgressSummary = {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  exhausted: number;
  complete: boolean;
};

export type NoteTransferOrchestrationSnapshot = {
  operation: PreparedNoteTransferOperation;
  phase: NoteTransferOrchestrationPhase;
  terminal: boolean;
  retryable: boolean;
  progress: {
    staging: NoteTransferProgressSummary;
    effects: NoteTransferProgressSummary;
    sourceDeletion: NoteTransferProgressSummary;
    cleanup: NoteTransferProgressSummary;
  };
  orchestration: {
    attempts: number;
    availableAt: string;
    lastAdvancedAt: string | null;
    lastError: string | null;
    running: boolean;
  };
  error: {
    code: string | null;
    message: string | null;
  } | null;
};

export type NoteTransferOrchestrationClaim = {
  operationId: string;
  actorUserId: string;
  idempotencyKey: string;
  mode: "copy" | "move";
  status: NoteTransferOperationStatus;
  leaseToken: string;
};

type ClaimRow = Omit<NoteTransferOrchestrationClaim, "leaseToken">;

type MetadataRow = {
  orchestrationAttempts: number | string;
  orchestrationAvailableAt: string | Date;
  orchestrationLeaseExpiresAt: string | Date | null;
  orchestrationLastAdvancedAt: string | Date | null;
  orchestrationLastError: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

type CountRow = {
  total: number | string;
  pending: number | string;
  processing: number | string;
  completed: number | string;
  failed: number | string;
  exhausted: number | string;
};

const ELIGIBLE_SQL = `(
  operation.status IN ('prepared', 'staging', 'target_committed', 'source_deleting')
  OR (
    operation.mode = 'copy'
    AND operation.status = 'completed'
    AND EXISTS (
      SELECT 1
        FROM note_transfer_effect_outbox effect
       WHERE effect."operationId" = operation.id
         AND effect.status <> 'completed'
    )
  )
  OR (
    operation.status IN ('cancelled', 'failed')
    AND EXISTS (
      SELECT 1
        FROM note_transfer_staged_attachments attachment
       WHERE attachment."operationId" = operation.id
         AND attachment."cleanupStatus" NOT IN ('cleaned', 'retained')
    )
  )
)`;

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
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new NoteTransferOperationError(
      "NOTE_TRANSFER_IDEMPOTENCY_KEY_INVALID",
      "幂等键仅支持字母、数字、点、下划线、冒号和连字符",
    );
  }
  return normalized;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function optionalTimestamp(value: string | Date | null): string | null {
  return value == null ? null : toTimestamp(value);
}

function countSummary(row: CountRow | null, completeWhenEmpty: boolean): NoteTransferProgressSummary {
  const summary = {
    total: toNumber(row?.total),
    pending: toNumber(row?.pending),
    processing: toNumber(row?.processing),
    completed: toNumber(row?.completed),
    failed: toNumber(row?.failed),
    exhausted: toNumber(row?.exhausted),
  };
  return {
    ...summary,
    complete: summary.total === 0 ? completeWhenEmpty : summary.completed === summary.total,
  };
}

function stagingSummary(operation: PreparedNoteTransferOperation): NoteTransferProgressSummary {
  const total = operation.plan.attachmentCount;
  const completed = operation.stagedAttachments.filter((attachment) =>
    attachment.status === "staged" || attachment.status === "committed",
  ).length;
  const processing = operation.stagedAttachments.filter(
    (attachment) => attachment.status === "copying",
  ).length;
  const failedRows = operation.stagedAttachments.filter(
    (attachment) => attachment.status === "failed",
  );
  const failed = failedRows.length;
  const exhausted = failedRows.filter((attachment) => attachment.attempts >= 5).length;
  const pending = Math.max(0, total - completed - processing - failed);
  return {
    total,
    pending,
    processing,
    completed,
    failed,
    exhausted,
    complete: completed === total,
  };
}

function cleanupSummary(operation: PreparedNoteTransferOperation): NoteTransferProgressSummary {
  const rows = operation.stagedAttachments.filter(
    (attachment) => attachment.cleanupStatus !== "retained",
  );
  const completed = rows.filter((attachment) => attachment.cleanupStatus === "cleaned").length;
  const processing = rows.filter((attachment) => attachment.cleanupStatus === "cleaning").length;
  const failedRows = rows.filter((attachment) => attachment.cleanupStatus === "failed");
  const failed = failedRows.length;
  const exhausted = failedRows.filter((attachment) => attachment.cleanupAttempts >= 5).length;
  const pending = Math.max(0, rows.length - completed - processing - failed);
  return {
    total: rows.length,
    pending,
    processing,
    completed,
    failed,
    exhausted,
    complete: completed === rows.length,
  };
}

function resolvePhase(input: {
  operation: PreparedNoteTransferOperation;
  effects: NoteTransferProgressSummary;
  sourceDeletion: NoteTransferProgressSummary;
  cleanup: NoteTransferProgressSummary;
}): NoteTransferOrchestrationPhase {
  const { operation, effects, cleanup } = input;
  if (operation.status === "cancelled" || operation.status === "failed") {
    return cleanup.complete ? operation.status : "cleanup";
  }
  if (operation.status === "prepared") return "prepared";
  if (operation.status === "staging") return "staging";
  if (operation.status === "committing") return "committing";
  if (operation.status === "target_committed") {
    return effects.complete ? "source_deletion" : "effects";
  }
  if (operation.status === "source_deleting") return "source_deletion";
  if (operation.status === "completed" && !effects.complete) return "effects";
  return "completed";
}

function activeExhausted(snapshot: Omit<NoteTransferOrchestrationSnapshot, "retryable">): number {
  if (snapshot.phase === "staging") return snapshot.progress.staging.exhausted;
  if (snapshot.phase === "effects") return snapshot.progress.effects.exhausted;
  if (snapshot.phase === "source_deletion") return snapshot.progress.sourceDeletion.exhausted;
  if (snapshot.phase === "cleanup") return snapshot.progress.cleanup.exhausted;
  return 0;
}

export function createNoteTransferOrchestrationRepository(adapter?: DatabaseAdapter) {
  const db = resolveAdapter(adapter);
  const operations = createNoteTransferOperationRepository(db);

  async function loadCounts(operationId: string, table: "effects" | "sourceDeletion"): Promise<CountRow | null> {
    if (table === "effects") {
      return db.queryOne<CountRow>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                COUNT(*) FILTER (WHERE status = 'failed' AND attempts >= 10)::int AS exhausted
           FROM note_transfer_effect_outbox
          WHERE "operationId" = ?`,
        [operationId],
      );
    }
    return db.queryOne<CountRow>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
              COUNT(*) FILTER (WHERE status = 'failed' AND attempts >= 10)::int AS exhausted
         FROM note_transfer_move_source_deletions
        WHERE "operationId" = ?`,
      [operationId],
    );
  }

  async function claim(sql: string, params: unknown[], leaseSeconds: number): Promise<NoteTransferOrchestrationClaim | null> {
    const leaseToken = randomUUID();
    const row = await db.queryOne<ClaimRow>(sql, [
      ...params,
      leaseToken,
      Math.max(30, leaseSeconds),
    ]);
    return row ? { ...row, leaseToken } : null;
  }

  return {
    async getSnapshot(input: {
      actorUserId: string;
      idempotencyKey: string;
      maxAttempts?: number;
    }): Promise<NoteTransferOrchestrationSnapshot> {
      const key = normalizeIdempotencyKey(input.idempotencyKey);
      const operation = await operations.getPrepared({
        actorUserId: input.actorUserId,
        idempotencyKey: key,
      });
      if (!operation) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_PLAN_NOT_FOUND",
          "转移计划不存在",
          404,
        );
      }
      const [metadata, effectsRow, sourceDeletionRow] = await Promise.all([
        db.queryOne<MetadataRow>(
          `SELECT "orchestrationAttempts", "orchestrationAvailableAt",
                  "orchestrationLeaseExpiresAt", "orchestrationLastAdvancedAt",
                  "orchestrationLastError", "errorCode", "errorMessage"
             FROM note_transfer_operations
            WHERE id = ?`,
          [operation.id],
        ),
        loadCounts(operation.id, "effects"),
        loadCounts(operation.id, "sourceDeletion"),
      ]);
      if (!metadata) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_PLAN_NOT_FOUND",
          "转移计划不存在",
          404,
        );
      }

      const progress = {
        staging: stagingSummary(operation),
        effects: countSummary(effectsRow, false),
        sourceDeletion: countSummary(sourceDeletionRow, operation.mode === "copy"),
        cleanup: cleanupSummary(operation),
      };
      const phase = resolvePhase({ operation, ...progress });
      const terminal = phase === "completed" || phase === "failed" || phase === "cancelled";
      const base = {
        operation,
        phase,
        terminal,
        progress,
        orchestration: {
          attempts: toNumber(metadata.orchestrationAttempts),
          availableAt: toTimestamp(metadata.orchestrationAvailableAt),
          lastAdvancedAt: optionalTimestamp(metadata.orchestrationLastAdvancedAt),
          lastError: metadata.orchestrationLastError,
          running: metadata.orchestrationLeaseExpiresAt != null
            && new Date(metadata.orchestrationLeaseExpiresAt).getTime() > Date.now(),
        },
        error: metadata.errorCode || metadata.errorMessage
          ? { code: metadata.errorCode, message: metadata.errorMessage }
          : null,
      };
      const maxAttempts = Math.max(1, input.maxAttempts || 10);
      return {
        ...base,
        retryable: !terminal
          && base.orchestration.attempts < maxAttempts
          && activeExhausted(base) === 0,
      };
    },

    async claimForOperation(input: {
      actorUserId: string;
      idempotencyKey: string;
      maxAttempts: number;
      leaseSeconds: number;
    }): Promise<NoteTransferOrchestrationClaim | null> {
      const key = normalizeIdempotencyKey(input.idempotencyKey);
      return claim(
        `WITH candidate AS (
           SELECT operation.id
             FROM note_transfer_operations operation
            WHERE operation."userId" = ? AND operation."idempotencyKey" = ?
              AND ${ELIGIBLE_SQL}
              AND operation."orchestrationAttempts" < ?
              AND operation."orchestrationAvailableAt" <= CURRENT_TIMESTAMP
              AND (
                operation."orchestrationLeaseExpiresAt" IS NULL
                OR operation."orchestrationLeaseExpiresAt" <= CURRENT_TIMESTAMP
              )
            FOR UPDATE OF operation SKIP LOCKED
            LIMIT 1
         )
         UPDATE note_transfer_operations operation
            SET "orchestrationLeaseToken" = ?,
                "orchestrationLeaseExpiresAt" = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                "updatedAt" = CURRENT_TIMESTAMP
           FROM candidate
          WHERE operation.id = candidate.id
         RETURNING operation.id AS "operationId",
                   operation."userId" AS "actorUserId",
                   operation."idempotencyKey" AS "idempotencyKey",
                   operation.mode, operation.status`,
        [input.actorUserId, key, Math.max(1, input.maxAttempts)],
        input.leaseSeconds,
      );
    },

    async claimNextAny(input: {
      maxAttempts: number;
      leaseSeconds: number;
    }): Promise<NoteTransferOrchestrationClaim | null> {
      return claim(
        `WITH candidate AS (
           SELECT operation.id
             FROM note_transfer_operations operation
            WHERE ${ELIGIBLE_SQL}
              AND operation."orchestrationAttempts" < ?
              AND operation."orchestrationAvailableAt" <= CURRENT_TIMESTAMP
              AND (
                operation."orchestrationLeaseExpiresAt" IS NULL
                OR operation."orchestrationLeaseExpiresAt" <= CURRENT_TIMESTAMP
              )
            ORDER BY operation."orchestrationAvailableAt", operation."updatedAt", operation.id
            FOR UPDATE OF operation SKIP LOCKED
            LIMIT 1
         )
         UPDATE note_transfer_operations operation
            SET "orchestrationLeaseToken" = ?,
                "orchestrationLeaseExpiresAt" = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                "updatedAt" = CURRENT_TIMESTAMP
           FROM candidate
          WHERE operation.id = candidate.id
         RETURNING operation.id AS "operationId",
                   operation."userId" AS "actorUserId",
                   operation."idempotencyKey" AS "idempotencyKey",
                   operation.mode, operation.status`,
        [Math.max(1, input.maxAttempts)],
        input.leaseSeconds,
      );
    },

    async markSucceeded(input: {
      operationId: string;
      leaseToken: string;
      delaySeconds?: number;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE note_transfer_operations
            SET "orchestrationAttempts" = 0,
                "orchestrationAvailableAt" = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                "orchestrationLeaseToken" = NULL,
                "orchestrationLeaseExpiresAt" = NULL,
                "orchestrationLastError" = NULL,
                "orchestrationLastAdvancedAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ? AND "orchestrationLeaseToken" = ?`,
        [Math.max(0, input.delaySeconds || 0), input.operationId, input.leaseToken],
      );
      if (result.changes !== 1) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_ORCHESTRATION_LEASE_LOST",
          "转移编排租约已失效",
          409,
          { operationId: input.operationId },
        );
      }
    },

    async markFailed(input: {
      operationId: string;
      leaseToken: string;
      error: string;
      retryDelaySeconds: number;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE note_transfer_operations
            SET "orchestrationAttempts" = "orchestrationAttempts" + 1,
                "orchestrationAvailableAt" = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                "orchestrationLeaseToken" = NULL,
                "orchestrationLeaseExpiresAt" = NULL,
                "orchestrationLastError" = ?,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ? AND "orchestrationLeaseToken" = ?`,
        [
          Math.max(0, input.retryDelaySeconds),
          input.error.slice(0, 2_000),
          input.operationId,
          input.leaseToken,
        ],
      );
      if (result.changes !== 1) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_ORCHESTRATION_LEASE_LOST",
          "转移编排租约已失效",
          409,
          { operationId: input.operationId },
        );
      }
    },

    async resetFailure(input: { actorUserId: string; idempotencyKey: string }): Promise<void> {
      const key = normalizeIdempotencyKey(input.idempotencyKey);
      const result = await db.execute(
        `UPDATE note_transfer_operations
            SET "orchestrationAttempts" = 0,
                "orchestrationAvailableAt" = CURRENT_TIMESTAMP,
                "orchestrationLastError" = NULL,
                "orchestrationLeaseToken" = NULL,
                "orchestrationLeaseExpiresAt" = NULL,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "userId" = ? AND "idempotencyKey" = ?`,
        [input.actorUserId, key],
      );
      if (result.changes !== 1) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_PLAN_NOT_FOUND",
          "转移计划不存在",
          404,
        );
      }
    },

    async release(input: { operationId: string; leaseToken: string }): Promise<void> {
      await db.execute(
        `UPDATE note_transfer_operations
            SET "orchestrationLeaseToken" = NULL,
                "orchestrationLeaseExpiresAt" = NULL,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ? AND "orchestrationLeaseToken" = ?`,
        [input.operationId, input.leaseToken],
      );
    },

    async countPending(): Promise<number> {
      const row = await db.queryOne<{ count: number | string }>(
        `SELECT COUNT(*)::int AS count
           FROM note_transfer_operations operation
          WHERE ${ELIGIBLE_SQL}`,
      );
      return toNumber(row?.count);
    },
  };
}
