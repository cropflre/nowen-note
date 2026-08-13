import { randomUUID } from "node:crypto";

import type { DatabaseAdapter } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";
import { NoteTransferOperationError } from "./noteTransferOperationRepository";

export type NoteTransferEffectChannel = "audit" | "webhook" | "realtime";
export type NoteTransferEffectStatus = "pending" | "processing" | "completed" | "failed";

export type NoteTransferCompletedEffectEvent = {
  eventId: string;
  kind: "note.transfer.completed" | "note.transfer.target_committed";
  operationId: string;
  actorUserId: string;
  mode: "copy" | "move";
  sourceWorkspaceId: string | null;
  targetWorkspaceId: string | null;
  targetNotebookId: string;
  sourceNoteIds: string[];
  targetNoteIds: Record<string, string>;
  attachmentCount: number;
  tagCount: number;
  noteLinkCount: number;
  blockCount: number;
  warnings: string[];
};

export type NoteTransferEffectClaim = {
  id: string;
  operationId: string;
  actorUserId: string;
  channel: NoteTransferEffectChannel;
  destinationId: string;
  destinationUrl: string;
  destinationSecret: string;
  eventType: string;
  eventKey: string;
  payload: NoteTransferCompletedEffectEvent;
  attempts: number;
  leaseToken: string;
  createdAt: string;
};

export type NoteTransferEffectSummary = {
  complete: boolean;
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  exhausted: number;
};

type ClaimRow = Omit<NoteTransferEffectClaim, "payload" | "attempts" | "leaseToken" | "createdAt"> & {
  payload: NoteTransferCompletedEffectEvent | string;
  attempts: number | string;
  createdAt: string | Date;
};

type SummaryRow = {
  total: number | string;
  pending: number | string;
  processing: number | string;
  completed: number | string;
  failed: number | string;
  exhausted: number | string;
};

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function toNumber(value: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
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

function mapClaim(row: ClaimRow | null, leaseToken: string): NoteTransferEffectClaim | null {
  if (!row) return null;
  return {
    ...row,
    payload: parseJson(row.payload),
    attempts: toNumber(row.attempts),
    leaseToken,
    createdAt: toTimestamp(row.createdAt),
  };
}

export function createNoteTransferEffectsRepository(adapter?: DatabaseAdapter) {
  const db = resolveAdapter(adapter);

  async function assertCompleted(input: { actorUserId: string; idempotencyKey: string }): Promise<string> {
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
    const ready = row.mode === "copy"
      ? row.status === "completed"
      : ["target_committed", "source_deleting", "completed"].includes(row.status);
    if (!ready) {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_EFFECTS_NOT_READY",
        `当前状态 ${row.status} 尚不能派发目标提交事件`,
        409,
        { operationId: row.id, mode: row.mode, status: row.status },
      );
    }
    return row.id;
  }

  async function claim(sql: string, params: unknown[], leaseSeconds: number): Promise<NoteTransferEffectClaim | null> {
    const leaseToken = randomUUID();
    const row = await db.queryOne<ClaimRow>(sql, [
      ...params,
      leaseToken,
      Math.max(30, leaseSeconds),
    ]);
    return mapClaim(row ?? null, leaseToken);
  }

  return {
    assertCompleted,

    async claimNextForOperation(input: {
      actorUserId: string;
      idempotencyKey: string;
      maxAttempts: number;
      leaseSeconds: number;
    }): Promise<NoteTransferEffectClaim | null> {
      const key = normalizeIdempotencyKey(input.idempotencyKey);
      return claim(
        `WITH candidate AS (
           SELECT outbox.id
             FROM note_transfer_effect_outbox outbox
             JOIN note_transfer_operations operation ON operation.id = outbox.operationId
            WHERE operation.userId = ? AND operation.idempotencyKey = ?
              AND ((operation.mode = 'copy' AND operation.status = 'completed')
                OR (operation.mode = 'move' AND operation.status IN ('target_committed', 'source_deleting', 'completed')))
              AND outbox.attempts < ?
              AND outbox.availableAt <= CURRENT_TIMESTAMP
              AND (
                outbox.status IN ('pending', 'failed')
                OR (
                  outbox.status = 'processing'
                  AND (outbox.leaseExpiresAt IS NULL OR outbox.leaseExpiresAt <= CURRENT_TIMESTAMP)
                )
              )
            ORDER BY outbox.createdAt, outbox.channel, outbox.destinationId
            FOR UPDATE OF outbox SKIP LOCKED
            LIMIT 1
         )
         UPDATE note_transfer_effect_outbox outbox
            SET status = 'processing', attempts = outbox.attempts + 1,
                leaseToken = ?,
                leaseExpiresAt = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                lastError = NULL, updatedAt = CURRENT_TIMESTAMP
           FROM candidate
          WHERE outbox.id = candidate.id
         RETURNING outbox.id, outbox.operationId, outbox.actorUserId,
                   outbox.channel, outbox.destinationId, outbox.destinationUrl,
                   outbox.destinationSecret, outbox.eventType, outbox.eventKey,
                   outbox.payload, outbox.attempts, outbox.createdAt`,
        [input.actorUserId, key, input.maxAttempts],
        input.leaseSeconds,
      );
    },

    async claimNextAny(input: {
      maxAttempts: number;
      leaseSeconds: number;
    }): Promise<NoteTransferEffectClaim | null> {
      return claim(
        `WITH candidate AS (
           SELECT outbox.id
             FROM note_transfer_effect_outbox outbox
             JOIN note_transfer_operations operation ON operation.id = outbox.operationId
            WHERE operation.status = 'completed'
              AND outbox.attempts < ?
              AND outbox.availableAt <= CURRENT_TIMESTAMP
              AND (
                outbox.status IN ('pending', 'failed')
                OR (
                  outbox.status = 'processing'
                  AND (outbox.leaseExpiresAt IS NULL OR outbox.leaseExpiresAt <= CURRENT_TIMESTAMP)
                )
              )
            ORDER BY outbox.createdAt, outbox.channel, outbox.destinationId
            FOR UPDATE OF outbox SKIP LOCKED
            LIMIT 1
         )
         UPDATE note_transfer_effect_outbox outbox
            SET status = 'processing', attempts = outbox.attempts + 1,
                leaseToken = ?,
                leaseExpiresAt = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                lastError = NULL, updatedAt = CURRENT_TIMESTAMP
           FROM candidate
          WHERE outbox.id = candidate.id
         RETURNING outbox.id, outbox.operationId, outbox.actorUserId,
                   outbox.channel, outbox.destinationId, outbox.destinationUrl,
                   outbox.destinationSecret, outbox.eventType, outbox.eventKey,
                   outbox.payload, outbox.attempts, outbox.createdAt`,
        [input.maxAttempts],
        input.leaseSeconds,
      );
    },

    async markComplete(input: { id: string; leaseToken: string }): Promise<void> {
      const result = await db.execute(
        `UPDATE note_transfer_effect_outbox
            SET status = 'completed', completedAt = CURRENT_TIMESTAMP,
                leaseToken = NULL, leaseExpiresAt = NULL, lastError = NULL,
                updatedAt = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'processing' AND leaseToken = ?`,
        [input.id, input.leaseToken],
      );
      if (result.changes !== 1) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_EFFECT_LEASE_LOST",
          "副作用派发租约已失效",
          409,
          { effectId: input.id },
        );
      }
    },

    async markFailed(input: {
      id: string;
      leaseToken: string;
      error: string;
      retryDelaySeconds: number;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE note_transfer_effect_outbox
            SET status = 'failed', lastError = ?,
                availableAt = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                leaseToken = NULL, leaseExpiresAt = NULL,
                updatedAt = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'processing' AND leaseToken = ?`,
        [
          input.error.slice(0, 2_000),
          Math.max(0, input.retryDelaySeconds),
          input.id,
          input.leaseToken,
        ],
      );
      if (result.changes !== 1) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_EFFECT_LEASE_LOST",
          "副作用派发租约已失效",
          409,
          { effectId: input.id },
        );
      }
    },

    async summarize(input: {
      actorUserId: string;
      idempotencyKey: string;
      maxAttempts: number;
    }): Promise<NoteTransferEffectSummary> {
      const operationId = await assertCompleted(input);
      const row = await db.queryOne<SummaryRow>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                COUNT(*) FILTER (WHERE status = 'failed' AND attempts >= ?)::int AS exhausted
           FROM note_transfer_effect_outbox
          WHERE operationId = ?`,
        [input.maxAttempts, operationId],
      );
      const summary = {
        total: toNumber(row?.total || 0),
        pending: toNumber(row?.pending || 0),
        processing: toNumber(row?.processing || 0),
        completed: toNumber(row?.completed || 0),
        failed: toNumber(row?.failed || 0),
        exhausted: toNumber(row?.exhausted || 0),
      };
      return { ...summary, complete: summary.total > 0 && summary.completed === summary.total };
    },

    async countPending(): Promise<number> {
      const row = await db.queryOne<{ count: number | string }>(
        `SELECT COUNT(*)::int AS count
           FROM note_transfer_effect_outbox outbox
           JOIN note_transfer_operations operation ON operation.id = outbox.operationId
          WHERE ((operation.mode = 'copy' AND operation.status = 'completed')
              OR (operation.mode = 'move' AND operation.status IN ('target_committed', 'source_deleting', 'completed')))
            AND outbox.status <> 'completed'`,
      );
      return toNumber(row?.count || 0);
    },
  };
}
