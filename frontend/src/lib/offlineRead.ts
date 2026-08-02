import {
  getAllNotebooks,
  getAllNotes,
  getAllTags,
  getNote as localGetNote,
  isNoteDetailCached,
  isReady as localStoreReady,
} from "@/lib/localStore";
import type { Note, NoteListItem, Notebook, Tag } from "@/types";
import { hydrateOfflineAttachmentsForNote } from "@/lib/noteAttachmentAccessBridge";

export interface OfflineNoteSnapshot {
  noteId: string;
  version: number;
  updatedAt?: string;
  capturedAt: number;
  contentFingerprint?: string;
}

export const OFFLINE_NOTE_SNAPSHOT_EVENT = "nowen:offline-note-snapshot";

let offlineHit = false;
const offlineListeners = new Set<(value: boolean) => void>();
const offlineNoteSnapshots = new Map<string, OfflineNoteSnapshot>();

export function fingerprintNoteContent(content: unknown): string | undefined {
  if (typeof content !== "string") return undefined;
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${content.length}:${hash.toString(16).padStart(8, "0")}`;
}

function setOffline(value: boolean): void {
  if (offlineHit === value) return;
  offlineHit = value;
  offlineListeners.forEach((listener) => {
    try { listener(value); } catch { /* listener isolation */ }
  });
}

export function markOfflineNoteSnapshot(
  note: Pick<Note, "id" | "version"> & { updatedAt?: string; content?: string },
): void {
  const version = Number.isFinite(note.version) ? note.version : 0;
  const previous = offlineNoteSnapshots.get(note.id);
  const explicitFingerprint = fingerprintNoteContent(note.content);
  const snapshot: OfflineNoteSnapshot = {
    noteId: note.id,
    version,
    updatedAt: note.updatedAt ?? previous?.updatedAt,
    capturedAt: Date.now(),
    // Queue acknowledgements do not include the base body. Preserve the prior fingerprint
    // only when they refer to the same revision; never carry it across a revision change.
    contentFingerprint: explicitFingerprint ?? (
      previous?.version === version ? previous.contentFingerprint : undefined
    ),
  };
  offlineNoteSnapshots.set(note.id, snapshot);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OFFLINE_NOTE_SNAPSHOT_EVENT, { detail: snapshot }));
  }
}

export function clearOfflineNoteSnapshot(noteId: string): void {
  offlineNoteSnapshots.delete(noteId);
}

export function getOfflineNoteSnapshot(noteId: string): OfflineNoteSnapshot | null {
  return offlineNoteSnapshots.get(noteId) || null;
}

export function isOfflineNoteSnapshot(noteId: string): boolean {
  return offlineNoteSnapshots.has(noteId);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => setOffline(false));
}

export function isCurrentlyOffline(): boolean {
  return offlineHit || (typeof navigator !== "undefined" && !navigator.onLine);
}

export function subscribeOfflineState(listener: (value: boolean) => void): () => void {
  offlineListeners.add(listener);
  return () => { offlineListeners.delete(listener); };
}

interface FallbackHooks<T> {
  onOnline?: (value: T) => void;
  onFallback?: (value: T) => void;
}

async function withFallback<T>(
  online: () => Promise<T>,
  fallback: () => Promise<T>,
  hooks: FallbackHooks<T> = {},
): Promise<T> {
  if (typeof navigator !== "undefined" && !navigator.onLine && localStoreReady()) {
    setOffline(true);
    const value = await fallback();
    hooks.onFallback?.(value);
    return value;
  }

  try {
    const value = await online();
    setOffline(false);
    hooks.onOnline?.(value);
    return value;
  } catch (error: any) {
    const status = error?.status as number | undefined;
    if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      throw error;
    }
    if (!localStoreReady()) throw error;
    setOffline(true);
    const value = await fallback();
    hooks.onFallback?.(value);
    return value;
  }
}

function activeWorkspaceId(): string | null {
  try {
    const workspace = localStorage.getItem("nowen-current-workspace") || "personal";
    return workspace === "personal" ? null : workspace;
  } catch {
    return null;
  }
}

function matchesActiveWorkspace(value: { workspaceId?: string | null }): boolean {
  return (value.workspaceId ?? null) === activeWorkspaceId();
}

export function readNotebooks(online: () => Promise<Notebook[]>): Promise<Notebook[]> {
  return withFallback(online, async () => (await getAllNotebooks()).filter(matchesActiveWorkspace));
}

export function readNotesList(
  online: () => Promise<NoteListItem[]>,
  filter?: (note: Note) => boolean,
): Promise<NoteListItem[]> {
  return withFallback(online, async () => {
    const all = await getAllNotes();
    const matched = filter ? all.filter(filter) : all;
    matched.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return matched.map(({ content, __detailCached, ...rest }) => rest as unknown as NoteListItem);
  });
}

export function readTags(online: () => Promise<Tag[]>): Promise<Tag[]> {
  return withFallback(online, async () => (await getAllTags()).filter(matchesActiveWorkspace));
}

export function readNote(id: string, online: () => Promise<Note>): Promise<Note> {
  return withFallback(
    online,
    async () => {
      const note = await localGetNote(id);
      if (!note) throw new Error("笔记不在本地缓存中");
      if (!isNoteDetailCached(note)) {
        throw new Error("该笔记尚未完成离线下载，恢复网络后会自动继续同步");
      }
      return note;
    },
    {
      onOnline: (note) => clearOfflineNoteSnapshot(note.id),
      onFallback: (note) => markOfflineNoteSnapshot(note),
    },
  ).then(async (note) => {
    await hydrateOfflineAttachmentsForNote(note.id).catch((error) => {
      console.warn("[offlineRead] hydrate cached attachments failed", error);
    });
    return note;
  });
}
