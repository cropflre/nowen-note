import type { DatabaseAdapter } from "../db/adapters/types";
import {
  createNoteTransferOrchestrationRepository,
  type NoteTransferOrchestrationClaim,
  type NoteTransferOrchestrationSnapshot,
} from "../repositories/noteTransferOrchestrationRepository";
import {
  createNoteTransferOperationRepository,
  NoteTransferOperationError,
  type PreparedNoteTransferOperation,
} from "../repositories/noteTransferOperationRepository";
import { createNoteTransferAttachmentStagingRuntime } from "./note-transfer-attachment-staging-runtime";
import { createNoteTransferCleanupRuntime } from "./note-transfer-cleanup-runtime";
import { createNoteTransferCommitRuntime } from "./note-transfer-commit-runtime";
import {
  createNoteTransferEffectsRuntime,
  type NoteTransferEffectsRuntime,
} from "./note-transfer-effects-runtime";
import {
  createNoteTransferMoveDeletionRuntime,
  type NoteTransferMoveDeletionRuntime,
} from "./note-transfer-move-deletion-runtime";
import {
  createNoteTransferPreviewRuntime,
  NoteTransferPreviewRuntimeError,
  type NoteTransferPreviewRuntimeRequest,
} from "./note-transfer-preview-runtime";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_LEASE_SECONDS = 600;
const DEFAULT_RETRY_BASE_SECONDS = 5;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_TRANSITIONS = 4;

type Operations = ReturnType<typeof createNoteTransferOperationRepository>;
type OrchestrationRepository = ReturnType<typeof createNoteTransferOrchestrationRepository>;
type PreviewRuntime = ReturnType<typeof createNoteTransferPreviewRuntime>;
type StagingRuntime = ReturnType<typeof createNoteTransferAttachmentStagingRuntime>;
type CommitRuntime = ReturnType<typeof createNoteTransferCommitRuntime>;
type CleanupRuntime = ReturnType<typeof createNoteTransferCleanupRuntime>;

export type NoteTransferOrchestrationSubmitRequest = NoteTransferPreviewRuntimeRequest & {
  idempotencyKey: string;
};

export type NoteTransferOrchestrationResponse = {
  accepted: boolean;
  reused: boolean;
  snapshot: NoteTransferOrchestrationSnapshot;
};

export type NoteTransferOrchestrationRuntimeOptions = {
  repository?: OrchestrationRepository;
  operations?: Operations;
  preview?: PreviewRuntime;
  staging?: StagingRuntime;
  commit?: CommitRuntime;
  cleanup?: CleanupRuntime;
  effects?: NoteTransferEffectsRuntime;
  moveDeletion?: NoteTransferMoveDeletionRuntime;
  concurrency?: number;
  maxAttempts?: number;
  leaseSeconds?: number;
  retryBaseSeconds?: number;
  pollIntervalMs?: number;
  maxTransitions?: number;
};

export type NoteTransferOrchestrationRuntime = ReturnType<typeof createNoteTransferOrchestrationRuntime>;

function errorMessage(error: unknown): string {
  if (error instanceof NoteTransferOperationError || error instanceof NoteTransferPreviewRuntimeError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function normalizedIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => String(id || "").trim()).filter(Boolean)));
}

function sameRecord(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function assertExistingRequestMatches(
  operation: PreparedNoteTransferOperation,
  request: NoteTransferOrchestrationSubmitRequest,
): void {
  const sourceNoteIds = normalizedIds(request.sourceNoteIds);
  const staticMatch = operation.mode === request.mode
    && operation.targetWorkspaceId === request.targetWorkspaceId
    && operation.targetNotebookId === request.targetNotebookId
    && operation.includeAttachments === (request.includeAttachments !== false)
    && operation.includeTags === (request.includeTags !== false)
    && JSON.stringify(operation.plan.sourceNoteIds) === JSON.stringify(sourceNoteIds);
  const versionMatch = !request.expectedVersions
    || sameRecord(operation.sourceVersions, request.expectedVersions);
  if (!staticMatch || !versionMatch) {
    throw new NoteTransferOperationError(
      "NOTE_TRANSFER_IDEMPOTENCY_CONFLICT",
      "该幂等键已用于不同的转移请求",
      409,
      { operationId: operation.id },
    );
  }
}

function progressSignature(snapshot: NoteTransferOrchestrationSnapshot): string {
  return JSON.stringify({
    status: snapshot.operation.status,
    phase: snapshot.phase,
    staging: snapshot.progress.staging,
    effects: snapshot.progress.effects,
    sourceDeletion: snapshot.progress.sourceDeletion,
    cleanup: snapshot.progress.cleanup,
  });
}

function assertNoExhaustedWork(snapshot: NoteTransferOrchestrationSnapshot): void {
  const summary = snapshot.phase === "staging"
    ? snapshot.progress.staging
    : snapshot.phase === "effects"
      ? snapshot.progress.effects
      : snapshot.phase === "source_deletion"
        ? snapshot.progress.sourceDeletion
        : snapshot.phase === "cleanup"
          ? snapshot.progress.cleanup
          : null;
  if (!summary || summary.exhausted === 0) return;
  throw new NoteTransferOperationError(
    "NOTE_TRANSFER_ORCHESTRATION_EXHAUSTED",
    `转移阶段 ${snapshot.phase} 已达到最大重试次数`,
    409,
    {
      operationId: snapshot.operation.id,
      phase: snapshot.phase,
      exhausted: summary.exhausted,
    },
  );
}

export function createNoteTransferOrchestrationRuntime(
  adapter?: DatabaseAdapter,
  options: NoteTransferOrchestrationRuntimeOptions = {},
) {
  const operations = options.operations || createNoteTransferOperationRepository(adapter);
  const repository = options.repository || createNoteTransferOrchestrationRepository(adapter);
  const preview = options.preview || createNoteTransferPreviewRuntime(adapter);
  const staging = options.staging || createNoteTransferAttachmentStagingRuntime(adapter, { operations });
  const commit = options.commit || createNoteTransferCommitRuntime(adapter, { operations });
  const cleanup = options.cleanup || createNoteTransferCleanupRuntime(adapter, { operations });
  const effects = options.effects || createNoteTransferEffectsRuntime(adapter);
  const moveDeletion = options.moveDeletion || createNoteTransferMoveDeletionRuntime(adapter);
  const concurrency = Math.max(1, Math.min(8, options.concurrency || DEFAULT_CONCURRENCY));
  const maxAttempts = Math.max(1, Math.min(50, options.maxAttempts || DEFAULT_MAX_ATTEMPTS));
  const leaseSeconds = Math.max(30, options.leaseSeconds || DEFAULT_LEASE_SECONDS);
  const retryBaseSeconds = Math.max(0, options.retryBaseSeconds ?? DEFAULT_RETRY_BASE_SECONDS);
  const pollIntervalMs = Math.max(250, options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  const maxTransitions = Math.max(1, Math.min(8, options.maxTransitions || DEFAULT_MAX_TRANSITIONS));
  let timer: NodeJS.Timeout | null = null;
  let drainPromise: Promise<void> | null = null;
  let stopping = false;
  const stats = {
    claimed: 0,
    advanced: 0,
    failed: 0,
    lastError: null as string | null,
  };

  async function snapshot(input: { actorUserId: string; idempotencyKey: string }) {
    return repository.getSnapshot({ ...input, maxAttempts });
  }

  async function prepare(input: NoteTransferOrchestrationSubmitRequest): Promise<{
    operation: PreparedNoteTransferOperation;
    accepted: boolean;
  }> {
    const existing = await operations.getPrepared(input);
    if (existing) {
      assertExistingRequestMatches(existing, input);
      return { operation: existing, accepted: false };
    }

    const result = await preview.preview(input);
    if (!result.canExecute) {
      throw new NoteTransferPreviewRuntimeError(
        "NOTE_TRANSFER_PREVIEW_BLOCKED",
        "转移预检未通过",
        409,
        { blockers: result.blockers, warnings: result.warnings },
      );
    }
    const operation = await operations.prepareOperation({
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      mode: input.mode,
      sourceWorkspaceId: result.sourceWorkspaceId,
      targetWorkspaceId: result.targetWorkspaceId,
      targetNotebookId: result.targetNotebookId,
      includeAttachments: input.includeAttachments !== false,
      includeTags: input.includeTags !== false,
      sourceNoteIds: result.notes.map((note) => note.id),
      sourceVersions: result.sourceVersions,
      attachmentCount: input.includeAttachments !== false ? result.attachmentCount : 0,
      attachmentBytes: input.includeAttachments !== false ? result.attachmentBytes : 0,
      tagCount: input.includeTags !== false ? result.tagCount : 0,
      internalNoteLinkCount: result.internalNoteLinkCount,
      externalNoteLinkCount: result.externalNoteLinkCount,
    });
    return { operation, accepted: !operation.reused };
  }

  async function advanceClaim(claim: NoteTransferOrchestrationClaim): Promise<NoteTransferOrchestrationSnapshot> {
    const key = {
      actorUserId: claim.actorUserId,
      idempotencyKey: claim.idempotencyKey,
    };
    let current = await snapshot(key);
    let transitions = 0;
    while (!current.terminal && transitions < maxTransitions) {
      assertNoExhaustedWork(current);
      const before = progressSignature(current);

      if (current.phase === "prepared") {
        await operations.beginStaging(key);
      } else if (current.phase === "staging") {
        const staged = await staging.resume(key);
        if (staged.summary.exhausted > 0) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_STAGING_EXHAUSTED",
            "附件 staging 已达到最大重试次数",
            409,
            { operationId: current.operation.id, exhausted: staged.summary.exhausted },
          );
        }
        if (staged.summary.complete) {
          await commit.commit(key);
          effects.wake();
          moveDeletion.wake();
        }
      } else if (current.phase === "effects") {
        const dispatched = await effects.resume(key);
        if (dispatched.summary.exhausted > 0) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_EFFECTS_EXHAUSTED",
            "转移副作用派发已达到最大重试次数",
            409,
            { operationId: current.operation.id, exhausted: dispatched.summary.exhausted },
          );
        }
        if (dispatched.summary.complete) moveDeletion.wake();
      } else if (current.phase === "source_deletion") {
        const deleted = await moveDeletion.resume(key);
        if (deleted.summary.exhausted > 0) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_MOVE_DELETION_EXHAUSTED",
            "源笔记删除已达到最大重试次数",
            409,
            { operationId: current.operation.id, exhausted: deleted.summary.exhausted },
          );
        }
      } else if (current.phase === "cleanup") {
        const cleaned = await cleanup.resume(key);
        if (cleaned.summary.exhausted > 0) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_CLEANUP_EXHAUSTED",
            "staging 对象清理已达到最大重试次数",
            409,
            { operationId: current.operation.id, exhausted: cleaned.summary.exhausted },
          );
        }
      } else if (current.phase === "committing") {
        break;
      }

      transitions += 1;
      const next = await snapshot(key);
      if (progressSignature(next) === before && !next.terminal) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_ORCHESTRATION_NO_PROGRESS",
          `转移阶段 ${next.phase} 暂时无法继续推进`,
          409,
          { operationId: next.operation.id, phase: next.phase },
        );
      }
      current = next;
    }
    return current;
  }

  async function processClaim(claim: NoteTransferOrchestrationClaim): Promise<NoteTransferOrchestrationSnapshot | null> {
    stats.claimed += 1;
    try {
      const result = await advanceClaim(claim);
      await repository.markSucceeded({
        operationId: claim.operationId,
        leaseToken: claim.leaseToken,
        delaySeconds: result.terminal ? 0 : 1,
      });
      stats.advanced += 1;
      return result;
    } catch (error) {
      const message = errorMessage(error);
      stats.failed += 1;
      stats.lastError = message;
      const current = await repository.getSnapshot({
        actorUserId: claim.actorUserId,
        idempotencyKey: claim.idempotencyKey,
        maxAttempts,
      }).catch(() => null);
      const exponent = Math.max(0, current?.orchestration.attempts || 0);
      const retryDelaySeconds = Math.min(3_600, retryBaseSeconds * (2 ** exponent));
      try {
        await repository.markFailed({
          operationId: claim.operationId,
          leaseToken: claim.leaseToken,
          error: message,
          retryDelaySeconds,
        });
      } catch (leaseError) {
        if (!(leaseError instanceof NoteTransferOperationError)
          || leaseError.code !== "NOTE_TRANSFER_ORCHESTRATION_LEASE_LOST") {
          throw leaseError;
        }
      }
      return current;
    }
  }

  async function advanceForOperation(input: {
    actorUserId: string;
    idempotencyKey: string;
  }): Promise<NoteTransferOrchestrationSnapshot> {
    const claim = await repository.claimForOperation({
      ...input,
      maxAttempts,
      leaseSeconds,
    });
    if (!claim) return snapshot(input);
    return await processClaim(claim) || snapshot(input);
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
        console.warn("[note-transfer-orchestration-runtime] drain failed:", stats.lastError);
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
    async submit(input: NoteTransferOrchestrationSubmitRequest): Promise<NoteTransferOrchestrationResponse> {
      const prepared = await prepare(input);
      let operation = prepared.operation;
      if (operation.status === "prepared") {
        operation = await operations.beginStaging({
          actorUserId: input.actorUserId,
          idempotencyKey: input.idempotencyKey,
        });
      }
      const submittedSnapshot = await snapshot(input);
      wake();
      return {
        accepted: prepared.accepted,
        reused: !prepared.accepted || operation.reused,
        snapshot: submittedSnapshot,
      };
    },

    async resume(input: {
      actorUserId: string;
      idempotencyKey: string;
    }): Promise<NoteTransferOrchestrationSnapshot> {
      await repository.resetFailure(input);
      const result = await advanceForOperation(input);
      wake();
      return result;
    },

    async cancel(input: {
      actorUserId: string;
      idempotencyKey: string;
    }): Promise<NoteTransferOrchestrationSnapshot> {
      await operations.cancelOperation(input);
      wake();
      return snapshot(input);
    },

    getStatus: snapshot,
    advanceForOperation,
    start,
    wake,
    shutdown,
    async getStats() {
      return {
        ...stats,
        pending: await repository.countPending(),
        running: Boolean(drainPromise),
      };
    },
  };
}
