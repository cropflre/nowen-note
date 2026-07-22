import type { Note } from "@/types";
import {
  getNote as getCachedNote,
  isNoteDetailCached,
  putNote,
  type CachedNote,
} from "@/lib/localStore";

export interface CacheFirstNoteLoadOptions {
  noteId: string;
  fetchRemote: () => Promise<Note>;
  onRevalidated?: (remote: Note, cached: CachedNote) => void | Promise<void>;
}

export interface RevalidatedNoteGuardInput {
  current: Note | null | undefined;
  cached: Note;
  remote: Note;
  hasDraft: boolean;
  pendingNoteId: string | null;
}

export function canApplyRevalidatedNote({
  current,
  cached,
  remote,
  hasDraft,
  pendingNoteId,
}: RevalidatedNoteGuardInput): boolean {
  if (!current || hasDraft || pendingNoteId) return false;
  if (current.id !== cached.id || remote.id !== cached.id) return false;
  if (remote.version <= cached.version) return false;

  return current.version === cached.version
    && current.title === cached.title
    && current.content === cached.content
    && current.contentText === cached.contentText
    && current.updatedAt === cached.updatedAt;
}

async function persistDetail(note: Note): Promise<void> {
  await putNote({ ...note, __detailCached: true });
}

export async function loadNoteCacheFirst({
  noteId,
  fetchRemote,
  onRevalidated,
}: CacheFirstNoteLoadOptions): Promise<Note> {
  const cached = await getCachedNote(noteId);
  if (cached && isNoteDetailCached(cached)) {
    void fetchRemote()
      .then(async (remote) => {
        await persistDetail(remote);
        await onRevalidated?.(remote, cached);
      })
      .catch((error) => {
        console.warn("[noteLoadSource] background revalidation failed:", error);
      });
    return cached;
  }

  const remote = await fetchRemote();
  await persistDetail(remote);
  return remote;
}
