import type { Note } from "@/types";
import { getQueue } from "../offlineQueue";
import { ENCRYPTED_NOTE_FORMAT, readEncryptedNoteDocument } from "./noteDocument";

/** Reuse the existing scoped queue; never let an older remote cache overwrite pending ciphertext. */
export function pendingEncryptedNote(noteId: string, note?: Note): Note | null {
  const mutation = getQueue().filter((item) => item.noteId === noteId && item.type === "updateNote" && item.body?.contentFormat === ENCRYPTED_NOTE_FORMAT).at(-1);
  if (!mutation) return null;
  const pending = { ...note, ...mutation.body, id: noteId, contentText: "" } as Note;
  if (typeof pending.notebookId !== "string" || typeof pending.userId !== "string" || typeof pending.version !== "number") throw new Error("Incomplete encrypted queue entry");
  readEncryptedNoteDocument(pending);
  return pending;
}
