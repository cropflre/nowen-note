import type { Note } from "@/types";
import { api } from "../api";
import { discardResolvedQueueItems, enqueue, getQueue, getOfflineQueueStorageKey } from "../offlineQueue";
import { isEncryptedNoteFormat, readEncryptedNoteEnvelope, validateEncryptedNoteWrite } from "./noteDocument";

export async function saveEncryptedNoteCiphertext(note: Note, content: string, signal: AbortSignal): Promise<Note & { __offlineQueued?: boolean }> {
  readEncryptedNoteEnvelope(note);
  const contentFormat = note.contentFormat;
  validateEncryptedNoteWrite({ content, contentFormat, contentText: "" }, note as unknown as Record<string, unknown>);
  const scope = getOfflineQueueStorageKey();
  const entries = getQueue().filter((item) => item.noteId === note.id && item.type === "updateNote" && isEncryptedNoteFormat(item.body?.contentFormat));
  if (entries.some((item) => item.body?.contentFormat !== contentFormat)) throw new Error("Resolve encrypted protocol conflict first");
  if (entries.some((item) => item.conflict || item.errorCode === "VERSION_CONFLICT")) throw new Error("Resolve encrypted conflict first");
  const pending = entries.at(-1);
  const payload = { content, contentFormat, contentText: "", version: note.version };
  try {
    // Bypass ordinary plaintext draft snapshots and automatic conflict rebasing.
    const response = await api.updateNoteConfirmed(note.id, payload);
    if (response.id !== note.id || response.content !== content || response.contentFormat !== contentFormat
      || response.contentText !== "" || !Number.isSafeInteger(response.version) || response.version !== note.version + 1) throw new Error("Ciphertext acknowledgement mismatch");
    if ((!signal.aborted || signal.reason === "auto-lock") && scope === getOfflineQueueStorageKey() && pending) {
      discardResolvedQueueItems(pending);
      if (getQueue().some((item) => item.id === pending.id && item.body?.content === pending.body?.content)) throw new Error("Acknowledged ciphertext queue not cleared");
    }
    return response;
  } catch (error) {
    if (signal.aborted || scope !== getOfflineQueueStorageKey()) throw error;
    const status = (error as { status?: number })?.status;
    if (status !== undefined || (!(error instanceof TypeError) && navigator.onLine !== false)) throw error;
    const pending = { ...note, ...payload, updatedAt: new Date().toISOString() };
    enqueue({ type: "updateNote", noteId: note.id, url: `/notes/${encodeURIComponent(note.id)}`, method: "PUT", body: pending });
    // Existing queue persistence may fail under quota/privacy mode; read-back is required.
    if (!getQueue().some((item) => item.noteId === note.id && item.type === "updateNote" && item.body?.content === content && item.body?.contentFormat === contentFormat)) throw new Error("Ciphertext queue not persisted");
    return { ...pending, __offlineQueued: true };
  }
}
