import { api, getCurrentWorkspace } from "@/lib/api";
import {
  setCurrentUser,
  putNotebooks,
  putNoteListItems,
  putNote,
  putTags,
  replaceTasksSnapshot,
  getTasks,
  replaceHabitsSnapshot,
  getHabits,
  replaceHabitCheckinsSnapshot,
  getHabitCheckins,
  replaceTaskDependenciesSnapshot,
  getTaskDependencies,
  replaceTaskRemindersSnapshot,
  getTaskRemindersForWorkspace,
  deleteTaskReminder,
  setMeta,
  getMeta,
  getAllNotes,
  getAllNotebooks,
  getAllTags,
  deleteNote,
  deleteNotebook,
  deleteTag,
  clearAll,
  isReady as localStoreReady,
} from "@/lib/localStore";
import {
  flushQueue,
  discardNoteQueueItems,
  getFailedQueueItems,
  getQueue as getOfflineQueue,
  getQueueLength,
  clearQueue,
  clearLocalIdMap,
  subscribe as subscribeOfflineQueue,
  type OfflineQueueItem,
} from "@/lib/offlineQueue";
import { offlineQueueFetch } from "@/lib/offlineQueueFetch";
import type { Note, User } from "@/types";

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
  if (conflicts > 0) {
    return `仍有 ${pending} 条待同步操作，其中 ${conflicts} 条存在版本冲突；本地内容已保留，请在同步状态面板处理。`;
  }
  if (blocked > 0) {
    return `仍有 ${pending} 条待同步操作，其中 ${blocked} 条已暂停自动重试；请查看失败原因后重试或导出诊断。`;
  }
  return `仍有 ${pending} 条待同步操作，服务器尚未确认完成，请稍后重试。`;
}

export function countVersionConflicts(
  items: ReadonlyArray<Pick<OfflineQueueItem, "conflict" | "errorCode">>,
): number {
  return items.filter((item) => item.conflict || item.errorCode === "VERSION_CONFLICT").length;
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
  const workspaceId = getCurrentWorkspace() === "personal" ? null : getCurrentWorkspace();
  const [notebooksResult, notesResult, tagsResult, tasksResult, habitsResult, habitCheckinsResult, dependenciesResult, remindersResult] = await Promise.allSettled([
    api.getNotebooks(),
    api.getNotes(),
    api.getTags(),
    api.getTasks("all"),
    api.getHabits(true),
    api.getHabitCheckinLog({ includeArchived: true }),
    api.getTaskDependencies(),
    api.getTaskRemindersSnapshot(),
  ]);

  const pullErrors: string[] = [];
  const pendingResourceItems = getOfflineQueue();
  const pendingTaskIds = new Set(pendingResourceItems
    .filter((item) => item.type === "createTask" || item.type === "updateTask" || item.type === "toggleTask" || item.type === "deleteTask")
    .map((item) => item.noteId));
  const pendingDeletedTaskIds = new Set(pendingResourceItems
    .filter((item) => item.type === "deleteTask")
    .map((item) => item.noteId));
  const pendingHabitIds = new Set(pendingResourceItems
    .filter((item) => item.type === "createHabit" || item.type === "updateHabit" || item.type === "archiveHabit" || item.type === "deleteHabit" || item.type === "checkInHabit")
    .map((item) => item.noteId));
  const pendingDeletedHabitIds = new Set(pendingResourceItems
    .filter((item) => item.type === "deleteHabit")
    .map((item) => item.noteId));
  const pendingCheckinHabitIds = new Set(pendingResourceItems
    .filter((item) => item.type === "checkInHabit")
    .map((item) => item.noteId));
  const pendingDependencyIds = new Set(pendingResourceItems
    .filter((item) => item.type === "createTaskDependency" || item.type === "deleteTaskDependency")
    .map((item) => item.noteId));
  const pendingDeletedDependencyIds = new Set(pendingResourceItems
    .filter((item) => item.type === "deleteTaskDependency")
    .map((item) => item.noteId));
  const pendingReminderIds = new Set(pendingResourceItems
    .filter((item) => item.type === "createTaskReminder" || item.type === "updateTaskReminder" || item.type === "deleteTaskReminder")
    .map((item) => item.noteId));
  const pendingDeletedReminderIds = new Set(pendingResourceItems
    .filter((item) => item.type === "deleteTaskReminder")
    .map((item) => item.noteId));

  if (notebooksResult.status === "fulfilled") {
    const local = await getAllNotebooks();
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
    const local = await getAllNotes();
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
    const local = await getAllTags();
    const remoteIds = new Set(tagsResult.value.map((tag) => tag.id));
    for (const tag of local) {
      if (!remoteIds.has(tag.id)) await deleteTag(tag.id);
    }
    await putTags(tagsResult.value);
  } else {
    console.warn("[syncEngine] pull tags failed:", tagsResult.reason);
    pullErrors.push(`标签：${tagsResult.reason instanceof Error ? tagsResult.reason.message : String(tagsResult.reason)}`);
  }

  if (tasksResult.status === "fulfilled") {
    const localTasks = await getTasks(workspaceId);
    const localById = new Map(localTasks.map((task) => [task.id, task]));
    const remoteIds = new Set(tasksResult.value.map((task) => task.id));
    const merged = tasksResult.value
      .filter((task) => !pendingDeletedTaskIds.has(task.id))
      .map((task) => pendingTaskIds.has(task.id) ? localById.get(task.id) || task : task);
    merged.push(...localTasks.filter((task) => pendingTaskIds.has(task.id) && !remoteIds.has(task.id) && !pendingDeletedTaskIds.has(task.id)));
    await replaceTasksSnapshot(merged, workspaceId);
  } else {
    console.warn("[syncEngine] pull tasks failed:", tasksResult.reason);
    pullErrors.push(`任务：${tasksResult.reason instanceof Error ? tasksResult.reason.message : String(tasksResult.reason)}`);
  }

  if (habitsResult.status === "fulfilled") {
    const localHabits = await getHabits(workspaceId);
    const localById = new Map(localHabits.map((habit) => [habit.id, habit]));
    const remoteIds = new Set(habitsResult.value.map((habit) => habit.id));
    const merged = habitsResult.value
      .filter((habit) => !pendingDeletedHabitIds.has(habit.id))
      .map((habit) => pendingHabitIds.has(habit.id) ? localById.get(habit.id) || habit : habit);
    merged.push(...localHabits.filter((habit) => pendingHabitIds.has(habit.id) && !remoteIds.has(habit.id) && !pendingDeletedHabitIds.has(habit.id)));
    await replaceHabitsSnapshot(merged, workspaceId);
  } else {
    console.warn("[syncEngine] pull habits failed:", habitsResult.reason);
    pullErrors.push(`习惯：${habitsResult.reason instanceof Error ? habitsResult.reason.message : String(habitsResult.reason)}`);
  }

  if (habitCheckinsResult.status === "fulfilled") {
    const localCheckins = await getHabitCheckins(workspaceId);
    const localByCheckinKey = new Map(localCheckins.map((checkin) => [`${checkin.habitId}:${checkin.checkinDate}`, checkin]));
    const remoteCheckinKeys = new Set(habitCheckinsResult.value.map((checkin) => `${checkin.habitId}:${checkin.checkinDate}`));
    const merged = [
      ...habitCheckinsResult.value.map((checkin) => (
        pendingCheckinHabitIds.has(checkin.habitId)
          ? localByCheckinKey.get(`${checkin.habitId}:${checkin.checkinDate}`) || checkin
          : checkin
      )),
      ...localCheckins.filter((checkin) => pendingCheckinHabitIds.has(checkin.habitId) && !remoteCheckinKeys.has(`${checkin.habitId}:${checkin.checkinDate}`)),
    ];
    await replaceHabitCheckinsSnapshot(merged, workspaceId);
  } else {
    console.warn("[syncEngine] pull habit checkins failed:", habitCheckinsResult.reason);
    pullErrors.push(`习惯打卡：${habitCheckinsResult.reason instanceof Error ? habitCheckinsResult.reason.message : String(habitCheckinsResult.reason)}`);
  }

  if (dependenciesResult.status === "fulfilled") {
    const localDependencies = await getTaskDependencies(workspaceId);
    const localById = new Map(localDependencies.map((dependency) => [dependency.id, dependency]));
    const remoteIds = new Set(dependenciesResult.value.map((dependency) => dependency.id));
    const merged = dependenciesResult.value
      .filter((dependency) => !pendingDeletedDependencyIds.has(dependency.id))
      .map((dependency) => pendingDependencyIds.has(dependency.id) ? localById.get(dependency.id) || dependency : dependency);
    merged.push(...localDependencies.filter((dependency) => pendingDependencyIds.has(dependency.id) && !remoteIds.has(dependency.id) && !pendingDeletedDependencyIds.has(dependency.id)));
    await replaceTaskDependenciesSnapshot(merged, workspaceId);
  } else {
    console.warn("[syncEngine] pull task dependencies failed:", dependenciesResult.reason);
    pullErrors.push(`任务依赖：${dependenciesResult.reason instanceof Error ? dependenciesResult.reason.message : String(dependenciesResult.reason)}`);
  }

  if (remindersResult.status === "fulfilled") {
    const localReminders = await getTaskRemindersForWorkspace(workspaceId);
    const localById = new Map(localReminders.map((reminder) => [reminder.id, reminder]));
    const remoteIds = new Set(remindersResult.value.reminders.map((reminder) => reminder.id));
    const deletedIds = new Set(remindersResult.value.deletedIds);
    for (const reminderId of deletedIds) {
      if (!pendingReminderIds.has(reminderId)) await deleteTaskReminder(reminderId);
    }
    const merged = remindersResult.value.reminders
      .filter((reminder) => !pendingDeletedReminderIds.has(reminder.id))
      .map((reminder) => pendingReminderIds.has(reminder.id) ? localById.get(reminder.id) || reminder : reminder);
    merged.push(...localReminders.filter((reminder) => (
      pendingReminderIds.has(reminder.id)
      && !remoteIds.has(reminder.id)
      && !deletedIds.has(reminder.id)
      && !pendingDeletedReminderIds.has(reminder.id)
    )));
    await replaceTaskRemindersSnapshot(merged, workspaceId);
  } else {
    console.warn("[syncEngine] pull task reminders failed:", remindersResult.reason);
    pullErrors.push(`任务提醒：${remindersResult.reason instanceof Error ? remindersResult.reason.message : String(remindersResult.reason)}`);
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
        tasksPulled: tasksResult.status === "fulfilled",
        habitsPulled: habitsResult.status === "fulfilled",
        dependenciesPulled: dependenciesResult.status === "fulfilled",
        remindersPulled: remindersResult.status === "fulfilled",
      },
    }));
  }
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
    await pullServerSnapshot();

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
  void clearAll();
  clearQueue();
  clearLocalIdMap();
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
