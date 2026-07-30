import * as Y from "yjs";

import type { DatabaseAdapter } from "../db/adapters/types";

interface CandidateRow {
  noteId: string;
  pendingUpdates: number;
  maxUpdateId: number;
}

interface SnapshotRow {
  snapshotBlob: unknown;
  updatesMergedTo: number;
}

interface UpdateRow {
  id: number;
  updateBlob: unknown;
  clock: number;
}

interface NoteRow {
  content: string | null;
  contentText: string | null;
  contentFormat: string | null;
  version: number;
}

export interface PostgresYjsCompactionRuntimeOptions {
  intervalMs?: number;
  minUpdates?: number;
  gcSafetyMargin?: number;
  maxNotesPerRun?: number;
}

export interface PostgresYjsCompactionRunResult {
  scannedNotes: number;
  compactedNotes: number;
  deletedUpdates: number;
  blockedNotes: number;
  failures: number;
}

export interface PostgresYjsCompactionRuntime {
  start(): void;
  runOnce(): Promise<PostgresYjsCompactionRunResult>;
  close(): Promise<void>;
  getStats(): {
    running: boolean;
    scheduled: boolean;
    runs: number;
    compactedNotes: number;
    deletedUpdates: number;
    blockedNotes: number;
    failures: number;
    lastRunAt: string | null;
    lastError: string | null;
  };
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MIN_UPDATES = 100;
const DEFAULT_GC_SAFETY_MARGIN = 50;
const DEFAULT_MAX_NOTES_PER_RUN = 25;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Stored Yjs binary is invalid");
}

function inferMarkdown(note: NoteRow): string {
  const content = note.content || "";
  const trimmed = content.trim();
  if ((note.contentFormat || "markdown") === "tiptap-json") return note.contentText || "";
  if (trimmed.startsWith("{") && /"type"\s*:/u.test(trimmed)) return note.contentText || "";
  return content || note.contentText || "";
}

export function createPostgresYjsCompactionRuntime(
  adapter: DatabaseAdapter,
  options: PostgresYjsCompactionRuntimeOptions = {},
): PostgresYjsCompactionRuntime {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const minUpdates = Math.max(1, options.minUpdates ?? DEFAULT_MIN_UPDATES);
  const gcSafetyMargin = Math.max(0, options.gcSafetyMargin ?? DEFAULT_GC_SAFETY_MARGIN);
  const maxNotesPerRun = Math.max(1, options.maxNotesPerRun ?? DEFAULT_MAX_NOTES_PER_RUN);

  let timer: NodeJS.Timeout | null = null;
  let activeRun: Promise<PostgresYjsCompactionRunResult> | null = null;
  let closed = false;
  const totals = {
    runs: 0,
    compactedNotes: 0,
    deletedUpdates: 0,
    blockedNotes: 0,
    failures: 0,
    lastRunAt: null as string | null,
    lastError: null as string | null,
  };

  async function compactCandidate(candidate: CandidateRow): Promise<{
    compacted: boolean;
    deletedUpdates: number;
    blocked: boolean;
  }> {
    const noteId = candidate.noteId;
    const snapshot = await adapter.queryOne<SnapshotRow>(
      `SELECT snapshot_blob AS "snapshotBlob", "updatesMergedTo" AS "updatesMergedTo"
         FROM note_ysnapshots WHERE "noteId" = ?`,
      [noteId],
    );
    const mergedTo = Number(snapshot?.updatesMergedTo) || 0;
    const targetUpdateId = Number(candidate.maxUpdateId) || 0;
    if (targetUpdateId <= mergedTo) return { compacted: false, deletedUpdates: 0, blocked: false };

    const note = await adapter.queryOne<NoteRow>(
      `SELECT content, "contentText" AS "contentText", "contentFormat" AS "contentFormat", version
         FROM notes WHERE id = ?`,
      [noteId],
    );
    if (!note || (note.contentFormat || "markdown") !== "markdown") {
      return { compacted: false, deletedUpdates: 0, blocked: true };
    }

    const updates = await adapter.queryMany<UpdateRow>(
      `SELECT id, update_blob AS "updateBlob", clock
         FROM note_yupdates
        WHERE "noteId" = ? AND id > ? AND id <= ?
        ORDER BY id ASC`,
      [noteId, mergedTo, targetUpdateId],
    );
    if (updates.length === 0 || updates[updates.length - 1]?.id !== targetUpdateId) {
      return { compacted: false, deletedUpdates: 0, blocked: true };
    }

    const targetClock = Number(updates[updates.length - 1]?.clock) || 0;
    if (Number(note.version) !== targetClock) {
      return { compacted: false, deletedUpdates: 0, blocked: false };
    }

    const doc = new Y.Doc();
    try {
      if (snapshot) {
        try {
          Y.applyUpdate(doc, toUint8Array(snapshot.snapshotBlob));
        } catch {
          return { compacted: false, deletedUpdates: 0, blocked: true };
        }
      }

      try {
        for (const update of updates) Y.applyUpdate(doc, toUint8Array(update.updateBlob));
      } catch {
        return { compacted: false, deletedUpdates: 0, blocked: true };
      }

      const expectedMarkdown = inferMarkdown(note);
      let markdown = doc.getText("content").toString();
      if (!snapshot && markdown !== expectedMarkdown) {
        doc.destroy();
        const bootstrap = new Y.Doc();
        try {
          if (expectedMarkdown) bootstrap.getText("content").insert(0, expectedMarkdown);
          const current = await adapter.queryOne<NoteRow>(
            `SELECT content, "contentText" AS "contentText", "contentFormat" AS "contentFormat", version
               FROM notes WHERE id = ?`,
            [noteId],
          );
          if (!current || Number(current.version) !== targetClock || inferMarkdown(current) !== expectedMarkdown) {
            return { compacted: false, deletedUpdates: 0, blocked: false };
          }
          const state = Y.encodeStateAsUpdate(bootstrap);
          await adapter.execute(
            `INSERT INTO note_ysnapshots ("noteId", snapshot_blob, "updatesMergedTo", "updatedAt")
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT ("noteId") DO UPDATE SET
               snapshot_blob = EXCLUDED.snapshot_blob,
               "updatesMergedTo" = EXCLUDED."updatesMergedTo",
               "updatedAt" = CURRENT_TIMESTAMP
             WHERE note_ysnapshots."updatesMergedTo" <= EXCLUDED."updatesMergedTo"`,
            [noteId, Buffer.from(state), targetUpdateId],
          );
        } finally {
          bootstrap.destroy();
        }
      } else {
        if (markdown !== expectedMarkdown) {
          return { compacted: false, deletedUpdates: 0, blocked: true };
        }
        const current = await adapter.queryOne<NoteRow>(
          `SELECT content, "contentText" AS "contentText", "contentFormat" AS "contentFormat", version
             FROM notes WHERE id = ?`,
          [noteId],
        );
        if (!current || Number(current.version) !== targetClock || inferMarkdown(current) !== markdown) {
          return { compacted: false, deletedUpdates: 0, blocked: false };
        }
        const state = Y.encodeStateAsUpdate(doc);
        await adapter.execute(
          `INSERT INTO note_ysnapshots ("noteId", snapshot_blob, "updatesMergedTo", "updatedAt")
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT ("noteId") DO UPDATE SET
             snapshot_blob = EXCLUDED.snapshot_blob,
             "updatesMergedTo" = EXCLUDED."updatesMergedTo",
             "updatedAt" = CURRENT_TIMESTAMP
           WHERE note_ysnapshots."updatesMergedTo" <= EXCLUDED."updatesMergedTo"`,
          [noteId, Buffer.from(state), targetUpdateId],
        );
      }

      const persisted = await adapter.queryOne<{ updatesMergedTo: number }>(
        `SELECT "updatesMergedTo" AS "updatesMergedTo" FROM note_ysnapshots WHERE "noteId" = ?`,
        [noteId],
      );
      const persistedWatermark = Number(persisted?.updatesMergedTo) || 0;
      if (persistedWatermark < targetUpdateId) {
        return { compacted: false, deletedUpdates: 0, blocked: false };
      }

      let deletedUpdates = 0;
      if (gcSafetyMargin >= 0) {
        const cutoff = await adapter.queryOne<{ id: number }>(
          `SELECT id
             FROM note_yupdates
            WHERE "noteId" = ? AND id <= ?
            ORDER BY id DESC
            OFFSET ? LIMIT 1`,
          [noteId, persistedWatermark, gcSafetyMargin],
        );
        if (cutoff?.id) {
          const deleted = await adapter.execute(
            `DELETE FROM note_yupdates
              WHERE "noteId" = ? AND id <= ?
                AND id <= (SELECT "updatesMergedTo" FROM note_ysnapshots WHERE "noteId" = ?)`,
            [noteId, cutoff.id, noteId],
          );
          deletedUpdates = deleted.changes;
        }
      }

      return { compacted: true, deletedUpdates, blocked: false };
    } finally {
      if (!doc.isDestroyed) doc.destroy();
    }
  }

  async function executeRun(): Promise<PostgresYjsCompactionRunResult> {
    const result: PostgresYjsCompactionRunResult = {
      scannedNotes: 0,
      compactedNotes: 0,
      deletedUpdates: 0,
      blockedNotes: 0,
      failures: 0,
    };
    try {
      const candidates = await adapter.queryMany<CandidateRow>(
        `SELECT u."noteId" AS "noteId",
                COUNT(*)::int AS "pendingUpdates",
                MAX(u.id)::int AS "maxUpdateId"
           FROM note_yupdates u
           LEFT JOIN note_ysnapshots s ON s."noteId" = u."noteId"
          WHERE u.id > COALESCE(s."updatesMergedTo", 0)
          GROUP BY u."noteId"
         HAVING COUNT(*) >= ?
          ORDER BY COUNT(*) DESC, u."noteId" ASC
          LIMIT ?`,
        [minUpdates, maxNotesPerRun],
      );
      result.scannedNotes = candidates.length;
      for (const candidate of candidates) {
        try {
          const compacted = await compactCandidate(candidate);
          if (compacted.compacted) result.compactedNotes += 1;
          if (compacted.blocked) result.blockedNotes += 1;
          result.deletedUpdates += compacted.deletedUpdates;
        } catch (error) {
          result.failures += 1;
          totals.lastError = `${candidate.noteId}: ${errorMessage(error)}`;
          console.warn("[postgres-yjs-compaction] candidate failed:", candidate.noteId, errorMessage(error));
        }
      }
    } catch (error) {
      result.failures += 1;
      totals.lastError = errorMessage(error);
      console.warn("[postgres-yjs-compaction] scan failed:", errorMessage(error));
    }

    totals.runs += 1;
    totals.compactedNotes += result.compactedNotes;
    totals.deletedUpdates += result.deletedUpdates;
    totals.blockedNotes += result.blockedNotes;
    totals.failures += result.failures;
    totals.lastRunAt = new Date().toISOString();
    if (result.failures === 0) totals.lastError = null;
    return result;
  }

  function runOnce(): Promise<PostgresYjsCompactionRunResult> {
    if (closed) return Promise.resolve({ scannedNotes: 0, compactedNotes: 0, deletedUpdates: 0, blockedNotes: 0, failures: 0 });
    if (activeRun) return activeRun;
    activeRun = executeRun().finally(() => {
      activeRun = null;
    });
    return activeRun;
  }

  function start(): void {
    if (closed || timer) return;
    timer = setInterval(() => { void runOnce(); }, intervalMs);
    timer.unref?.();
    void runOnce();
  }

  async function close(): Promise<void> {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (activeRun) await activeRun;
  }

  function getStats() {
    return {
      running: Boolean(activeRun),
      scheduled: Boolean(timer),
      ...totals,
    };
  }

  return { start, runOnce, close, getStats };
}

export default createPostgresYjsCompactionRuntime;
