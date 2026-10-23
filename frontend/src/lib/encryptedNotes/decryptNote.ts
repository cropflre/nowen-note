import type { Note } from "@/types";
import { getBaseUrl } from "../api";
import { fetchWithAuthRefresh, getAccessToken } from "../authSession";
import { folderUnlockRequestHeaders } from "../knowledgeTreePassword";
import { getOfflineQueueStorageKey } from "../offlineScope";
import { assertNoPendingConversionWrites } from "./conversionCleanup";
import { withConversionCleanupLease, ConversionCleanupError } from "./conversionCoordination";
import { clearDecryptedNoteBarrier } from "./conversionBarrier";
import { readPendingConversion } from "./conversionPending";
import { readEncryptedNoteEnvelope, validateEncryptedNotePlaintext } from "./noteDocument";
import { EncryptedNoteSession } from "./noteSession";

type History = { id: string; version: number; content: string; contentFormat: string; changeSummary: string | null };
type Source = { note: Note; history: History[] };
export class NoteDecryptionError extends Error {
  constructor(readonly code: string, readonly blockers: string[] = []) { super(code); }
}
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");

/** No ordinary note cache, offline fallback, plaintext queue or persisted recovery payload. */
export async function decryptNotePermanently(note: Note, passphrase: string, signal: AbortSignal, assertCurrent: () => void): Promise<Note> {
  const scope = getOfflineQueueStorageKey();
  const assertScope = () => {
    if (signal.aborted || scope !== getOfflineQueueStorageKey()) throw new ConversionCleanupError("scope_changed");
    assertCurrent(); assertNoPendingConversionWrites(note.id, scope);
    if (readPendingConversion(note.id, scope)) throw new ConversionCleanupError("pending_writes");
  };
  const request = async <T,>(suffix: string, payload?: unknown): Promise<T> => {
    assertScope();
    const base = getBaseUrl();
    const response = await fetchWithAuthRefresh(`${base}/notes/${encodeURIComponent(note.id)}/encryption/${suffix}`, {
      method: payload ? "POST" : "GET", signal, cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/vnd.nowen.internal-note+json", Authorization: `Bearer ${getAccessToken()}`, ...folderUnlockRequestHeaders() },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    }, base);
    assertScope();
    const result = await response.json(); assertScope();
    if (!response.ok) throw new NoteDecryptionError(typeof result.code === "string" ? result.code : "DECRYPTION_FAILED", Array.isArray(result.blockers) ? result.blockers : []);
    return result;
  };
  return withConversionCleanupLease(note.id, async () => {
    assertScope();
    const envelope = readEncryptedNoteEnvelope(note);
    const session = new EncryptedNoteSession(envelope.version);
    try {
      const content = await session.open(envelope, passphrase, envelope, signal);
      validateEncryptedNotePlaintext(content, envelope.originalFormat); assertScope();
      const source = await request<Source>("decryption-source");
      const matchesTarget = (saved: Note) => saved.id === note.id && saved.version === note.version + 1
        && saved.content === content && saved.contentFormat === envelope.originalFormat;
      if (matchesTarget(source.note)) {
        clearDecryptedNoteBarrier(note.id, source.note.version, scope);
        return source.note;
      }
      if (source.note.id !== note.id || source.note.content !== note.content || source.note.contentFormat !== note.contentFormat || source.note.version !== note.version)
        throw new NoteDecryptionError("VERSION_CONFLICT");
      const decryptedHistory = [];
      for (const row of source.history) {
        assertScope();
        const opened = await session.readVersion(row, signal);
        decryptedHistory.push({ id: row.id, sourceDigest: await digest(JSON.stringify([row.content, row.contentFormat, row.version, row.changeSummary])), content: opened.content, contentFormat: opened.format, changeSummary: opened.changeSummary });
      }
      const payload = { version: note.version, sourceDigest: await digest(note.content), content, contentFormat: envelope.originalFormat, confirmPlaintext: true, decryptedHistory };
      assertScope();
      let saved: Note;
      try { saved = await request<Note>("decrypt", payload); }
      catch (error) {
        assertScope();
        // A lost response may follow COMMIT. Read the exact target before reporting failure.
        const confirmed = await request<Source>("decryption-source");
        if (!matchesTarget(confirmed.note) || !decryptedHistory.every(row => confirmed.history.some(stored => stored.id === row.id && stored.content === row.content && stored.contentFormat === row.contentFormat))) throw error;
        saved = confirmed.note;
      }
      if (!matchesTarget(saved)) throw new NoteDecryptionError("VERSION_CONFLICT");
      assertScope(); clearDecryptedNoteBarrier(note.id, saved.version, scope);
      return saved;
    } finally { session.close(); }
  }, signal);
}
