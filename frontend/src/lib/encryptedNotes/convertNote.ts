import type { Note } from "@/types";
import { getBaseUrl } from "../api";
import { fetchWithAuthRefresh, getAccessToken } from "../authSession";
import { folderUnlockRequestHeaders } from "../knowledgeTreePassword";
import { getOfflineQueueStorageKey } from "../offlineScope";
import { getCurrentUserId, inspectCachedNoteSource } from "../localStore";
import { inspectDraftIndexForEncryptionConversion } from "../draftStorage";
import { cleanupConvertedNoteCopies, assertNoPendingConversionWrites } from "./conversionCleanup";
import { withConversionCleanupLease, ConversionCleanupError } from "./conversionCoordination";
import { clearPendingConversion, readPendingConversion, storePendingConversion } from "./conversionPending";
import { EncryptedContentV2Session } from "./sessionV2Client";
import { ENCRYPTED_NOTE_V2_FORMAT, validateEnvelopeV2 } from "./envelopeV2";
import { validateEncryptedNotePlaintext, sameConversionContent, readEncryptedNoteEnvelope } from "./noteDocument";
import { validateHistoryV2 } from "./attachmentCodec";

export interface ConversionHistorySource { id: string; content: string; contentFormat: "markdown" | "tiptap-json"; version: number; changeSummary: string | null }
export interface ConversionSource { canConvert: boolean; blockers: string[]; note?: Note; history?: ConversionHistorySource[] }
export class NoteConversionError extends Error {
  constructor(readonly code: string, readonly blockers: string[] = []) { super(code); }
}
const digest = async (content: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Never use the ordinary note reader: it repairs, caches and can fall back offline. */
async function request<T>(noteId: string, signal: AbortSignal, body?: unknown, suffix = body ? "" : "/source"): Promise<T> {
  const base = getBaseUrl(); const scope = getOfflineQueueStorageKey();
  const response = await fetchWithAuthRefresh(`${base}/notes/${encodeURIComponent(noteId)}/encryption${suffix}`, {
    method: body ? "POST" : "GET", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/vnd.nowen.internal-note+json", Authorization: `Bearer ${getAccessToken()}`, ...folderUnlockRequestHeaders() },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, base);
  if (scope !== getOfflineQueueStorageKey() || signal.aborted) throw new ConversionCleanupError("scope_changed");
  const result = await response.json();
  if (scope !== getOfflineQueueStorageKey() || signal.aborted) throw new ConversionCleanupError("scope_changed");
  if (!response.ok) throw new NoteConversionError(typeof result.code === "string" ? result.code : "CONVERSION_FAILED", Array.isArray(result.blockers) ? result.blockers : []);
  return result as T;
}

/** Editor teardown reaches the server asynchronously. Recheck only transient collaboration blockers. */
async function readSettledSource(noteId: string, signal: AbortSignal): Promise<ConversionSource> {
  for (let attempt = 0; ; attempt++) {
    const source = await request<ConversionSource>(noteId, signal);
    if (source.canConvert || attempt === 24 || !source.blockers.length
      || source.blockers.some((blocker) => !["collaboration_room", "active_collaboration"].includes(blocker))) return source;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new ConversionCleanupError("scope_changed")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 200);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

export async function cancelNoteConversion(noteId: string, signal: AbortSignal): Promise<void> {
  const scope = getOfflineQueueStorageKey();
  await withConversionCleanupLease(noteId, async () => {
    const pending = readPendingConversion(noteId, scope);
    if (!pending) return;
    const response = await request<{ cancelled: boolean }>(noteId, signal, { version: pending.sourceVersion }, "/cancel");
    if (response.cancelled !== true || scope !== getOfflineQueueStorageKey() || signal.aborted) throw new ConversionCleanupError("not_committed");
    clearPendingConversion(noteId, scope);
  }, signal);
}

function assertDraftMatches(note: Note) {
  inspectDraftIndexForEncryptionConversion();
  const raw = localStorage.getItem(`nowen-draft-${note.id}`);
  if (raw !== null) {
    let draft: { noteId?: unknown; conflicted?: unknown; content?: unknown; title?: unknown } | null;
    try { draft = JSON.parse(raw); } catch { throw new ConversionCleanupError("storage_failed"); }
    if (!draft || draft.noteId !== note.id || draft.conflicted || typeof draft.content !== "string" || !sameConversionContent(draft.content, note.content, note.contentFormat) || draft.title !== note.title) throw new ConversionCleanupError("pending_writes");
  }
}
async function assertLocalSource(note: Note, scope: string) {
  if (!note.userId || getCurrentUserId() !== note.userId || !indexedDB.databases || !crypto.subtle) throw new ConversionCleanupError("unavailable");
  assertNoPendingConversionWrites(note.id, scope); assertDraftMatches(note);
  const cached = await inspectCachedNoteSource(note);
  if (cached === null) throw new ConversionCleanupError("unavailable");
  if (!cached) throw new ConversionCleanupError("pending_writes");
}
function assertExpected(source: ConversionSource, expected?: Pick<Note, "id" | "title" | "content" | "contentFormat">): asserts source is ConversionSource & { note: Note; history: ConversionHistorySource[] } {
  if (!source.canConvert || !source.note || !Array.isArray(source.history)) throw new NoteConversionError("CONVERSION_BLOCKED", source.blockers);
  if (expected && (source.note.id !== expected.id || source.note.title !== expected.title || !sameConversionContent(source.note.content, expected.content, source.note.contentFormat) || source.note.contentFormat !== expected.contentFormat)) throw new ConversionCleanupError("pending_writes");
}
export async function checkNoteConversion(note: Note, signal: AbortSignal): Promise<void> {
  const scope = getOfflineQueueStorageKey();
  await withConversionCleanupLease(note.id, async () => {
    const source = await readSettledSource(note.id, signal); assertExpected(source, note);
    await assertLocalSource(source.note, scope);
    if (scope !== getOfflineQueueStorageKey() || signal.aborted) throw new ConversionCleanupError("scope_changed");
  }, signal);
}

export async function convertNote(noteId: string, passphrase: string, signal: AbortSignal, expected?: Note): Promise<Note> {
  const scope = getOfflineQueueStorageKey();
  const assertScope = () => { if (scope !== getOfflineQueueStorageKey() || signal.aborted) throw new ConversionCleanupError("scope_changed"); };
  return withConversionCleanupLease(noteId, async (lease) => {
    const session = new EncryptedContentV2Session(); let verification: EncryptedContentV2Session | undefined;
    try {
      verification = new EncryptedContentV2Session();
      let pending = readPendingConversion(noteId, scope);
      const retrying = Boolean(pending);
      let source = await readSettledSource(noteId, signal);
      if (!pending || source.note?.contentFormat !== ENCRYPTED_NOTE_V2_FORMAT) {
        assertExpected(source, pending ? undefined : expected);
        await assertLocalSource(source.note, scope); assertScope();
        validateEncryptedNotePlaintext(source.note.content, source.note.contentFormat as "markdown" | "tiptap-json");
        for (const row of source.history) validateEncryptedNotePlaintext(row.content, row.contentFormat);
        if (pending) {
          if (source.note.userId !== pending.userId || source.note.version !== pending.sourceVersion) throw new NoteConversionError("VERSION_CONFLICT");
          const envelope = validateEnvelopeV2(JSON.parse(pending.content));
          const opened = await session.open(envelope, passphrase, envelope, signal);
          if (opened.attachments.length || opened.content !== source.note.content || envelope.originalFormat !== source.note.contentFormat) throw new NoteConversionError("VERSION_CONFLICT");
        } else {
          const envelope = await session.create({ documentSchemaVersion: 1, content: source.note.content, attachments: [] }, passphrase, {
            objectId: crypto.randomUUID(), kind: "note", originalFormat: source.note.contentFormat as "markdown" | "tiptap-json",
            parentObjectId: null, documentSchemaVersion: 1, keyEpoch: 1, encryptionEpoch: 1,
          }, signal);
          const opened = await verification.open(envelope, passphrase, envelope, signal);
          if (opened.content !== source.note.content || opened.attachments.length) throw new NoteConversionError("VERIFICATION_FAILED");
          pending = { noteId, userId: source.note.userId, sourceVersion: source.note.version, title: source.note.title, content: JSON.stringify(envelope), encryptedHistory: [] };
          for (const row of source.history) {
            const encrypted = await session.encryptHistory({ version: 1, historyId: row.id, sourceVersion: row.version, originalFormat: row.contentFormat },
              { documentSchemaVersion: 1, content: row.content, attachments: [] }, row.changeSummary, signal);
            const openedHistory = await verification.decryptHistory(encrypted, signal);
            if (openedHistory.document.content !== row.content || openedHistory.document.attachments.length || openedHistory.changeSummary !== row.changeSummary) throw new NoteConversionError("VERIFICATION_FAILED");
            pending.encryptedHistory.push({ id: row.id, content: JSON.stringify(encrypted) });
          }
        }
        if (pending.encryptedHistory.length !== source.history.length) throw new NoteConversionError("VERSION_CONFLICT");
        const encryptedHistory = [];
        for (const row of source.history) {
          const replacement = pending.encryptedHistory.find((item) => item.id === row.id);
          if (!replacement) throw new NoteConversionError("VERSION_CONFLICT");
          // Also authenticate every retained replacement during a post-interruption retry.
          const history = validateHistoryV2(JSON.parse(replacement.content));
          if (history.sourceVersion !== row.version || history.originalFormat !== row.contentFormat) throw new NoteConversionError("VERSION_CONFLICT");
          const opened = await session.decryptHistory(history, signal);
          if (opened.document.content !== row.content || opened.changeSummary !== row.changeSummary || opened.document.attachments.length) throw new NoteConversionError("VERSION_CONFLICT");
          encryptedHistory.push({ ...replacement, sourceDigest: await digest(JSON.stringify([row.content, row.contentFormat, row.version, row.changeSummary])) });
        }
        const payload = { version: pending.sourceVersion, sourceDigest: await digest(source.note.content), content: pending.content, encryptedHistory, confirmExternalCopies: true };
        assertScope(); assertNoPendingConversionWrites(noteId, scope); assertDraftMatches(source.note);
        storePendingConversion(pending, scope);
        // A failed/lost POST response must be resolved by an uncached read, never rollback to plaintext.
        try { await request(noteId, signal, payload); } catch (error) {
          source = await request<ConversionSource>(noteId, signal);
          if (source.note?.content !== pending.content) {
            // A definitive rejection of this first request cannot still commit later.
            // Uncertain network failures keep the barrier and ciphertext for recovery.
            if (!retrying && error instanceof NoteConversionError) clearPendingConversion(noteId, scope);
            throw error;
          }
        }
        source = await request<ConversionSource>(noteId, signal);
      }
      assertScope();
      const committed = source.note;
      if (!pending || !committed || committed.id !== noteId || committed.userId !== pending.userId || committed.contentFormat !== ENCRYPTED_NOTE_V2_FORMAT
        || committed.version < pending.sourceVersion + 1 || (committed.version === pending.sourceVersion + 1 && committed.content !== pending.content) || committed.contentText !== ""
        || !source.history || source.history.length < pending.encryptedHistory.length + 1
        || !pending.encryptedHistory.every((row) => source.history!.some((stored) => stored.id === row.id && stored.content === row.content))
        || !source.history.some((row) => row.content === pending.content && row.version === pending.sourceVersion + 1)) throw new ConversionCleanupError("not_committed");
      // Another device may already have edited the ciphertext after conversion.
      // Prove the exact conversion snapshot/history and require the same encrypted root.
      const target = validateEnvelopeV2(JSON.parse(pending.content));
      const current = validateEnvelopeV2(JSON.parse(committed.content));
      if (current.objectId !== target.objectId || current.originalFormat !== target.originalFormat || current.keyEpoch !== target.keyEpoch || current.encryptionEpoch !== target.encryptionEpoch
        || !source.history.every((row) => {
          try {
            const envelope = (row.contentFormat as string) === "encrypted-history-v2" ? validateHistoryV2(JSON.parse(row.content)) : readEncryptedNoteEnvelope(row);
            return envelope.objectId === target.objectId && "keyEpoch" in envelope && envelope.keyEpoch === target.keyEpoch && envelope.encryptionEpoch === target.encryptionEpoch;
          } catch { return false; }
        })) throw new ConversionCleanupError("not_committed");
      await cleanupConvertedNoteCopies({ noteId, userId: pending.userId, version: committed.version, content: committed.content, discardLocalCopies: true },
        async () => { const note = (await request<ConversionSource>(noteId, signal)).note!; return { ...note, contentFormat: note.contentFormat! }; }, lease);
      assertScope(); clearPendingConversion(noteId, scope);
      return committed;
    } finally { session.close(); verification?.close(); }
  }, signal);
}
