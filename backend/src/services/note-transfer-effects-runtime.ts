import crypto from "node:crypto";

import type { DatabaseAdapter } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";
import {
  createNoteTransferEffectsRepository,
  type NoteTransferCompletedEffectEvent,
  type NoteTransferEffectClaim,
  type NoteTransferEffectSummary,
} from "../repositories/noteTransferEffectsRepository";
import { NoteTransferOperationError } from "../repositories/noteTransferOperationRepository";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_RETRY_BASE_SECONDS = 5;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

type EffectsRepository = ReturnType<typeof createNoteTransferEffectsRepository>;

export type NoteTransferEffectsResumeResult = {
  summary: NoteTransferEffectSummary;
  attempted: number;
  completedThisRun: number;
  failedThisRun: number;
};

export type NoteTransferEffectsRuntimeOptions = {
  repository?: EffectsRepository;
  fetchImpl?: typeof fetch;
  publishRealtime?: (event: NoteTransferCompletedEffectEvent) => Promise<void> | void;
  concurrency?: number;
  maxAttempts?: number;
  leaseSeconds?: number;
  retryBaseSeconds?: number;
  pollIntervalMs?: number;
  webhookTimeoutMs?: number;
};

export type NoteTransferEffectsRuntime = ReturnType<typeof createNoteTransferEffectsRuntime>;

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function signPayload(payload: string, secret: string): string {
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function createNoteTransferEffectsRuntime(
  adapter?: DatabaseAdapter,
  options: NoteTransferEffectsRuntimeOptions = {},
) {
  const db = resolveAdapter(adapter);
  const repository = options.repository || createNoteTransferEffectsRepository(db);
  const fetchImpl = options.fetchImpl || fetch;
  const publishRealtime = options.publishRealtime || (async () => {
    throw new Error("note-transfer realtime publisher is unavailable");
  });
  const concurrency = Math.max(1, Math.min(8, options.concurrency || DEFAULT_CONCURRENCY));
  const maxAttempts = Math.max(1, Math.min(50, options.maxAttempts || DEFAULT_MAX_ATTEMPTS));
  const leaseSeconds = Math.max(30, options.leaseSeconds || DEFAULT_LEASE_SECONDS);
  const retryBaseSeconds = Math.max(0, options.retryBaseSeconds ?? DEFAULT_RETRY_BASE_SECONDS);
  const pollIntervalMs = Math.max(250, options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  const webhookTimeoutMs = Math.max(100, options.webhookTimeoutMs || DEFAULT_WEBHOOK_TIMEOUT_MS);
  let timer: NodeJS.Timeout | null = null;
  let drainPromise: Promise<void> | null = null;
  let stopping = false;
  const stats = {
    attempted: 0,
    completed: 0,
    failed: 0,
    lastError: null as string | null,
  };

  async function dispatchAudit(claim: NoteTransferEffectClaim): Promise<void> {
    await db.execute(
      `INSERT INTO audit_logs (
         id, userId, category, action, level, targetType, targetId,
         details, ip, userAgent
       ) VALUES (?, ?, 'note-transfer', ?, 'info',
                 'note-transfer-operation', ?, ?, '', 'postgres-runtime')
       ON CONFLICT (id) DO NOTHING`,
      [
        claim.eventKey,
        claim.actorUserId,
        claim.payload.mode === "move" ? "move_target_committed" : "copy_completed",
        claim.operationId,
        JSON.stringify(claim.payload).slice(0, 5_000),
      ],
    );
  }

  async function recordWebhookDelivery(input: {
    claim: NoteTransferEffectClaim;
    payload: string;
    responseStatus: number | null;
    responseBody: string;
    success: boolean;
  }): Promise<void> {
    const deliveryId = `${input.claim.eventKey}:delivery`;
    await db.execute(
      `INSERT INTO webhook_deliveries (
         id, webhookId, event, payload, responseStatus, responseBody, success, attempts, deliveredAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET
         responseStatus = EXCLUDED.responseStatus,
         responseBody = EXCLUDED.responseBody,
         success = EXCLUDED.success,
         attempts = EXCLUDED.attempts,
         deliveredAt = CURRENT_TIMESTAMP`,
      [
        deliveryId,
        input.claim.destinationId,
        input.claim.eventType,
        input.payload,
        input.responseStatus,
        input.responseBody.slice(0, 2_000),
        input.success,
        input.claim.attempts,
      ],
    );
  }

  async function dispatchWebhook(claim: NoteTransferEffectClaim): Promise<void> {
    const active = await db.queryOne<{ present: number }>(
      `SELECT 1 AS present FROM webhooks WHERE id = ? AND isActive = true`,
      [claim.destinationId],
    );
    if (!active) return;

    const payload = JSON.stringify({
      event: claim.eventType,
      eventId: claim.eventKey,
      timestamp: claim.createdAt,
      data: claim.payload,
    });
    const deliveryId = `${claim.eventKey}:delivery`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), webhookTimeoutMs);
    let responseStatus: number | null = null;
    let responseBody = "";
    try {
      const response = await fetchImpl(claim.destinationUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Nowen-Event": claim.eventType,
          "X-Nowen-Delivery": deliveryId,
          "X-Nowen-Signature": claim.destinationSecret
            ? `sha256=${signPayload(payload, claim.destinationSecret)}`
            : "",
          "User-Agent": "Nowen-Note-Webhook/1.0",
        },
        body: payload,
        signal: controller.signal,
      });
      responseStatus = response.status;
      responseBody = await response.text().catch(() => "");
      await recordWebhookDelivery({
        claim,
        payload,
        responseStatus,
        responseBody,
        success: response.ok,
      });
      if (!response.ok) throw new Error(`webhook returned ${response.status}`);
    } catch (error) {
      if (responseStatus == null) {
        responseBody = errorMessage(error);
        await recordWebhookDelivery({
          claim,
          payload,
          responseStatus,
          responseBody,
          success: false,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function dispatchClaim(claim: NoteTransferEffectClaim): Promise<void> {
    if (claim.channel === "audit") {
      await dispatchAudit(claim);
      return;
    }
    if (claim.channel === "webhook") {
      await dispatchWebhook(claim);
      return;
    }
    await publishRealtime(claim.payload);
  }

  async function processClaim(claim: NoteTransferEffectClaim): Promise<boolean> {
    stats.attempted += 1;
    try {
      await dispatchClaim(claim);
      await repository.markComplete({ id: claim.id, leaseToken: claim.leaseToken });
      stats.completed += 1;
      return true;
    } catch (error) {
      const message = errorMessage(error);
      stats.failed += 1;
      stats.lastError = message;
      const retryDelaySeconds = Math.min(3_600, retryBaseSeconds * (2 ** Math.max(0, claim.attempts - 1)));
      try {
        await repository.markFailed({
          id: claim.id,
          leaseToken: claim.leaseToken,
          error: message,
          retryDelaySeconds,
        });
      } catch (leaseError) {
        if (!(leaseError instanceof NoteTransferOperationError)
          || leaseError.code !== "NOTE_TRANSFER_EFFECT_LEASE_LOST") {
          throw leaseError;
        }
      }
      return false;
    }
  }

  async function drainOperation(input: { actorUserId: string; idempotencyKey: string }): Promise<NoteTransferEffectsResumeResult> {
    await repository.assertCompleted(input);
    const initial = await repository.summarize({ ...input, maxAttempts });
    let remaining = Math.max(0, initial.total - initial.completed - initial.exhausted);
    const counters = { attempted: 0, completedThisRun: 0, failedThisRun: 0 };
    const worker = async () => {
      while (remaining > 0) {
        remaining -= 1;
        const claim = await repository.claimNextForOperation({
          ...input,
          maxAttempts,
          leaseSeconds,
        });
        if (!claim) return;
        counters.attempted += 1;
        if (await processClaim(claim)) counters.completedThisRun += 1;
        else counters.failedThisRun += 1;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return {
      ...counters,
      summary: await repository.summarize({ ...input, maxAttempts }),
    };
  }

  async function drainAll(): Promise<void> {
    const worker = async () => {
      while (!stopping) {
        const claim = await repository.claimNextAny({ maxAttempts, leaseSeconds });
        if (!claim) return;
        await processClaim(claim);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  function wake(): void {
    if (stopping || drainPromise) return;
    drainPromise = drainAll()
      .catch((error) => {
        stats.lastError = errorMessage(error);
        console.warn("[note-transfer-effects-runtime] drain failed:", stats.lastError);
      })
      .finally(() => {
        drainPromise = null;
      });
  }

  function start(): void {
    if (timer || stopping) return;
    wake();
    timer = setInterval(wake, pollIntervalMs);
    timer.unref?.();
  }

  async function shutdown(): Promise<void> {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
    await drainPromise;
  }

  return {
    resume: drainOperation,
    start,
    wake,
    shutdown,
    async getStats() {
      return { ...stats, pending: await repository.countPending(), running: Boolean(drainPromise) };
    },
  };
}

export type { NoteTransferCompletedEffectEvent };
