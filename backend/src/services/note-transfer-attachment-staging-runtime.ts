import type { DatabaseAdapter } from "../db/adapters/types";
import {
  createNoteTransferOperationRepository,
  NoteTransferOperationError,
  type PreparedNoteTransferOperation,
} from "../repositories/noteTransferOperationRepository";
import {
  createAttachmentStorageRuntime,
  type AttachmentStageCopyResult,
} from "./attachment-storage-runtime";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_SECONDS = 300;

export type NoteTransferAttachmentStagingSummary = {
  complete: boolean;
  attempted: number;
  copied: number;
  reusedObjects: number;
  failedThisRun: number;
  staged: number;
  failed: number;
  pending: number;
  exhausted: number;
  total: number;
};

export type NoteTransferAttachmentStagingResult = {
  operation: PreparedNoteTransferOperation;
  summary: NoteTransferAttachmentStagingSummary;
};

type StorageRuntime = ReturnType<typeof createAttachmentStorageRuntime>;
type OperationRepository = ReturnType<typeof createNoteTransferOperationRepository>;

export function createNoteTransferAttachmentStagingRuntime(
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
    if (operation.status !== "staging") {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_STATE_CONFLICT",
        `当前状态 ${operation.status} 无法复制 staging 附件`,
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
      copied: number;
      reusedObjects: number;
      failedThisRun: number;
    },
  ): NoteTransferAttachmentStagingSummary {
    const total = operation.stagedAttachments.length;
    const staged = operation.stagedAttachments.filter((item) => item.status === "staged").length;
    const failedRows = operation.stagedAttachments.filter((item) => item.status === "failed");
    const failed = failedRows.length;
    const exhausted = failedRows.filter((item) => item.attempts >= maxAttempts).length;
    const pending = total - staged - failed;
    return {
      complete: staged === total,
      attempted: counters.attempted,
      copied: counters.copied,
      reusedObjects: counters.reusedObjects,
      failedThisRun: counters.failedThisRun,
      staged,
      failed,
      pending,
      exhausted,
      total,
    };
  }

  async function stageClaim(claim: Awaited<ReturnType<OperationRepository["claimNextStagedAttachment"]>>): Promise<AttachmentStageCopyResult | null> {
    if (!claim) return null;
    try {
      const copied = await storage.copyAndVerify({
        sourcePath: claim.sourcePath,
        stagedPath: claim.stagedPath,
        expectedSize: claim.size,
        expectedHash: claim.hash,
      });
      await operations.markStagedAttachmentComplete({
        operationId: claim.operationId,
        sourceAttachmentId: claim.sourceAttachmentId,
        leaseToken: claim.leaseToken,
        verifiedSize: copied.size,
        verifiedHash: copied.sha256,
      });
      return copied;
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      try {
        await operations.markStagedAttachmentFailed({
          operationId: claim.operationId,
          sourceAttachmentId: claim.sourceAttachmentId,
          leaseToken: claim.leaseToken,
          error: message,
        });
      } catch (leaseError) {
        if (!(leaseError instanceof NoteTransferOperationError)
          || leaseError.code !== "NOTE_TRANSFER_STAGING_LEASE_LOST") {
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
    }): Promise<NoteTransferAttachmentStagingResult> {
      await loadOperation(input);
      await operations.requeueFailedStagedAttachments({
        ...input,
        maxAttempts,
      });

      const counters = {
        attempted: 0,
        copied: 0,
        reusedObjects: 0,
        failedThisRun: 0,
      };

      const worker = async () => {
        while (true) {
          const claim = await operations.claimNextStagedAttachment({
            ...input,
            maxAttempts,
            leaseSeconds,
          });
          if (!claim) return;
          counters.attempted += 1;
          const copied = await stageClaim(claim);
          if (!copied) {
            counters.failedThisRun += 1;
            continue;
          }
          counters.copied += 1;
          if (copied.reused) counters.reusedObjects += 1;
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      const operation = await loadOperation(input);
      return { operation, summary: summarize(operation, counters) };
    },
  };
}
