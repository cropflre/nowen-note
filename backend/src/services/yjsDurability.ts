import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { noteVersionsRepository, noteYupdatesRepository } from "../repositories";
import { yApplyUpdate, yFlush, type YApplyResult } from "./yjs";

export type DurableYApplyFailureCode = Exclude<YApplyResult, "ok"> | "persist_failed";

export type DurableYApplyResult =
  | {
      ok: true;
      updateId: number;
      persistedAt: string;
    }
  | {
      ok: false;
      code: DurableYApplyFailureCode;
    };

const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
const CHECKPOINT_DEBOUNCE_MS = 2_000;
const checkpointTimers = new Map<string, NodeJS.Timeout>();

/**
 * yApplyUpdate historically returned "ok" even when note_yupdates INSERT failed.
 * This wrapper verifies that the append-only recovery log actually advanced before
 * the realtime layer is allowed to send y:ack or broadcast the update.
 *
 * The three DB reads/writes are synchronous, so no other update can interleave
 * between max-id-before, yApplyUpdate and max-id-after in this Node process.
 */
export function yApplyUpdateDurably(
  noteId: string,
  updateBase64: string,
  userId: string | null,
): DurableYApplyResult {
  const before = noteYupdatesRepository.getMaxId(noteId)?.maxId || 0;
  const result = yApplyUpdate(noteId, updateBase64, userId);
  if (result !== "ok") return { ok: false, code: result };

  const after = noteYupdatesRepository.getMaxId(noteId)?.maxId || 0;
  if (after <= before) {
    console.error(`[yjs-durability] update log did not advance for ${noteId}`);
    return { ok: false, code: "persist_failed" };
  }

  const persistedAt = new Date().toISOString();
  scheduleYjsRecoveryCheckpoint(noteId, userId);
  return { ok: true, updateId: after, persistedAt };
}

/**
 * Creates a recoverable Markdown snapshot at most once per five minutes.
 * The append-only Yjs update log remains the immediate durability boundary;
 * this checkpoint makes the existing Version History UI useful for long-form
 * Markdown editing as an additional recovery layer.
 */
export function scheduleYjsRecoveryCheckpoint(noteId: string, userId: string | null): void {
  const existingTimer = checkpointTimers.get(noteId);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    checkpointTimers.delete(noteId);
    try {
      // Flush the active room projection before reading the snapshot.
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
  }, CHECKPOINT_DEBOUNCE_MS);

  timer.unref?.();
  checkpointTimers.set(noteId, timer);
}
