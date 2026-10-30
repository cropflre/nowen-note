import { getOfflineQueueStorageKey } from "../offlineScope";
import { ConversionCleanupError } from "./conversionCoordination";
import { validateEnvelopeV2 } from "./envelopeV2";
import { validateHistoryV2 } from "./attachmentCodec";

export const CONVERSION_PENDING_EVENT = "nowen:encrypted-conversion-pending";
const prefix = (scope: string) => `nowen-encryption-pending:v1:${encodeURIComponent(scope)}:`;
const key = (noteId: string, scope: string) => `${prefix(scope)}${encodeURIComponent(noteId)}`;
export interface PendingConversion {
  noteId: string; userId: string; sourceVersion: number; title: string;
  content: string; encryptedHistory: Array<{ id: string; content: string }>;
}
export function readPendingConversion(noteId: string, scope = getOfflineQueueStorageKey()): PendingConversion | null {
  try {
    const raw = localStorage.getItem(key(noteId, scope));
    if (raw === null) return null;
    const pending = JSON.parse(raw) as PendingConversion;
    if (pending.noteId !== noteId || !pending.userId || !Number.isSafeInteger(pending.sourceVersion) || pending.sourceVersion < 1
      || typeof pending.title !== "string" || !Array.isArray(pending.encryptedHistory)) throw new Error();
    if (validateEnvelopeV2(JSON.parse(pending.content)).kind !== "note") throw new Error();
    for (const row of pending.encryptedHistory) if (validateHistoryV2(JSON.parse(row.content)).historyId !== row.id) throw new Error();
    return pending;
  } catch { throw new ConversionCleanupError("storage_failed"); }
}
export function firstPendingConversion(scope = getOfflineQueueStorageKey()): PendingConversion | null {
  for (let index = 0; index < localStorage.length; index++) {
    const storageKey = localStorage.key(index)!;
    if (storageKey.startsWith(prefix(scope))) return readPendingConversion(decodeURIComponent(storageKey.slice(prefix(scope).length)), scope);
  }
  return null;
}
/** Persist only ciphertext and visible metadata before submitting. Quota failure blocks submission. */
export function storePendingConversion(pending: PendingConversion, scope: string): void {
  try {
    localStorage.setItem(key(pending.noteId, scope), JSON.stringify(pending));
    if (JSON.stringify(readPendingConversion(pending.noteId, scope)) !== JSON.stringify(pending)) throw new Error();
    window.dispatchEvent(new CustomEvent(CONVERSION_PENDING_EVENT, { detail: { noteId: pending.noteId, scope } }));
  } catch { throw new ConversionCleanupError("storage_failed"); }
}
export function clearPendingConversion(noteId: string, scope: string): void {
  localStorage.removeItem(key(noteId, scope));
  if (localStorage.getItem(key(noteId, scope)) !== null) throw new ConversionCleanupError("storage_failed");
}
