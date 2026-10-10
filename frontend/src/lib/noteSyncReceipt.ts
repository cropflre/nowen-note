/**
 * Per-note Sync Receipt. Metadata only: no note bodies or credentials.
 * Logical revisions are monotonic per scoped browser account/server.
 */
import { getOfflineQueueStorageKey } from "./offlineScope";

export type NoteReceiptPhase = "unverified" | "saving" | "pending" | "confirmed" | "conflict" | "error";
export interface NoteSyncReceipt {
  noteId: string;
  localRevision: number;
  acknowledgedRevision: number;
  acknowledgedVersion: number | null;
  phase: NoteReceiptPhase;
  updatedAt: number;
}
export const NOTE_SYNC_RECEIPT_CHANGED_EVENT = "nowen:note-sync-receipt-changed";
const PREFIX = "nowen-note-sync-receipts:v1:";
const MAX_RECORDS = 128;
const storageKey = () => PREFIX + getOfflineQueueStorageKey();

function readAll(): Record<string, NoteSyncReceipt> {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(storageKey()) || "{}");
    return data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, NoteSyncReceipt> : {};
  } catch { return {}; }
}
export function getNoteSyncReceipt(noteId: string): NoteSyncReceipt | null {
  const row = readAll()[noteId];
  return row && row.noteId === noteId &&
    Number.isSafeInteger(row.localRevision) && Number.isSafeInteger(row.acknowledgedRevision)
    ? row : null;
}
function mutate(noteId: string, update: (old: NoteSyncReceipt) => NoteSyncReceipt): NoteSyncReceipt {
  const all = readAll();
  const previous = getNoteSyncReceipt(noteId) || {
    noteId, localRevision: 0, acknowledgedRevision: 0,
    acknowledgedVersion: null, phase: "unverified" as const, updatedAt: 0,
  };
  const next = { ...update(previous), updatedAt: Date.now() };
  try {
    all[noteId] = next;
    const entries = Object.values(all)
      .filter((entry) => entry && typeof entry.noteId === "string")
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RECORDS);
    localStorage.setItem(storageKey(), JSON.stringify(Object.fromEntries(
      entries.map((entry) => [entry.noteId, entry]),
    )));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(NOTE_SYNC_RECEIPT_CHANGED_EVENT, {
      detail: { noteId },
    }));
  } catch {
    // No durable receipt if storage fails. Consumers re-read and stay unverified.
  }
  return next;
}
export function beginNoteReceiptWrite(noteId: string): number {
  return mutate(noteId, (old) => ({
    ...old, localRevision: old.localRevision + 1, phase: "saving",
  })).localRevision;
}
export function markNoteReceiptPending(noteId: string, revision?: number | null, conflict = false): void {
  mutate(noteId, (old) => revision != null && revision !== old.localRevision
    ? old : { ...old, phase: conflict ? "conflict" : "pending" });
}
export function markNoteReceiptError(noteId: string, revision?: number | null): void {
  mutate(noteId, (old) => revision != null && revision !== old.localRevision
    ? old : { ...old, phase: "error" });
}
/** Valid only for the exact in-flight revision, with a positive server version. */
export function acknowledgeNoteReceipt(noteId: string, revision: number, serverVersion: number): boolean {
  if (!Number.isSafeInteger(serverVersion) || serverVersion < 1) return false;
  const old = getNoteSyncReceipt(noteId);
  if (!old || old.localRevision !== revision) return false;
  mutate(noteId, (current) => current.localRevision !== revision ? current : ({
    ...current, acknowledgedRevision: revision,
    acknowledgedVersion: serverVersion, phase: "confirmed",
  }));
  return true;
}
export interface NoteReceiptQueueEntry {
  noteId: string;
  conflict?: boolean;
  blocked?: boolean;
  errorCode?: string;
}
export function resolveNoteReceiptPhase(
  receipt: NoteSyncReceipt | null,
  queue: readonly NoteReceiptQueueEntry[],
): NoteReceiptPhase {
  if (queue.some((item) => item.conflict || item.errorCode === "VERSION_CONFLICT")) return "conflict";
  if (queue.some((item) => item.blocked || item.errorCode)) return "error";
  if (queue.length) return "pending";
  if (!receipt) return "unverified";
  // A crashed/incomplete save is never proof of local durability or remote ACK.
  if (receipt.phase === "saving") return "unverified";
  if (receipt.phase === "confirmed" && receipt.acknowledgedRevision === receipt.localRevision &&
      receipt.acknowledgedVersion !== null) return "confirmed";
  if (receipt.phase === "pending" || receipt.phase === "conflict" || receipt.phase === "error")
    return receipt.phase;
  return "unverified";
}
