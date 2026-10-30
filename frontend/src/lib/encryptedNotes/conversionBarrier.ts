import { getOfflineQueueStorageKey } from "../offlineScope";
import { CONVERSION_REPLAY_LOCK, conversionLockName, ConversionCleanupError } from "./conversionCoordination";
import { readEncryptedNoteEnvelope } from "./noteDocument";
import { readPendingConversion, CONVERSION_PENDING_EVENT } from "./conversionPending";
const supportedFormat = (format: unknown) => format === "encrypted-note-v1" || format === "encrypted-note-v2";

export const CONVERSION_INVALIDATED_EVENT = "nowen:encrypted-conversion-invalidated";
const PREFIX = "nowen-encrypted-converted:v1:";
const markerKey = (scope: string, noteId: string) => `${PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(noteId)}`;

/** Metadata only. Retained on partial cleanup failure to prevent late plaintext writes. */
export function convertedNoteVersion(noteId: string, scope = getOfflineQueueStorageKey()): number | null {
  try {
    const raw = localStorage.getItem(markerKey(scope, noteId));
    if (raw === null) {
      const pending = readPendingConversion(noteId, scope);
      return pending ? pending.sourceVersion + 1 : null;
    }
    const version: unknown = JSON.parse(raw);
    if (!Number.isSafeInteger(version) || (version as number) < 1) throw new Error();
    return version as number;
  } catch { throw new ConversionCleanupError("storage_failed"); }
}

/** Call only after authenticated server confirmation, inside the exclusive cleanup lease. */
export function markConvertedNote(noteId: string, version: number, scope: string): void {
  try {
    const previous = convertedNoteVersion(noteId, scope);
    localStorage.setItem(markerKey(scope, noteId), JSON.stringify(Math.max(previous ?? 0, version)));
    if (convertedNoteVersion(noteId, scope) !== Math.max(previous ?? 0, version)) throw new Error();
  } catch { throw new ConversionCleanupError("storage_failed"); }
  window.dispatchEvent(new CustomEvent(CONVERSION_INVALIDATED_EVENT, { detail: { noteId, scope } }));
}

/** Call only after the owner endpoint confirms the exact plaintext target, under its lease. */
export function clearDecryptedNoteBarrier(noteId: string, version: number, scope: string): void {
  if (scope !== getOfflineQueueStorageKey() || readPendingConversion(noteId, scope)) throw new ConversionCleanupError("scope_changed");
  const previous = convertedNoteVersion(noteId, scope);
  if (previous !== null && version <= previous) throw new ConversionCleanupError("not_committed");
  try {
    localStorage.removeItem(markerKey(scope, noteId));
    if (convertedNoteVersion(noteId, scope) !== null) throw new Error();
  } catch { throw new ConversionCleanupError("storage_failed"); }
}

type NoteCopy = { id: string; version?: number; contentFormat?: string; content?: string; contentText?: string };
/** A list placeholder can contain no body; a detail must contain a valid note envelope. */
export function assertConversionNote(note: NoteCopy, scope = getOfflineQueueStorageKey()): void {
  const version = convertedNoteVersion(note.id, scope);
  if (version === null) return;
  if ((note.version ?? 0) < version || !supportedFormat(note.contentFormat) || (note.contentText ?? "") !== "") {
    throw new ConversionCleanupError("converted_note");
  }
  if (note.content) {
    try { readEncryptedNoteEnvelope({ content: note.content, contentFormat: note.contentFormat }); }
    catch { throw new ConversionCleanupError("converted_note"); }
  }
}

export function isConversionNoteSafe(note: NoteCopy): boolean {
  try { assertConversionNote(note); return true; } catch { return false; }
}

/** Tabs and load summaries contain metadata, never bodies or a revision. */
export function isConversionMetadataSafe(note: { id: string; contentFormat?: string }): boolean {
  try { return convertedNoteVersion(note.id) === null || supportedFormat(note.contentFormat); }
  catch { return false; }
}

export function assertConversionMutation(noteId: string, body: Record<string, unknown> | null | undefined, scope = getOfflineQueueStorageKey()): void {
  if (convertedNoteVersion(noteId, scope) === null || !body) return;
  if (body.contentFormat !== undefined && !supportedFormat(body.contentFormat)
    || body.contentText !== undefined && body.contentText !== "") throw new ConversionCleanupError("converted_note");
  if (body.content !== undefined) {
    try { readEncryptedNoteEnvelope({ content: body.content as string, contentFormat: body.contentFormat as string }); }
    catch { throw new ConversionCleanupError("converted_note"); }
  }
}

export function assertConversionAttachments(noteId: string, scope = getOfflineQueueStorageKey()): void {
  if (convertedNoteVersion(noteId, scope) !== null) throw new ConversionCleanupError("converted_note");
}

/** Scope check spans the operation. Cleanup cannot overlap any registered cache writer. */
export async function withConversionWriteLease<T>(operation: (assertScope: () => void, scope: string) => Promise<T>): Promise<T> {
  const scope = getOfflineQueueStorageKey();
  const assertScope = () => {
    if (scope !== getOfflineQueueStorageKey()) throw new ConversionCleanupError("scope_changed");
  };
  const run = async () => {
    assertScope();
    const result = await operation(assertScope, scope);
    assertScope();
    return result;
  };
  if (!navigator.locks?.request) return run(); // Cleanup itself refuses unsupported browsers.
  return navigator.locks.request(CONVERSION_REPLAY_LOCK, { mode: "shared", ifAvailable: true }, (lock) => {
    if (!lock) throw new ConversionCleanupError("busy");
    return run();
  });
}

/** Covers fetch, response parsing and outgoing payloads; never enqueue a barrier failure. */
export async function withConversionRequestLease<T>(noteId: string, body: Record<string, unknown> | null, operation: () => Promise<T>): Promise<T> {
  const scope = getOfflineQueueStorageKey();
  const run = async () => {
    if (scope !== getOfflineQueueStorageKey()) throw new ConversionCleanupError("scope_changed");
    assertConversionMutation(noteId, body, scope);
    const result = await operation();
    if (scope !== getOfflineQueueStorageKey()) throw new ConversionCleanupError("scope_changed");
    if (result && typeof result === "object" && "id" in result && "contentFormat" in result) {
      assertConversionNote(result as NoteCopy, scope);
    }
    return result;
  };
  if (!navigator.locks?.request) return run();
  return navigator.locks.request(conversionLockName(noteId), { mode: "shared", ifAvailable: true }, (lock) => {
    if (!lock) throw new ConversionCleanupError("busy");
    return run();
  });
}

/** Same-window confirmation and other windows' persistent markers use the same invalidation. */
export function subscribeConversionInvalidation(invalidate: (noteId: string) => void): () => void {
  const notify = (noteId: string, scope: string) => {
    if (scope === getOfflineQueueStorageKey() && convertedNoteVersion(noteId, scope) !== null) invalidate(noteId);
  };
  const local = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (typeof detail?.noteId === "string" && typeof detail?.scope === "string") notify(detail.noteId, detail.scope);
  };
  const storage = (event: StorageEvent) => {
    const prefix = `${PREFIX}${encodeURIComponent(getOfflineQueueStorageKey())}:`;
    const pendingPrefix = `nowen-encryption-pending:v1:${encodeURIComponent(getOfflineQueueStorageKey())}:`;
    const matched = event.key?.startsWith(prefix) ? prefix : event.key?.startsWith(pendingPrefix) ? pendingPrefix : null;
    if (matched && event.key && event.newValue !== null) {
      try { notify(decodeURIComponent(event.key.slice(matched.length)), getOfflineQueueStorageKey()); }
      catch { /* malformed storage event cannot publish note content */ }
    }
  };
  window.addEventListener(CONVERSION_INVALIDATED_EVENT, local);
  window.addEventListener(CONVERSION_PENDING_EVENT, local);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(CONVERSION_INVALIDATED_EVENT, local); window.removeEventListener(CONVERSION_PENDING_EVENT, local); window.removeEventListener("storage", storage); };
}
