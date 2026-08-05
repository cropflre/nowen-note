import type { DatabaseAdapter } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";
import {
  createNoteTransferMoveDeletionRepository,
  type NoteTransferMoveDeletionClaim,
  type NoteTransferMoveDeletionSummary,
} from "../repositories/noteTransferMoveDeletionRepository";
import { NoteTransferOperationError } from "../repositories/noteTransferOperationRepository";
import {
  cleanupDeletedNoteAttachments,
  type AttachmentDeletionCandidate,
  type AttachmentDeletionCleanupResult,
} from "./attachment-deletion-runtime";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_RETRY_BASE_SECONDS = 5;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

type MoveRepository = ReturnType<typeof createNoteTransferMoveDeletionRepository>;

export type NoteTransferMoveDeletionResumeResult = {
  summary: NoteTransferMoveDeletionSummary;
  attempted: number;
  completedThisRun: number;
  failedThisRun: number;
};

export type NoteTransferMoveDeletionRuntimeOptions = {
  repository?: MoveRepository;
  cleanupAttachments?: (
    adapter: DatabaseAdapter,
    candidates: AttachmentDeletionCandidate[],
  ) => Promise<AttachmentDeletionCleanupResult>;
  concurrency?: number;
  maxAttempts?: number;
  leaseSeconds?: number;
  retryBaseSeconds?: number;
  pollIntervalMs?: number;
};

export type NoteTransferMoveDeletionRuntime = ReturnType<typeof createNoteTransferMoveDeletionRuntime>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function createNoteTransferMoveDeletionRuntime(
  adapter?: DatabaseAdapter,
  options: NoteTransferMoveDeletionRuntimeOptions = {},
) {
  const db = adapter ?? getDatabaseAdapter();
  const repository = options.repository || createNoteTransferMoveDeletionRepository(db);
  const cleanupAttachments = options.cleanupAttachments || cleanupDeletedNoteAttachments;
  const concurrency = Math.max(1, Math.min(8, options.concurrency || DEFAULT_CONCURRENCY));
  const maxAttempts = Math.max(1, Math.min(50, options.maxAttempts || DEFAULT_MAX_ATTEMPTS));
  const leaseSeconds = Math.max(30, options.leaseSeconds || DEFAULT_LEASE_SECONDS);
  const retryBaseSeconds = Math.max(0, options.retryBaseSeconds ?? DEFAULT_RETRY_BASE_SECONDS);
  const pollIntervalMs = Math.max(250, options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  let timer: NodeJS.Timeout | null = null;
  let drainPromise: Promise<void> | null = null;
  let stopping = false;
  const stats = {
    attempted: 0,
    completed: 0,
    failed: 0,
    lastError: null as string | null,
  };

  async function processClaim(claim: NoteTransferMoveDeletionClaim): Promise<boolean> {
    stats.attempted += 1;
    try {
      await repository.deleteSourceDatabase(claim);
      const cleanup = await cleanupAttachments(db, claim.sourceAttachmentCandidates);
      await repository.markComplete({
        operationId: claim.operationId,
        sourceNoteId: claim.sourceNoteId,
        leaseToken: claim.leaseToken,
        cleanupWarnings: cleanup.warnings,
      });
      stats.completed += 1;
      return true;
    } catch (error) {
      const message = errorMessage(error);
      stats.failed += 1;
      stats.lastError = message;
      const retryDelaySeconds = Math.min(
        3_600,
        retryBaseSeconds * (2 ** Math.max(0, claim.attempts - 1)),
      );
      try {
        await repository.markFailed({
          operationId: claim.operationId,
          sourceNoteId: claim.sourceNoteId,
          leaseToken: claim.leaseToken,
          error: message,
          retryDelaySeconds,
        });
      } catch (leaseError) {
        if (!(leaseError instanceof NoteTransferOperationError)
          || leaseError.code !== "NOTE_TRANSFER_MOVE_LEASE_LOST") {
          throw leaseError;
        }
      }
      return false;
    }
  }

  async function resume(input: {
    actorUserId: string;
    idempotencyKey: string;
  }): Promise<NoteTransferMoveDeletionResumeResult> {
    await repository.assertReady(input);
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
        console.warn("[note-transfer-move-deletion-runtime] drain failed:", stats.lastError);
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
    resume,
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
