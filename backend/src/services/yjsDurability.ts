import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { noteVersionsRepository, noteYupdatesRepository } from "../repositories";
import { yApplyUpdate, yDestroyDoc, yFlush, type YApplyResult } from "./yjs";

export type DurableYApplyFailureCode =
  | Exclude<YApplyResult, "ok">
  | "persist_failed"
  | "invalid_operation"
  | "operation_conflict";

export type DurableYApplyResult =
  | {
      ok: true;
      updateId: number;
      persistedAt: string;
      duplicate: boolean;
    }
  | {
      ok: false;
      code: DurableYApplyFailureCode;
    };

const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
const CHECKPOINT_DELAY_MS = 2_000;
const OPERATION_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const OPERATION_RECEIPT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_OPERATION_ID_LENGTH = 128;
const checkpointTimers = new Map<string, NodeJS.Timeout>();
let lastReceiptPruneAt = 0;

function hashUpdateBase64(updateBase64: string): string {
  return createHash("sha256").update(Buffer.from(updateBase64, "base64")).digest("hex");
}

function maybePruneOperationReceipts(now = Date.now()): void {
  if (now - lastReceiptPruneAt < OPERATION_RECEIPT_PRUNE_INTERVAL_MS) return;
  lastReceiptPruneAt = now;
  try {
    noteYupdatesRepository.deleteOperationReceiptsBefore(
      new Date(now - OPERATION_RECEIPT_RETENTION_MS).toISOString(),
    );
  } catch (error) {
    console.warn("[yjs-durability] operation receipt prune failed:", error);
  }
}

function failClosed(noteId: string, code: DurableYApplyFailureCode): DurableYApplyResult {
  try { yDestroyDoc(noteId); } catch {}
  return { ok: false, code };
}

/**
 * Applies an update and proves that both the append-only recovery log and the
 * operation receipt are durable before ACK. A repeated operationId returns the
 * original receipt without appending another update. Reusing an operationId for
 * different bytes is rejected fail-closed so content can never be silently dropped.
 */
export function yApplyUpdateDurably(
  noteId: string,
  updateBase64: string,
  userId: string | null,
  operationId: string | null = null,
): DurableYApplyResult {
  const normalizedOperationId = operationId?.trim() || null;
  if (normalizedOperationId && normalizedOperationId.length > MAX_OPERATION_ID_LENGTH) {
    return { ok: false, code: "invalid_operation" };
  }

  const incomingHash = normalizedOperationId ? hashUpdateBase64(updateBase64) : null;
  if (normalizedOperationId && incomingHash) {
    const existing = noteYupdatesRepository.findOperationReceipt(noteId, normalizedOperationId);
    if (existing) {
      if (existing.updateHash !== incomingHash) {
        return { ok: false, code: "operation_conflict" };
      }
      scheduleYjsRecoveryCheckpoint(noteId, userId);
      maybePruneOperationReceipts();
      return {
        ok: true,
        updateId: existing.updateId,
        persistedAt: existing.persistedAt,
        duplicate: true,
      };
    }
  }

  const before = noteYupdatesRepository.getMaxId(noteId)?.maxId || 0;
  const result = yApplyUpdate(noteId, updateBase64, userId, normalizedOperationId);
  if (result !== "ok") return { ok: false, code: result };

  const after = noteYupdatesRepository.getMaxId(noteId)?.maxId || 0;
  if (normalizedOperationId && incomingHash) {
    const receipt = noteYupdatesRepository.findOperationReceipt(noteId, normalizedOperationId);
    if (!receipt) {
      console.error(`[yjs-durability] operation receipt missing for ${noteId}/${normalizedOperationId}`);
      return failClosed(noteId, "persist_failed");
    }
    if (receipt.updateHash !== incomingHash) {
      console.error(`[yjs-durability] operation hash conflict for ${noteId}/${normalizedOperationId}`);
      return failClosed(noteId, "operation_conflict");
    }

    scheduleYjsRecoveryCheckpoint(noteId, userId);
    maybePruneOperationReceipts();
    return {
      ok: true,
      updateId: receipt.updateId,
      persistedAt: receipt.persistedAt,
      duplicate: receipt.updateId <= before,
    };
  }

  if (after <= before) {
    console.error(`[yjs-durability] update log did not advance for ${noteId}`);
    return failClosed(noteId, "persist_failed");
  }

  scheduleYjsRecoveryCheckpoint(noteId, userId);
  maybePruneOperationReceipts();
  return {
    ok: true,
    updateId: after,
    persistedAt: new Date().toISOString(),
    duplicate: false,
  };
}

/**
 * Creates a recoverable Markdown snapshot at most once per five minutes.
 * The first update starts a short checkpoint timer; later keystrokes do not reset
 * that timer. Otherwise continuous typing could postpone Version History forever.
 * The append-only Yjs update log remains the immediate durability boundary.
 */
export function scheduleYjsRecoveryCheckpoint(noteId: string, userId: string | null): void {
  if (checkpointTimers.has(noteId)) return;

  const timer = setTimeout(() => {
    checkpointTimers.delete(noteId);
    try {
      yFlush(noteId);

      const lastEdit = noteVersionsRepository.getLastEditByNoteId(noteId);
      if (lastEdit) {
        const lastTs = new Date(lastEdit.createdAt).getTime();
        if (!Number.isNaN(lastTs) && Date.now() - lastTs < CHECKPOINT_INTERVAL_MS) return;
      }

      const db = getDb();
      const note = db.prepare(
        `SELECT id, userId, title, content, contentText, contentFormat, version
         FROM notes WHERE id = ?`,
      ).get(noteId) as
        | {
            id: string;
            userId: string;
            title: string;
            content: string;
            contentText: string;
            contentFormat: string;
            version: number;
          }
        | undefined;
      if (!note) return;

      const duplicate = db.prepare(
        `SELECT id FROM note_versions WHERE "noteId" = ? AND version = ? LIMIT 1`,
      ).get(noteId, note.version) as { id: string } | undefined;
      if (duplicate) return;

      noteVersionsRepository.create({
        id: uuid(),
        noteId,
        userId: userId || note.userId,
        title: note.title,
        content: note.content,
        contentText: note.contentText,
        contentFormat: note.contentFormat || "markdown",
        version: note.version,
        changeType: "edit",
        changeSummary: "Markdown collaborative autosave checkpoint",
      });
    } catch (error) {
      // The Yjs update log is already durable; checkpoint failure must not turn a
      // confirmed save into a false failure, but it must remain observable.
      console.warn(`[yjs-durability] checkpoint failed for ${noteId}:`, error);
    }
  }, CHECKPOINT_DELAY_MS);

  timer.unref?.();
  checkpointTimers.set(noteId, timer);
}
