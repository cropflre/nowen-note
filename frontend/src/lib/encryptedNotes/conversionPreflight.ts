import { getOfflineQueueStorageKey } from "../offlineQueue";
import { inspectCachedNotePresence } from "../localStore";
import { getYjsPersistenceName } from "../yjsProvider";

export interface EncryptionConversionPreflight {
  noteId: string;
  version: number;
  contentFormat: string;
  canConvert: false;
  blockers: string[];
  copies: Array<{ kind: string; records: number; complete: boolean }>;
  unreviewed: Array<{ table: string; records: number }>;
  previewPresent: boolean;
  activeCollaborators: number;
  physicalErasure: "not_verified";
  externalCopies: "not_inspectable";
}

export interface BrowserConversionCopies {
  draft: boolean | null;
  queue: number | null;
  cache: boolean | null;
  collaboration: boolean | null;
}

/** Presence/counts only; do not use readers that prune old drafts or queue items. */
export async function inspectBrowserConversionCopies(noteId: string, userId: string): Promise<BrowserConversionCopies> {
  const result: BrowserConversionCopies = { draft: null, queue: null, cache: null, collaboration: null };
  try { result.draft = localStorage.getItem(`nowen-draft-${noteId}`) !== null; } catch { /* unknown */ }
  try {
    const queue: unknown = JSON.parse(localStorage.getItem(getOfflineQueueStorageKey()) || "[]");
    if (Array.isArray(queue) && queue.every((item) => item && typeof item.noteId === "string")) {
      result.queue = queue.filter((item) => item.noteId === noteId).length;
    }
  } catch { /* unknown */ }
  try { result.cache = await inspectCachedNotePresence(noteId, userId); } catch { /* unknown */ }
  try {
    if (typeof indexedDB.databases === "function") {
      const name = getYjsPersistenceName(noteId, userId);
      result.collaboration = (await indexedDB.databases()).some((database) => database.name === name);
    }
  } catch { /* unknown; never open a database to check its existence */ }
  return result;
}
