// Separately built acceptance harness, never served by the product application.
import { createRoot } from "react-dom/client";
import { openDB } from "idb";
import EncryptedConversionEditorGuard from "../src/components/EncryptedConversionEditorGuard";
import { cleanupConvertedNoteCopies } from "../src/lib/encryptedNotes/conversionCleanup";
import { withConversionCleanupLease } from "../src/lib/encryptedNotes/conversionCoordination";
import { withConversionWriteLease } from "../src/lib/encryptedNotes/conversionBarrier";
import { saveDraft } from "../src/lib/draftStorage";
import { api } from "../src/lib/api";
import { AppProvider, useApp } from "../src/store/AppContext";
import { getOfflineQueueStorageKey, flushQueue, enqueue } from "../src/lib/offlineQueue";
import { getYjsPersistenceName } from "../src/lib/yjsProvider";
import * as cache from "../src/lib/localStore";
import vector from "../src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json";

const root = createRoot(document.getElementById("editor")!);
let blockedConnection: Awaited<ReturnType<typeof openDB>> | undefined;
let releaseExclusive: (() => void) | undefined;
let deletionBlocked = false;
let releaseReplay: (() => void) | undefined;
let releaseWriter: (() => void) | undefined;
let app: ReturnType<typeof useApp> | undefined;
function AppStateProbe() { app = useApp(); return <span>state ready</span>; }
const input = { noteId: "note", userId: "owner", version: 2, content: JSON.stringify(vector.envelope), discardLocalCopies: true as const };
const committed = { id: input.noteId, userId: input.userId, version: input.version, content: input.content, contentText: "", contentFormat: "encrypted-note-v1" };
let outcome: unknown;
const harness = {
  queueKey: getOfflineQueueStorageKey,
  collaborationName: () => getYjsPersistenceName("note", "owner"),
  async seed() {
    localStorage.setItem("nowen-token", `header.${btoa(JSON.stringify({ userId: "owner" }))}.signature`);
    cache.setCurrentUser("owner");
    for (const id of ["note", "other"]) {
      await cache.putCompleteOfflineNote({ id, content: `private-${id}`, contentText: `private-${id}`, version: 1 } as any);
      await cache.putOfflineAttachment({ id: `attachment-${id}`, noteId: id, filename: "private.txt", mimeType: "text/plain", size: 5, createdAt: "", cachedAt: 1, blob: new Blob([`private-${id}`]) });
      await cache.putOfflineAttachmentJob({ id: `job-${id}`, noteId: id, filename: "private.txt", mimeType: "text/plain", size: 5, createdAt: "", queuedAt: 1, retryCount: 0 });
      localStorage.setItem(`nowen-draft-${id}`, `private-${id}`);
    }
    localStorage.setItem("nowen-draft-index", '["note","other"]');
    const name = getYjsPersistenceName("note", "owner");
    const db = await openDB(name, 1, { upgrade(connection) { connection.createObjectStore("updates"); } });
    await db.put("updates", "private-note", "source"); db.close();
  },
  async snapshot() {
    const databases = await indexedDB.databases();
    const name = databases.find((entry) => entry.name?.startsWith("nowen-cache-v2-"))?.name;
    if (!name) throw new Error("Cache fixture missing");
    const db = await openDB(name);
    try {
      return {
        notes: await db.getAll("notes"), attachmentIds: await db.getAllKeys("offlineAttachments"), jobIds: await db.getAllKeys("offlineAttachmentJobs"),
        drafts: [localStorage.getItem("nowen-draft-note"), localStorage.getItem("nowen-draft-other")],
        databases: databases.map((entry) => entry.name).sort(),
      };
    } finally { db.close(); }
  },
  cleanup: () => cleanupConvertedNoteCopies(input, async () => committed),
  startCleanup() {
    outcome = "pending";
    void harness.cleanup().then((result) => { outcome = result; }, (error) => { outcome = { code: error.code }; });
  },
  outcome: () => outcome,
  async requestNote(method: "GET" | "PUT") {
    cache.setCurrentUser("owner");
    return method === "GET" ? api.getNote("note") : api.updateNoteConfirmed("note", { content: "private-note", contentText: "private-note", contentFormat: "markdown", version: 1 });
  },
  async holdCacheWrite() {
    await new Promise<void>((ready) => {
      void withConversionWriteLease(async () => {
        ready(); await new Promise<void>((resolve) => { releaseWriter = resolve; });
      });
    });
  },
  releaseCacheWrite: () => releaseWriter?.(),
  async writeStaleCopies() {
    cache.setCurrentUser("owner");
    const original = { id: "note", version: 1, content: "private-note", contentText: "private-note", contentFormat: "markdown" } as any;
    const errors: string[] = [];
    for (const write of [
      () => cache.putCompleteOfflineNote(original),
      () => cache.putOfflineAttachment({ id: "late-attachment", noteId: "note", filename: "private.txt", mimeType: "text/plain", size: 5, createdAt: "", cachedAt: 1, blob: new Blob(["private-note"]) }),
      () => cache.putOfflineAttachmentJob({ id: "late-job", noteId: "note", filename: "private.txt", mimeType: "text/plain", size: 5, createdAt: "", queuedAt: 1, retryCount: 0 }),
      () => saveDraft({ noteId: "note", content: "private-note", contentText: "private-note", title: "title", editorMode: "md", baseVersion: 1, savedAt: Date.now() }),
      () => enqueue({ noteId: "note", type: "updateNote", url: "/notes/note", method: "PUT", body: original }),
    ]) {
      try { await write(); errors.push("unexpected success"); } catch (error: any) { errors.push(error.code); }
    }
    await cache.putNote(original); // Ordinary best-effort writer also refuses the stale body.
    await cache.putNoteListItems([original]);
    return errors;
  },
  cacheEncrypted: () => cache.putCompleteOfflineNote(committed as any),
  showApp: () => root.render(<AppProvider><AppStateProbe /></AppProvider>),
  seedAppState() {
    if (!app) throw new Error("State probe missing");
    const original = { id: "note", version: 1, title: "title", content: "private-note", contentText: "private-note", contentFormat: "markdown" } as any;
    app.dispatch({ type: "SET_ACTIVE_NOTE", payload: original });
    app.dispatch({ type: "SET_NOTES", payload: [original, { ...original, id: "other" }] });
    app.dispatch({ type: "OPEN_NOTE_TAB", payload: original });
    app.dispatch({ type: "SPLIT_EDITOR", payload: { noteId: "note", direction: "right" } });
  },
  appState: () => app?.state,
  showEditor: (id: string | null) => root.render(<EncryptedConversionEditorGuard noteId={id}><textarea aria-label="ordinary editor" /></EncryptedConversionEditorGuard>),
  async holdExclusive() {
    await new Promise<void>((ready) => {
      void withConversionCleanupLease("note", async () => {
        const held = new Promise<void>((resolve) => { releaseExclusive = resolve; });
        ready(); await held;
      });
    });
  },
  releaseExclusive: () => releaseExclusive?.(),
  async holdReplay() {
    enqueue({ noteId: "other", type: "updateNote", url: "/notes/other", method: "PUT", body: { content: "private-other" } });
    await new Promise<void>((ready) => {
      void flushQueue(async () => {
        const held = new Promise<void>((resolve) => { releaseReplay = resolve; });
        ready(); await held; return { ok: true, status: 200 };
      });
    });
  },
  releaseReplay: () => releaseReplay?.(),
  async blockYjsDeletion() {
    blockedConnection = await openDB(getYjsPersistenceName("note", "owner"));
    const original = indexedDB.deleteDatabase.bind(indexedDB);
    indexedDB.deleteDatabase = (name) => {
      const request = original(name);
      request.addEventListener("blocked", () => { deletionBlocked = true; });
      return request;
    };
  },
  deletionBlocked: () => deletionBlocked,
  unblockYjsDeletion() { blockedConnection?.close(); blockedConnection = undefined; },
  async abortCacheCleanup() {
    try {
      await cache.clearCachedNoteForEncryptionConversion("note", "owner", () => {
        // Fail after attachment/job deletes, before notes delete/transaction commit.
        if (++checks === 5) throw new Error("injected scope failure");
      });
      return "unexpected success";
    } catch { return "failed"; }
    finally { checks = 0; }
  },
};
let checks = 0;
declare global { interface Window { conversionCleanupHarness: typeof harness } }
window.conversionCleanupHarness = harness;
