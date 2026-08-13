import type { DatabaseAdapter } from "../db/adapters/types";
import {
  createNoteTransferOperationRepository,
  NoteTransferOperationError,
  type PreparedNoteTransferOperation,
} from "../repositories/noteTransferOperationRepository";
import { createAttachmentStorageRuntime } from "./attachment-storage-runtime";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_SECONDS = 300;

export type NoteTransferCleanupSummary = {
  complete: boolean;
  attempted: number;
  deleted: number;
  alreadyMissing: number;
  failedThisRun: number;
  cleaned: number;
  failed: number;
  pending: number;
  exhausted: number;
  retained: number;
  total: number;
};

export type NoteTransferCleanupResult = {
  operation: PreparedNoteTransferOperation;
  summary: NoteTransferCleanupSummary;
};

type StorageRuntime = ReturnType<typeof createAttachmentStorageRuntime>;
type OperationRepository = ReturnType<typeof createNoteTransferOperationRepository>;

export function createNoteTransferCleanupRuntime(
  adapter?: DatabaseAdapter,
  options: {
    storage?: StorageRuntime;
    operations?: OperationRepository;
    concurrency?: number;
    maxAttempts?: number;
    leaseSeconds?: number;
  } = {},
) {
  const operations = options.operations || createNoteTransferOperationRepository(adapter);
  const storage = options.storage || createAttachmentStorageRuntime(adapter);
  const concurrency = Math.max(1, Math.min(8, options.concurrency || DEFAULT_CONCURRENCY));
  const maxAttempts = Math.max(1, Math.min(20, options.maxAttempts || DEFAULT_MAX_ATTEMPTS));
  const leaseSeconds = Math.max(30, options.leaseSeconds || DEFAULT_LEASE_SECONDS);

  async function loadOperation(input: {
    actorUserId: string;
    idempotencyKey: string;
  }): Promise<PreparedNoteTransferOperation> {
    const operation = await operations.getPrepared(input);
    if (!operation) {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_PLAN_NOT_FOUND",
        "转移计划不存在",
        404,
      );
    }
    if (operation.status !== "cancelled" && operation.status !== "failed") {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_CLEANUP_STATE_CONFLICT",
        `当前状态 ${operation.status} 无法清理 staging 对象`,
        409,
        { operationId: operation.id, status: operation.status },
      );
    }
    return operation;
  }

  function summarize(
    operation: PreparedNoteTransferOperation,
    counters: {
      attempted: number;
      deleted: number;
      alreadyMissing: number;
      failedThisRun: number;
    },
  ): NoteTransferCleanupSummary {
    const retained = operation.stagedAttachments.filter(
      (item) => item.cleanupStatus === "retained",
    ).length;
    const cleanupRows = operation.stagedAttachments.filter(
      (item) => item.cleanupStatus !== "retained",
    );
    const cleaned = cleanupRows.filter((item) => item.cleanupStatus === "cleaned").length;
    const failedRows = cleanupRows.filter((item) => item.cleanupStatus === "failed");
    const failed = failedRows.length;
    const exhausted = failedRows.filter(
      (item) => item.cleanupAttempts >= maxAttempts,
    ).length;
    const pending = cleanupRows.length - cleaned - failed;
    return {
      complete: cleaned === cleanupRows.length,
      attempted: counters.attempted,
      deleted: counters.deleted,
      alreadyMissing: counters.alreadyMissing,
      failedThisRun: counters.failedThisRun,
      cleaned,
      failed,
      pending,
      exhausted,
      retained,
      total: cleanupRows.length,
    };
  }

  async function cleanupClaim(
    claim: Awaited<ReturnType<OperationRepository["claimNextCleanupAttachment"]>>,
  ): Promise<"deleted" | "missing" | null> {
    if (!claim) return null;
    try {
      const before = await storage.checkExists(claim.stagedPath);
      if (before.error) {
        throw new Error(`AttachmentStorageCheckError: ${before.error}`);
      }
      await storage.deleteObject(claim.stagedPath);
      const after = await storage.checkExists(claim.stagedPath);
      if (after.error) {
        throw new Error(`AttachmentStorageCheckError: ${after.error}`);
      }
      if (after.exists) {
        throw new Error("AttachmentStorageDeleteError: staging object still exists");
      }
      await operations.markCleanupComplete({
        operationId: claim.operationId,
        sourceAttachmentId: claim.sourceAttachmentId,
        cleanupLeaseToken: claim.cleanupLeaseToken,
      });
      return before.exists ? "deleted" : "missing";
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      try {
        await operations.markCleanupFailed({
          operationId: claim.operationId,
          sourceAttachmentId: claim.sourceAttachmentId,
          cleanupLeaseToken: claim.cleanupLeaseToken,
          error: message,
        });
      } catch (leaseError) {
        if (!(leaseError instanceof NoteTransferOperationError)
          || leaseError.code !== "NOTE_TRANSFER_CLEANUP_LEASE_LOST") {
          throw leaseError;
        }
      }
      return null;
    }
  }

  return {
    async resume(input: {
      actorUserId: string;
      idempotencyKey: string;
    }): Promise<NoteTransferCleanupResult> {
      await loadOperation(input);
      await operations.requeueFailedCleanup({ ...input, maxAttempts });

      const counters = {
        attempted: 0,
        deleted: 0,
        alreadyMissing: 0,
        failedThisRun: 0,
      };
      const worker = async () => {
        while (true) {
          const claim = await operations.claimNextCleanupAttachment({
            ...input,
            maxAttempts,
            leaseSeconds,
          });
          if (!claim) return;
          counters.attempted += 1;
          const cleaned = await cleanupClaim(claim);
          if (!cleaned) {
            counters.failedThisRun += 1;
            continue;
          }
          if (cleaned === "deleted") counters.deleted += 1;
          else counters.alreadyMissing += 1;
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      const operation = await loadOperation(input);
      return { operation, summary: summarize(operation, counters) };
    },
  };
}
