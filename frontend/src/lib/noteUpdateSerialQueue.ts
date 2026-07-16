import type { Note } from "@/types";
import { api } from "@/lib/api";
import { hasPendingNoteSyncConflict } from "@/lib/noteSyncSafety";
import { LatestOnlyVersionedSaveQueue } from "@/lib/latestOnlyVersionedSaveQueue";

const INSTALL_KEY = "__NOWEN_NOTE_UPDATE_SERIAL_QUEUE_V1__" as const;
const VERSIONED_FIELDS = ["title", "content", "contentText", "contentFormat"] as const;

type GuardedWindow = Window & typeof globalThis & {
  [INSTALL_KEY]?: () => void;
};

export type NoteUpdateMutation = Partial<Note> & Record<string, unknown>;

export function isVersionedNoteUpdate(data: NoteUpdateMutation): boolean {
  return VERSIONED_FIELDS.some((field) => data[field] !== undefined);
}

export function mergeDefinedNoteUpdates(
  previous: NoteUpdateMutation,
  next: NoteUpdateMutation,
): NoteUpdateMutation {
  const merged: NoteUpdateMutation = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (key !== "version" && value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Serialize versioned note writes at the shared API boundary.
 *
 * Every editor and client runtime calls the same api.updateNote method. Installing the
 * queue here prevents two debounced saves from one tab from carrying the same base
 * version, while preserving the existing noteSyncSafety conflict handling underneath.
 */
export function installNoteUpdateSerialQueue(): void {
  if (typeof window === "undefined") return;
  const guardedWindow = window as GuardedWindow;
  if (guardedWindow[INSTALL_KEY]) return;

  const originalUpdateNote = api.updateNote.bind(api);
  const queue = new LatestOnlyVersionedSaveQueue<NoteUpdateMutation, Note>(
    (noteId, payload, version) => originalUpdateNote(noteId, { ...payload, version } as Partial<Note>),
    mergeDefinedNoteUpdates,
  );

  (api as any).updateNote = async (noteId: string, data: Partial<Note>): Promise<Note> => {
    const mutation = data as NoteUpdateMutation;
    if (!isVersionedNoteUpdate(mutation) || hasPendingNoteSyncConflict(noteId)) {
      return originalUpdateNote(noteId, data);
    }

    const baseVersion = Number(mutation.version);
    if (!Number.isFinite(baseVersion)) {
      // Keep the existing VERSION_REQUIRED_CLIENT error and diagnostics from noteSyncSafety.
      return originalUpdateNote(noteId, data);
    }

    const payload: NoteUpdateMutation = { ...mutation };
    delete payload.version;
    const saved = await queue.enqueue({
      key: noteId,
      baseVersion,
      payload,
    });
    return saved.result;
  };

  guardedWindow[INSTALL_KEY] = () => {
    (api as any).updateNote = originalUpdateNote;
    delete guardedWindow[INSTALL_KEY];
  };
}
