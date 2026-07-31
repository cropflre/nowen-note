import { api, getCurrentWorkspace } from "@/lib/api";
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
  discardNoteQueueItems,
  getFailedQueueItems,
  getQueue as getOfflineQueue,
  getQueueLength,
  subscribe as subscribeOfflineQueue,
  type OfflineQueueItem,
} from "@/lib/offlineQueue";
import { offlineQueueFetch } from "@/lib/offlineQueueFetch";
import { resolveQueuedNoteConflicts } from "@/lib/conflictResolution";
import type { Note, User } from "@/types";
import {
  setOfflineSyncUser,
  stopOfflineWorkspaceSync,
  syncOfflineWorkspace,
} from "@/lib/offlineWorkspaceSync";

type SyncState = "idle" | "bootstrapping" | "ready" | "error";
let state: SyncState = "idle";
let lastError: string | null = null;
const stateListeners = new Set<(state: SyncState) => void>();

export const SYNC_SNAPSHOT_APPLIED_EVENT = "nowen:sync-snapshot-applied";

export interface SyncSummary {
  state: SyncState;
  lastError: string | null;
  pending: number;
  versionConflicts: number;
  lastSyncAt: number | null;
}

const summaryListeners = new Set<(summary: SyncSummary) => void>();
let lastSyncAtCache: number | null = null;
let queueSubscribed = false;

function buildSummary(): SyncSummary {
  const pending = getQueueLength();
  return {
    state,
    lastError,
    pending,
    versionConflicts: countVersionConflicts(getFailedQueueItems()),
    lastSyncAt: lastSyncAtCache,
  };
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

function describePendingQueue(pending: number): string {
  const failed = getFailedQueueItems();
  const conflicts = countVersionConflicts(failed);
  const blocked = failed.filter((item) => item.blocked && !item.conflict).length;
  const visiblePending = Math.max(0, pending - conflicts);
  if (blocked > 0) {
    return `仍有 ${visiblePending} 条待同步操作，其中 ${blocked} 条已暂停自动重试；请查看失败原因后重试或导出诊断。`;
  }
  return `仍有 ${visiblePending} 条待同步操作，服务器尚未确认完成，请稍后重试。`;
}

export function countVersionConflicts(
  items: ReadonlyArray<Pick<OfflineQueueItem, "conflict" | "errorCode">>,
): number {
  return items.filter((item) => item.conflict || item.errorCode === "VERSION_CONFLICT").length;
}

async function resolveConfiguredVersionConflicts(): Promise<void> {
  const result = await resolveQueuedNoteConflicts(getOfflineQueue());
  if (result.failed > 0) {
    console.warn("[syncEngine] automatic server-version conflict resolution incomplete", {
      attempted: result.attempted,
      resolved: result.resolved,
      failures: result.failures,
    });
  }
}

export function findLocallyDeletedQueuedNoteIds(
  localNotes: ReadonlyArray<{ id: string; isTrashed: number }>,
  queuedItems: ReadonlyArray<{ noteId: string }>,
): string[] {
  const queuedIds = new Set(queuedItems.map((item) => item.noteId));
  return localNotes
    .filter((note) => note.isTrashed === 1 && queuedIds.has(note.id))
    .map((note) => note.id);
}

export async function findServerDeletedQueuedNoteIds(
  remoteNoteIds: ReadonlySet<string>,
  queuedItems: ReadonlyArray<Pick<OfflineQueueItem, "noteId" | "type" | "conflict" | "errorCode">>,
  fetchNote: (noteId: string) => Promise<{ isTrashed?: number }>,
): Promise<string[]> {
  const candidates = [...new Set(queuedItems
    .filter((item) => (
      item.type === "updateNote"
      && (item.conflict || item.errorCode === "VERSION_CONFLICT")
      && !remoteNoteIds.has(item.noteId)
    ))
    .map((item) => item.noteId))];
  const deleted: string[] = [];

  for (const noteId of candidates) {
    try {
      const note = await fetchNote(noteId);
      if (note.isTrashed === 1) deleted.push(noteId);
    } catch (error) {
      if ((error as { status?: number })?.status === 404) deleted.push(noteId);
    }
  }

  return deleted;
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
  const currentWorkspace = getCurrentWorkspace();
  const currentWorkspaceId = currentWorkspace === "personal" ? null : currentWorkspace;
  const isCurrentScope = (value: { workspaceId?: string | null }) =>
    (value.workspaceId ?? null) === currentWorkspaceId;
  const [notebooksResult, notesResult, tagsResult] = await Promise.allSettled([
    api.getNotebooks(),
    api.getNotes(),
    api.getTags(),
  ]);

  const pullErrors: string[] = [];

  if (notebooksResult.status === "fulfilled") {
    const local = (await getAllNotebooks()).filter(isCurrentScope);
    const remoteIds = new Set(notebooksResult.value.map((notebook) => notebook.id));
    for (const notebook of local) {
      if (!remoteIds.has(notebook.id)) await deleteNotebook(notebook.id);
    }
    await putNotebooks(notebooksResult.value);
  } else {
    console.warn("[syncEngine] pull notebooks failed:", notebooksResult.reason);
    pullErrors.push(`笔记本：${notebooksResult.reason instanceof Error ? notebooksResult.reason.message : String(notebooksResult.reason)}`);
  }

  if (notesResult.status === "fulfilled") {
    const local = (await getAllNotes()).filter(isCurrentScope);
    // 兼容修复前遗留状态：本地缓存已经明确记录为回收站的笔记，不应继续保留
    // 它此前的更新冲突。不能仅根据远端普通列表缺失来判断，避免误删离线新建内容。
    const locallyDeletedQueueIds = findLocallyDeletedQueuedNoteIds(local, getOfflineQueue());
    discardNoteQueueItems(locallyDeletedQueueIds);
    const remoteIds = new Set(notesResult.value.map((note) => note.id));
    // 历史版本可能在删除成功后仍留下冲突队列。对列表中缺失的冲突做轻量确认：
    // 仅服务器明确返回 404 或回收站状态时清理，网络/权限异常继续保留本地内容。
    const serverDeletedQueueIds = await findServerDeletedQueuedNoteIds(
      remoteIds,
      getOfflineQueue(),
      (noteId) => api.getNoteSlim(noteId),
    );
    discardNoteQueueItems(serverDeletedQueueIds);
    const queuedIds = await getQueuedNoteIds();
    for (const note of local) {
      if (!remoteIds.has(note.id) && !queuedIds.has(note.id)) await deleteNote(note.id);
    }
    await putNoteListItems(notesResult.value);
  } else {
    console.warn("[syncEngine] pull notes list failed:", notesResult.reason);
    pullErrors.push(`笔记列表：${notesResult.reason instanceof Error ? notesResult.reason.message : String(notesResult.reason)}`);
  }

  if (tagsResult.status === "fulfilled") {
    const local = (await getAllTags()).filter(isCurrentScope);
    const remoteIds = new Set(tagsResult.value.map((tag) => tag.id));
    for (const tag of local) {
      if (!remoteIds.has(tag.id)) await deleteTag(tag.id);
    }
    await putTags(tagsResult.value);
  } else {
    console.warn("[syncEngine] pull tags failed:", tagsResult.reason);
    pullErrors.push(`标签：${tagsResult.reason instanceof Error ? tagsResult.reason.message : String(tagsResult.reason)}`);
  }

  if (pullErrors.length > 0) {
    throw new Error(`同步补拉未完整完成（${pullErrors.join("；")}）`);
  }

  lastSyncAtCache = Date.now();
  await setMeta("lastSyncAt", lastSyncAtCache);
  notifySummary();

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SYNC_SNAPSHOT_APPLIED_EVENT, {
      detail: {
        lastSyncAt: lastSyncAtCache,
        notesPulled: notesResult.status === "fulfilled",
        notebooksPulled: notebooksResult.status === "fulfilled",
        tagsPulled: tagsResult.status === "fulfilled",
      },
    }));
  }
}

export async function bootstrap(user: User): Promise<void> {
  setCurrentUser(user.id);
  setOfflineSyncUser(user.id);
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
    if (getOfflineQueue().length > 0) await resolveConfiguredVersionConflicts();
    await pullServerSnapshot();
    void syncOfflineWorkspace({ reason: "bootstrap" }).catch((error) => {
      console.warn("[syncEngine] complete offline bootstrap failed", error);
    });
    const pending = getQueueLength();
    const versionConflicts = countVersionConflicts(getFailedQueueItems());
    if (pending > versionConflicts) setState("error", describePendingQueue(pending));
    else setState("ready");
  } catch (error) {
    console.warn("[syncEngine] bootstrap failed:", error);
    setState("error", error instanceof Error ? error.message : String(error));
  }
}

export async function syncNow(): Promise<{
  ok: boolean;
  pending: number;
  versionConflicts: number;
  lastSyncAt?: number;
  error?: string;
}> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const error = "offline";
    setState("error", error);
    return {
      ok: false,
      pending: getQueueLength(),
      versionConflicts: countVersionConflicts(getFailedQueueItems()),
      lastSyncAt: lastSyncAtCache ?? undefined,
      error,
    };
  }

  setState("bootstrapping");
  try {
    if (getQueueLength() > 0) await flushQueue(offlineQueueFetch);
    if (getQueueLength() > 0) await resolveConfiguredVersionConflicts();
    await pullServerSnapshot();
    const offlineResult = await syncOfflineWorkspace({ force: true, reason: "manual" });
    if (offlineResult.state === "error") {
      throw new Error(offlineResult.lastError || "离线副本同步失败");
    }

    const pending = getQueueLength();
    const versionConflicts = countVersionConflicts(getFailedQueueItems());
    if (pending > versionConflicts) {
      const error = describePendingQueue(pending);
      setState("error", error);
      return { ok: false, pending, versionConflicts, lastSyncAt: lastSyncAtCache ?? undefined, error };
    }

    setState("ready");
    return { ok: true, pending, versionConflicts, lastSyncAt: lastSyncAtCache ?? undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[syncEngine] syncNow failed:", error);
    setState("error", message);
    return {
      ok: false,
      pending: getQueueLength(),
      versionConflicts: countVersionConflicts(getFailedQueueItems()),
      lastSyncAt: lastSyncAtCache ?? undefined,
      error: message,
    };
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
  stopOfflineWorkspaceSync();
  setOfflineSyncUser(null);
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
    await putNote({ ...note, __detailCached: true });
  } catch (error) {
    console.warn("[syncEngine] cacheNoteContent failed:", error);
  }
}
