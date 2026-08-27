import type { Note } from "@/types";
import { getBaseUrl } from "@/lib/api";
import {
  getNote as getCachedNote,
  isNoteDetailCached,
  putNote,
  type CachedNote,
} from "@/lib/localStore";
import {
  hasPersistentNoteAttachmentReference,
  primeNoteAttachmentAccess,
} from "@/lib/noteAttachmentAccessPriming";
import {
  reportTransientNoteImageSource,
  stabilizeNoteMutationPayload,
} from "@/lib/noteContentPersistence";

export interface CacheFirstNoteLoadOptions {
  noteId: string;
  fetchRemote: () => Promise<Note>;
  onRevalidated?: (remote: Note, cached: CachedNote) => void | Promise<void>;
  /**
   * Optional runtime preparation hook. Custom callers may still return a Promise when they truly
   * need a prerequisite before publishing the note. The default attachment preparation is now
   * deliberately fire-and-forget so note text is never held behind media authorization/network IO.
   */
  beforeUseCached?: (cached: CachedNote) => void | Promise<void>;
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
  try {
    const stableNote = stabilizeNoteMutationPayload(note);
    await putNote({ ...stableNote, __detailCached: true });
  } catch (error) {
    reportTransientNoteImageSource(error, { operation: "persistNoteDetail", noteId: note.id });
  }
}

function prepareNoteRuntime(note: CachedNote): void {
  if (!hasPersistentNoteAttachmentReference(note.content)) return;
  // Media access is a renderer enhancement, not a prerequisite for reading note text. Starting
  // it here keeps the request warm while allowing cache/remote content to become visible at once.
  void primeNoteAttachmentAccess(note.id, getBaseUrl()).catch((error) => {
    console.warn("[noteLoadSource] attachment preparation failed:", error);
  });
}

export async function loadNoteCacheFirst({
  noteId,
  fetchRemote,
  onRevalidated,
  beforeUseCached = prepareNoteRuntime,
}: CacheFirstNoteLoadOptions): Promise<Note> {
  const cached = await getCachedNote(noteId);
  if (cached && isNoteDetailCached(cached)) {
    // Start freshness revalidation immediately. Runtime/media preparation is best-effort by default;
    // custom callers can still explicitly provide a blocking prerequisite through beforeUseCached.
    void fetchRemote()
      .then(async (remote) => {
        await persistDetail(remote);
        try {
          await beforeUseCached(remote);
        } catch (error) {
          console.warn("[noteLoadSource] revalidated-note preparation failed:", error);
        }
        await onRevalidated?.(remote, cached);
      })
      .catch((error) => {
        console.warn("[noteLoadSource] background revalidation failed:", error);
      });

    try {
      await beforeUseCached(cached);
    } catch (error) {
      // Cached notes must remain available offline. The background revalidation above may still
      // recover the runtime prerequisite when connectivity returns.
      console.warn("[noteLoadSource] cached-note preparation failed:", error);
    }
    return cached;
  }

  const remote = await fetchRemote();
  await persistDetail(remote);
  try {
    // The default preparation starts signed-URL priming but resolves synchronously. This keeps
    // first-load text responsive while image/video NodeViews subscribe to the access bridge and
    // upgrade themselves as soon as the signed URL map arrives.
    await beforeUseCached(remote);
  } catch (error) {
    console.warn("[noteLoadSource] remote-note preparation failed:", error);
  }
  return remote;
}
