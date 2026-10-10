import { clearDraftForEncryptionConversion, inspectDraftIndexForEncryptionConversion } from "../draftStorage";
import { clearCachedNoteForEncryptionConversion, getCurrentUserId, inspectCachedNotePresence } from "../localStore";
import { getOfflineQueueStorageKey, isOfflineQueueFlushing } from "../offlineQueue";
import { getYjsPersistenceName } from "../yjsProvider";
import { markConvertedNote } from "./conversionBarrier";
import { readEncryptedNoteDocument } from "./noteDocument";
import { ConversionCleanupError, withConversionCleanupLease } from "./conversionCoordination";

interface CommittedEncryptedNote {
  id: string; userId: string; version: number; content: string; contentText: string; contentFormat: string;
}
export interface ConversionCleanupInput {
  noteId: string;
  userId: string;
  version: number;
  content: string;
  discardLocalCopies: true;
}

function assertNoPendingWrites(noteId: string, queueKey: string): void {
  if (isOfflineQueueFlushing()) throw new ConversionCleanupError("pending_writes");
  for (const key of [queueKey, "nowen-offline-queue"]) {
    const raw = localStorage.getItem(key);
    const queue: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(queue) || queue.some((item) => !item || typeof item.noteId !== "string")) {
      throw new ConversionCleanupError("storage_failed");
    }
    // A queued write may be newer than the converted source. Never discard it.
    if (queue.some((item) => item.noteId === noteId)) throw new ConversionCleanupError("pending_writes");
  }
}

function deleteCollaborationDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new ConversionCleanupError("storage_failed"));
    // A blocked delete cannot be cancelled. Keep the lease until it settles,
    // rather than timing out and allowing a later delete to race a new editor.
  });
}

/** Internal post-commit primitive; not a conversion API or a physical erasure claim.
 * loadCommitted must be an authenticated, uncached server read, never offline fallback.
 */
export async function cleanupConvertedNoteCopies(
  input: ConversionCleanupInput,
  loadCommitted: () => Promise<CommittedEncryptedNote>,
) {
  if (input.discardLocalCopies !== true || !input.noteId || !input.userId || !Number.isSafeInteger(input.version) || input.version < 1) {
    throw new ConversionCleanupError("invalid_consent");
  }
  let queueKey: string; let token: string | null; let server: string | null;
  try {
    queueKey = getOfflineQueueStorageKey();
    token = localStorage.getItem("nowen-token");
    server = localStorage.getItem("nowen-server-url");
  } catch { throw new ConversionCleanupError("storage_failed"); }
  let invalidated = false;
  const invalidate = () => { invalidated = true; };
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === "nowen-token" || event.key === "nowen-server-url") invalidate();
  };
  const assertScope = () => {
    if (invalidated || !token || token !== localStorage.getItem("nowen-token") || server !== localStorage.getItem("nowen-server-url")
      || queueKey !== getOfflineQueueStorageKey() || getCurrentUserId() !== input.userId) throw new ConversionCleanupError("scope_changed");
  };
  window.addEventListener("nowen:token-changed", invalidate);
  window.addEventListener("nowen:server-url-changed", invalidate);
  window.addEventListener("storage", storage);
  try {
    return await withConversionCleanupLease(input.noteId, async () => {
      assertScope();
      if (typeof indexedDB.databases !== "function") throw new ConversionCleanupError("unavailable");
      assertNoPendingWrites(input.noteId, queueKey);
      inspectDraftIndexForEncryptionConversion();
      if (await inspectCachedNotePresence(input.noteId, input.userId) === null) throw new ConversionCleanupError("unavailable");
      assertScope();
      const note = await loadCommitted();
      assertScope();
      if (note.id !== input.noteId || note.userId !== input.userId || note.version !== input.version
        || note.content !== input.content || note.contentText !== "") throw new ConversionCleanupError("not_committed");
      try { readEncryptedNoteDocument(note); } catch { throw new ConversionCleanupError("not_committed"); }
      markConvertedNote(input.noteId, input.version, queueKey);
      assertScope();
      const collaboration = getYjsPersistenceName(input.noteId, input.userId);
      const databases = await indexedDB.databases();
      assertScope();
      assertNoPendingWrites(input.noteId, queueKey);
      // Delete only a known existing database; never open/create a Yjs database.
      if (databases.some((database) => database.name === collaboration)) {
        await deleteCollaborationDatabase(collaboration);
        assertScope();
      }
      await clearCachedNoteForEncryptionConversion(input.noteId, input.userId, assertScope);
      assertScope();
      assertNoPendingWrites(input.noteId, queueKey);
      clearDraftForEncryptionConversion(input.noteId);
      const remaining = await indexedDB.databases();
      assertScope();
      assertNoPendingWrites(input.noteId, queueKey);
      if (await inspectCachedNotePresence(input.noteId, input.userId) !== false) throw new ConversionCleanupError("storage_failed");
      assertScope();
      if (localStorage.getItem(`nowen-draft-${input.noteId}`) !== null || remaining.some((database) => database.name === collaboration)) {
        throw new ConversionCleanupError("storage_failed");
      }
      return { noteId: input.noteId, localCleanup: true as const, physicalErasure: "not_verified" as const };
    });
  } catch (error) {
    if (error instanceof ConversionCleanupError) throw error;
    throw new ConversionCleanupError("storage_failed");
  } finally {
    window.removeEventListener("nowen:token-changed", invalidate);
    window.removeEventListener("nowen:server-url-changed", invalidate);
    window.removeEventListener("storage", storage);
  }
}
