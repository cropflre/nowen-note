import { openDB, type IDBPDatabase, type DBSchema } from "idb";
import type { Habit, HabitCheckin, Note, NoteListItem, Notebook, Tag, Task, TaskDependency, TaskReminder } from "@/types";

/** Extra IndexedDB-only metadata. It is never sent to the server. */
export type CachedNote = Note & {
  __detailCached?: boolean;
};

type CachedTask = Task & { __cacheWorkspaceId: string };
type CachedHabit = Habit & { __cacheWorkspaceId: string };
type CachedHabitCheckin = HabitCheckin & { __cacheWorkspaceId: string };
type CachedTaskDependency = TaskDependency & { __cacheWorkspaceId: string };
type CachedTaskReminder = TaskReminder & { __cacheWorkspaceId: string };

interface NowenCacheSchema extends DBSchema {
  notebooks: {
    key: string;
    value: Notebook;
    indexes: {
      "by-parent": string;
      "by-updated": string;
    };
  };
  notes: {
    key: string;
    value: CachedNote;
    indexes: {
      "by-notebook": string;
      "by-updated": string;
      "by-trashed": number;
    };
  };
  tags: {
    key: string;
    value: Tag;
  };
  tasks: {
    key: string;
    value: CachedTask;
    indexes: {
      "by-workspace": string;
    };
  };
  habits: {
    key: string;
    value: CachedHabit;
    indexes: {
      "by-workspace": string;
    };
  };
  habitCheckins: {
    key: string;
    value: CachedHabitCheckin;
    indexes: {
      "by-workspace": string;
      "by-habit": string;
    };
  };
  taskDependencies: {
    key: string;
    value: CachedTaskDependency;
    indexes: {
      "by-workspace": string;
    };
  };
  taskReminders: {
    key: string;
    value: CachedTaskReminder;
    indexes: {
      "by-task": string;
    };
  };
  meta: {
    key: string;
    value: {
      key: string;
      value: unknown;
      updatedAt: number;
    };
  };
}

const DB_NAME_PREFIX = "nowen-cache-v2-";
const DB_VERSION = 3;

let currentUserId: string | null = null;
let currentCacheIdentity: string | null = null;
let dbPromise: Promise<IDBPDatabase<NowenCacheSchema>> | null = null;

function normalizeDbPart(value: string): string {
  return (value || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function getServerScope(): string {
  let server = "";
  try { server = localStorage.getItem("nowen-server-url") || ""; } catch { /* ignore */ }
  const origin = typeof window !== "undefined" && window.location.origin.startsWith("http")
    ? window.location.origin
    : "";
  const isDesktop = typeof window !== "undefined" && !!(window as any).nowenDesktop?.isDesktop;

  if (isDesktop && ((server && isLoopbackUrl(server)) || (!server && origin && isLoopbackUrl(origin)))) {
    return "local-desktop";
  }
  if (server) return normalizeUrl(server);
  if (origin) return normalizeUrl(origin);
  return "same-origin";
}

function getCacheIdentity(userId: string): string {
  return `${normalizeDbPart(getServerScope())}-${normalizeDbPart(userId)}`;
}

function getDbName(cacheIdentity: string): string {
  return `${DB_NAME_PREFIX}${cacheIdentity}`;
}

function cacheWorkspaceId(workspaceId: string | null): string {
  return workspaceId || "personal";
}

export function setCurrentUser(userId: string | null): void {
  const nextIdentity = userId ? getCacheIdentity(userId) : null;
  if (currentUserId === userId && currentCacheIdentity === nextIdentity) return;
  if (dbPromise) {
    dbPromise.then((db) => {
      try { db.close(); } catch { /* ignore */ }
    }).catch(() => { /* ignore */ });
    dbPromise = null;
  }
  currentUserId = userId;
  currentCacheIdentity = nextIdentity;
}

function getDb(): Promise<IDBPDatabase<NowenCacheSchema>> | null {
  if (!currentCacheIdentity) return null;
  if (!dbPromise) {
    dbPromise = openDB<NowenCacheSchema>(getDbName(currentCacheIdentity), DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("notebooks")) {
          const store = db.createObjectStore("notebooks", { keyPath: "id" });
          store.createIndex("by-parent", "parentId");
          store.createIndex("by-updated", "updatedAt");
        }
        if (!db.objectStoreNames.contains("notes")) {
          const store = db.createObjectStore("notes", { keyPath: "id" });
          store.createIndex("by-notebook", "notebookId");
          store.createIndex("by-updated", "updatedAt");
          store.createIndex("by-trashed", "isTrashed");
        }
        if (!db.objectStoreNames.contains("tags")) {
          db.createObjectStore("tags", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("tasks")) {
          const store = db.createObjectStore("tasks", { keyPath: "id" });
          store.createIndex("by-workspace", "__cacheWorkspaceId");
        }
        if (!db.objectStoreNames.contains("habits")) {
          const store = db.createObjectStore("habits", { keyPath: "id" });
          store.createIndex("by-workspace", "__cacheWorkspaceId");
        }
        if (!db.objectStoreNames.contains("habitCheckins")) {
          const store = db.createObjectStore("habitCheckins", { keyPath: "id" });
          store.createIndex("by-workspace", "__cacheWorkspaceId");
          store.createIndex("by-habit", "habitId");
        }
        if (!db.objectStoreNames.contains("taskDependencies")) {
          const store = db.createObjectStore("taskDependencies", { keyPath: "id" });
          store.createIndex("by-workspace", "__cacheWorkspaceId");
        }
        if (!db.objectStoreNames.contains("taskReminders")) {
          const store = db.createObjectStore("taskReminders", { keyPath: "id" });
          store.createIndex("by-task", "taskId");
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
      },
      blocked() {
        console.warn("[localStore] db blocked by another tab/version");
      },
      blocking() {
        console.warn("[localStore] db blocking newer version, will close");
      },
    }).catch((error) => {
      console.warn("[localStore] openDB failed:", error);
      throw error;
    });
  }
  return dbPromise;
}

async function safe<T>(operation: () => Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    console.warn(`[localStore] ${label} failed:`, error);
    return fallback;
  }
}

export function isNoteDetailCached(note: Partial<CachedNote> | null | undefined): boolean {
  if (!note) return false;
  if (note.__detailCached === true) return true;
  if (note.__detailCached === false) return false;
  // Compatibility for caches written before the marker existed. A non-empty legacy body
  // could only have come from a detail response; an empty body remains ambiguous and is
  // treated as a list placeholder until it is fetched again.
  return typeof note.content === "string" && note.content.length > 0;
}

export async function putNotebooks(notebooks: Notebook[]): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("notebooks", "readwrite");
    await Promise.all(notebooks.map((notebook) => transaction.store.put(notebook)));
    await transaction.done;
  }, undefined, "putNotebooks");
}

export async function getAllNotebooks(): Promise<Notebook[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(async () => (await connection).getAll("notebooks"), [], "getAllNotebooks");
}

export async function deleteNotebook(id: string): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => { await (await connection).delete("notebooks", id); }, undefined, "deleteNotebook");
}

/**
 * Upsert a note while preserving an explicit placeholder/detail marker.
 * Full server-detail callers must pass `__detailCached: true`; metadata-only rewrites from
 * an existing cache object retain `false` and cannot manufacture an empty detail.
 */
export async function putNote(note: CachedNote): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  const detailCached = note.__detailCached === true
    ? true
    : note.__detailCached === false
      ? false
      : typeof note.content === "string" && note.content.length > 0;
  await safe(async () => {
    const db = await connection;
    await db.put("notes", { ...note, __detailCached: detailCached });
  }, undefined, "putNote");
}

/** Merge lightweight list metadata without manufacturing a valid empty detail. */
export async function putNoteListItems(items: NoteListItem[]): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("notes", "readwrite");
    for (const item of items) {
      const existing = await transaction.store.get(item.id);
      const canKeepDetail = !!(
        existing &&
        existing.version === item.version &&
        isNoteDetailCached(existing)
      );

      if (canKeepDetail) {
        const merged: CachedNote = {
          ...existing!,
          ...item,
          content: existing!.content,
          contentText: existing!.contentText,
          __detailCached: true,
        };
        await transaction.store.put(merged);
      } else {
        const placeholder: CachedNote = {
          ...item,
          content: "",
          contentText: item.contentText ?? "",
          trashedAt: existing?.trashedAt ?? null,
          sortOrder: existing?.sortOrder ?? 0,
          __detailCached: false,
        } as CachedNote;
        await transaction.store.put(placeholder);
      }
    }
    await transaction.done;
  }, undefined, "putNoteListItems");
}

export async function getNote(id: string): Promise<CachedNote | undefined> {
  const connection = getDb();
  if (!connection) return undefined;
  return safe(async () => (await connection).get("notes", id), undefined, "getNote");
}

export async function getAllNotes(): Promise<CachedNote[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(async () => (await connection).getAll("notes"), [], "getAllNotes");
}

export async function getNotesByNotebook(notebookId: string): Promise<CachedNote[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(
    async () => (await connection).getAllFromIndex("notes", "by-notebook", notebookId),
    [],
    "getNotesByNotebook",
  );
}

export async function deleteNote(id: string): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    await (await connection).delete("notes", id);
    console.log("[localStore] deleteNote", id);
  }, undefined, "deleteNote");
}

export async function putTags(tags: Tag[]): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("tags", "readwrite");
    await Promise.all(tags.map((tag) => transaction.store.put(tag)));
    await transaction.done;
  }, undefined, "putTags");
}

export async function getAllTags(): Promise<Tag[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(async () => (await connection).getAll("tags"), [], "getAllTags");
}

export async function deleteTag(id: string): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => { await (await connection).delete("tags", id); }, undefined, "deleteTag");
}

async function replaceWorkspaceSnapshot(
  storeName: "tasks" | "habits" | "habitCheckins" | "taskDependencies" | "taskReminders",
  workspaceId: string | null,
  items: CachedTask[] | CachedHabit[] | CachedHabitCheckin[] | CachedTaskDependency[] | CachedTaskReminder[],
): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.store as any;
    const existingKeys = storeName === "taskReminders"
      ? (await store.getAll() as CachedTaskReminder[])
        .filter((item: CachedTaskReminder) => item.__cacheWorkspaceId === cacheWorkspaceId(workspaceId))
        .map((item: CachedTaskReminder) => item.id)
      : await store.index("by-workspace").getAllKeys(cacheWorkspaceId(workspaceId));
    await Promise.all(existingKeys.map((key: string) => store.delete(key)));
    await Promise.all(items.map((item) => store.put(item)));
    await transaction.done;
  }, undefined, `replace ${storeName} snapshot`);
}

export async function putTasks(tasks: Task[], workspaceId: string | null): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("tasks", "readwrite");
    await Promise.all(tasks.map((task) => transaction.store.put({
      ...task,
      __cacheWorkspaceId: cacheWorkspaceId(workspaceId),
    })));
    await transaction.done;
  }, undefined, "putTasks");
}

export function replaceTasksSnapshot(tasks: Task[], workspaceId: string | null): Promise<void> {
  return replaceWorkspaceSnapshot("tasks", workspaceId, tasks.map((task) => ({
    ...task,
    __cacheWorkspaceId: cacheWorkspaceId(workspaceId),
  })));
}

export async function getTasks(workspaceId: string | null): Promise<Task[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(
    async () => (await connection).getAllFromIndex("tasks", "by-workspace", cacheWorkspaceId(workspaceId)),
    [],
    "getTasks",
  );
}

export async function deleteTask(id: string): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => { await (await connection).delete("tasks", id); }, undefined, "deleteTask");
}

export async function putHabits(habits: Habit[], workspaceId: string | null): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("habits", "readwrite");
    await Promise.all(habits.map((habit) => transaction.store.put({
      ...habit,
      __cacheWorkspaceId: cacheWorkspaceId(workspaceId),
    })));
    await transaction.done;
  }, undefined, "putHabits");
}

export function replaceHabitsSnapshot(habits: Habit[], workspaceId: string | null): Promise<void> {
  return replaceWorkspaceSnapshot("habits", workspaceId, habits.map((habit) => ({
    ...habit,
    __cacheWorkspaceId: cacheWorkspaceId(workspaceId),
  })));
}

export async function getHabits(workspaceId: string | null): Promise<Habit[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(
    async () => (await connection).getAllFromIndex("habits", "by-workspace", cacheWorkspaceId(workspaceId)),
    [],
    "getHabits",
  );
}

export async function deleteHabit(id: string): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => { await (await connection).delete("habits", id); }, undefined, "deleteHabit");
}

export async function putHabitCheckins(checkins: HabitCheckin[], workspaceId: string | null): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("habitCheckins", "readwrite");
    await Promise.all(checkins.map((checkin) => transaction.store.put({
      ...checkin,
      __cacheWorkspaceId: cacheWorkspaceId(workspaceId),
    })));
    await transaction.done;
  }, undefined, "putHabitCheckins");
}

export function replaceHabitCheckinsSnapshot(checkins: HabitCheckin[], workspaceId: string | null): Promise<void> {
  return replaceWorkspaceSnapshot("habitCheckins", workspaceId, checkins.map((checkin) => ({
    ...checkin,
    __cacheWorkspaceId: cacheWorkspaceId(workspaceId),
  })));
}

export async function getHabitCheckins(workspaceId: string | null): Promise<HabitCheckin[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(
    async () => (await connection).getAllFromIndex("habitCheckins", "by-workspace", cacheWorkspaceId(workspaceId)),
    [],
    "getHabitCheckins",
  );
}

export async function putTaskDependencies(dependencies: TaskDependency[], workspaceId: string | null): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const transaction = (await connection).transaction("taskDependencies", "readwrite");
    await Promise.all(dependencies.map((dependency) => transaction.store.put({
      ...dependency,
      __cacheWorkspaceId: cacheWorkspaceId(workspaceId),
    })));
    await transaction.done;
  }, undefined, "putTaskDependencies");
}

export function replaceTaskDependenciesSnapshot(dependencies: TaskDependency[], workspaceId: string | null): Promise<void> {
  return replaceWorkspaceSnapshot("taskDependencies", workspaceId, dependencies.map((dependency) => ({
    ...dependency,
    __cacheWorkspaceId: cacheWorkspaceId(workspaceId),
  })));
}

export async function getTaskDependencies(workspaceId: string | null): Promise<TaskDependency[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(
    async () => (await connection).getAllFromIndex("taskDependencies", "by-workspace", cacheWorkspaceId(workspaceId)),
    [],
    "getTaskDependencies",
  );
}

export async function deleteTaskDependency(id: string): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => { await (await connection).delete("taskDependencies", id); }, undefined, "deleteTaskDependency");
}

export async function putTaskReminders(reminders: TaskReminder[], workspaceId: string | null = null): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const transaction = (await connection).transaction("taskReminders", "readwrite");
    await Promise.all(reminders.map((reminder) => transaction.store.put({
      ...reminder,
      __cacheWorkspaceId: cacheWorkspaceId(workspaceId),
    })));
    await transaction.done;
  }, undefined, "putTaskReminders");
}

export function replaceTaskRemindersSnapshot(reminders: TaskReminder[], workspaceId: string | null): Promise<void> {
  return replaceWorkspaceSnapshot("taskReminders", workspaceId, reminders.map((reminder) => ({
    ...reminder,
    __cacheWorkspaceId: cacheWorkspaceId(workspaceId),
  })));
}

export async function getTaskRemindersForWorkspace(workspaceId: string | null): Promise<TaskReminder[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(async () => {
    const reminders = await (await connection).getAll("taskReminders");
    return reminders
      .filter((reminder) => reminder.__cacheWorkspaceId === cacheWorkspaceId(workspaceId))
      .map(({ __cacheWorkspaceId: _cacheWorkspaceId, ...reminder }) => reminder);
  }, [], "getTaskRemindersForWorkspace");
}

export async function getTaskReminders(taskId: string): Promise<TaskReminder[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(
    async () => (await connection).getAllFromIndex("taskReminders", "by-task", taskId),
    [],
    "getTaskReminders",
  );
}

export async function getTaskReminder(id: string): Promise<TaskReminder | undefined> {
  const connection = getDb();
  if (!connection) return undefined;
  return safe(async () => {
    const reminder = await (await connection).get("taskReminders", id);
    if (!reminder) return undefined;
    const { __cacheWorkspaceId: _cacheWorkspaceId, ...value } = reminder;
    return value;
  }, undefined, "getTaskReminder");
}

export async function deleteTaskReminder(id: string): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => { await (await connection).delete("taskReminders", id); }, undefined, "deleteTaskReminder");
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    await (await connection).put("meta", { key, value, updatedAt: Date.now() });
  }, undefined, "setMeta");
}

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  const connection = getDb();
  if (!connection) return undefined;
  return safe(async () => {
    const row = await (await connection).get("meta", key);
    return row?.value as T | undefined;
  }, undefined, "getMeta");
}

export async function clearAll(): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction(["notebooks", "notes", "tags", "tasks", "habits", "habitCheckins", "taskDependencies", "taskReminders", "meta"], "readwrite");
    await Promise.all([
      transaction.objectStore("notebooks").clear(),
      transaction.objectStore("notes").clear(),
      transaction.objectStore("tags").clear(),
      transaction.objectStore("tasks").clear(),
      transaction.objectStore("habits").clear(),
      transaction.objectStore("habitCheckins").clear(),
      transaction.objectStore("taskDependencies").clear(),
      transaction.objectStore("taskReminders").clear(),
      transaction.objectStore("meta").clear(),
    ]);
    await transaction.done;
  }, undefined, "clearAll");
}

export function isReady(): boolean {
  return !!currentCacheIdentity;
}

export function getCurrentUserId(): string | null {
  return currentUserId;
}
