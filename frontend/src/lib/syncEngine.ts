import { api } from "@/lib/api";
import {
  setCurrentUser,
  putNotebooks,
  putNoteListItems,
  putNote,
  putTags,
  setMeta,
  getMeta,
  getAllNotes,
  getAllNotebooks,
  getAllTags,
  deleteNote,
  deleteNotebook,
  deleteTag,
  isReady as localStoreReady,
} from "@/lib/localStore";
import {
  flushQueue,
  getQueue as getOfflineQueue,
  getQueueLength,
  subscribe as subscribeOfflineQueue,
} from "@/lib/offlineQueue";
import { offlineQueueFetch } from "@/lib/offlineQueueFetch";
import type { Note, User } from "@/types";

type SyncState = "idle" | "bootstrapping" | "ready" | "error";
let state: SyncState = "idle";
let lastError: string | null = null;
const stateListeners = new Set<(state: SyncState) => void>();

export interface SyncSummary {
  state: SyncState;
  lastError: string | null;
  pending: number;
  lastSyncAt: number | null;
}

const summaryListeners = new Set<(summary: SyncSummary) => void>();
let lastSyncAtCache: number | null = null;
let queueSubscribed = false;

function buildSummary(): SyncSummary {
  return { state, lastError, pending: getQueueLength(), lastSyncAt: lastSyncAtCache };
}

function notifySummary(): void {
  const summary = buildSummary();
  summaryListeners.forEach((listener) => {
    try { listener(summary); } catch { /* listener isolation */ }
  });
}

function setState(next: SyncState, error?: string): void {
  state = next;
  lastError = error || null;
  stateListeners.forEach((listener) => {
    try { listener(next); } catch { /* listener isolation */ }
  });
  notifySummary();
}

export function getSyncState(): { state: SyncState; lastError: string | null } {
  return { state, lastError };
}

export function subscribeSyncState(listener: (state: SyncState) => void): () => void {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}

export function getSyncSummary(): SyncSummary {
  return buildSummary();
}

export function subscribeSyncSummary(listener: (summary: SyncSummary) => void): () => void {
  if (!queueSubscribed) {
    queueSubscribed = true;
    subscribeOfflineQueue(() => notifySummary());
  }
  summaryListeners.add(listener);
  listener(buildSummary());
  return () => { summaryListeners.delete(listener); };
}

async function pullServerSnapshot(): Promise<void> {
  const [notebooksResult, notesResult, tagsResult] = await Promise.allSettled([
    api.getNotebooks(),
    api.getNotes(),
    api.getTags(),
  ]);

  if (notebooksResult.status === "fulfilled") {
    const local = await getAllNotebooks();
    const remoteIds = new Set(notebooksResult.value.map((notebook) => notebook.id));
    for (const notebook of local) {
      if (!remoteIds.has(notebook.id)) await deleteNotebook(notebook.id);
    }
    await putNotebooks(notebooksResult.value);
  } else {
    console.warn("[syncEngine] pull notebooks failed:", notebooksResult.reason);
  }

  if (notesResult.status === "fulfilled") {
    const local = await getAllNotes();
    const remoteIds = new Set(notesResult.value.map((note) => note.id));
    const queuedIds = await getQueuedNoteIds();
    for (const note of local) {
      if (!remoteIds.has(note.id) && !queuedIds.has(note.id)) await deleteNote(note.id);
    }
    await putNoteListItems(notesResult.value);
  } else {
    console.warn("[syncEngine] pull notes list failed:", notesResult.reason);
  }

  if (tagsResult.status === "fulfilled") {
    const local = await getAllTags();
    const remoteIds = new Set(tagsResult.value.map((tag) => tag.id));
    for (const tag of local) {
      if (!remoteIds.has(tag.id)) await deleteTag(tag.id);
    }
    await putTags(tagsResult.value);
  } else {
    console.warn("[syncEngine] pull tags failed:", tagsResult.reason);
  }

  lastSyncAtCache = Date.now();
  await setMeta("lastSyncAt", lastSyncAtCache);
  notifySummary();
}

export async function bootstrap(user: User): Promise<void> {
  setCurrentUser(user.id);
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    setState("ready");
    return;
  }

  setState("bootstrapping");
  try {
    if (getOfflineQueue().length > 0) {
      await flushQueue(offlineQueueFetch).catch((error) => {
        console.warn("[syncEngine] flush offline queue before pull failed:", error);
      });
    }
    await pullServerSnapshot();
    setState("ready");
  } catch (error) {
    console.warn("[syncEngine] bootstrap failed:", error);
    setState("error", error instanceof Error ? error.message : String(error));
  }
}

export async function syncNow(): Promise<{
  ok: boolean;
  pending: number;
  lastSyncAt?: number;
  error?: string;
}> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const error = "offline";
    setState("error", error);
    return { ok: false, pending: getQueueLength(), lastSyncAt: lastSyncAtCache ?? undefined, error };
  }

  setState("bootstrapping");
  try {
    if (getQueueLength() > 0) await flushQueue(offlineQueueFetch);
    await pullServerSnapshot();
    setState("ready");
    return { ok: true, pending: getQueueLength(), lastSyncAt: lastSyncAtCache ?? undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[syncEngine] syncNow failed:", error);
    setState("error", message);
    return { ok: false, pending: getQueueLength(), lastSyncAt: lastSyncAtCache ?? undefined, error: message };
  }
}

async function getQueuedNoteIds(): Promise<Set<string>> {
  try {
    return new Set(getOfflineQueue().map((item) => item.noteId));
  } catch {
    return new Set();
  }
}

export function teardown(): void {
  setCurrentUser(null);
  setState("idle");
}

export async function getLastSyncAt(): Promise<number | null> {
  if (!localStoreReady()) return null;
  const value = await getMeta<number>("lastSyncAt");
  lastSyncAtCache = typeof value === "number" ? value : null;
  notifySummary();
  return lastSyncAtCache;
}

export function isCompleteNoteDetail(note: unknown): note is Note {
  const value = note as Partial<Note> | null;
  return !!value &&
    typeof value.id === "string" && value.id.length > 0 &&
    typeof value.userId === "string" && value.userId.length > 0 &&
    typeof value.notebookId === "string" && value.notebookId.length > 0 &&
    typeof value.title === "string" &&
    typeof value.content === "string" &&
    typeof value.contentText === "string" &&
    typeof value.version === "number" && Number.isFinite(value.version) &&
    typeof value.createdAt === "string" && value.createdAt.length > 0 &&
    typeof value.updatedAt === "string" && value.updatedAt.length > 0;
}

export async function cacheNoteContent(note: Note): Promise<void> {
  if (!localStoreReady()) return;
  if (!isCompleteNoteDetail(note)) {
    console.warn("[syncEngine] refused incomplete note detail cache write", {
      id: (note as any)?.id,
      version: (note as any)?.version,
      userId: (note as any)?.userId,
      notebookId: (note as any)?.notebookId,
      hasContent: typeof (note as any)?.content === "string",
      hasContentText: typeof (note as any)?.contentText === "string",
    });
    return;
  }
  try {
    await putNote(note);
  } catch (error) {
    console.warn("[syncEngine] cacheNoteContent failed:", error);
  }
}
