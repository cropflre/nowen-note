import { openDB, type IDBPDatabase, type DBSchema } from "idb";
import type { Note, NoteListItem, Notebook, Tag } from "@/types";

/** Extra IndexedDB-only metadata. It is never sent to the server. */
export type CachedNote = Note & {
  __detailCached?: boolean;
};

export interface OfflineAttachmentRecord {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  blob: Blob;
  cachedAt: number;
}

export interface OfflineAttachmentJob {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  queuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
}

export interface OfflineStorageStats {
  cachedNotes: number;
  placeholderNotes: number;
  noteBytes: number;
  attachmentCount: number;
  attachmentBytes: number;
  totalBytes: number;
}

export interface OfflineScopeReconcileOptions {
  noteIds?: ReadonlySet<string>;
  notebookIds?: ReadonlySet<string>;
  tagIds?: ReadonlySet<string>;
  deleteNoteIds?: ReadonlySet<string>;
  preserveNoteIds?: ReadonlySet<string>;
}

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
  offlineAttachments: {
    key: string;
    value: OfflineAttachmentRecord;
    indexes: {
      "by-note": string;
      "by-cached": number;
    };
  };
  offlineAttachmentJobs: {
    key: string;
    value: OfflineAttachmentJob;
    indexes: {
      "by-note": string;
      "by-queued": number;
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
const DB_VERSION = 2;

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
        if (!db.objectStoreNames.contains("offlineAttachments")) {
          const store = db.createObjectStore("offlineAttachments", { keyPath: "id" });
          store.createIndex("by-note", "noteId");
          store.createIndex("by-cached", "cachedAt");
        }
        if (!db.objectStoreNames.contains("offlineAttachmentJobs")) {
          const store = db.createObjectStore("offlineAttachmentJobs", { keyPath: "id" });
          store.createIndex("by-note", "noteId");
          store.createIndex("by-queued", "queuedAt");
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

/** 在一个 IndexedDB 事务中批量移除笔记，供清空回收站的实时事件使用。 */
export async function deleteNotes(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("notes", "readwrite");
    await Promise.all(ids.map((id) => transaction.store.delete(id)));
    await transaction.done;
  }, undefined, "deleteNotes");
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
    const attachmentIds = (await db.getAllKeys("offlineAttachments")).map(String);
    const transaction = db.transaction(["notebooks", "notes", "tags", "offlineAttachments", "offlineAttachmentJobs", "meta"], "readwrite");
    await Promise.all([
      transaction.objectStore("notebooks").clear(),
      transaction.objectStore("notes").clear(),
      transaction.objectStore("tags").clear(),
      transaction.objectStore("offlineAttachments").clear(),
      transaction.objectStore("offlineAttachmentJobs").clear(),
      transaction.objectStore("meta").clear(),
    ]);
    dispatchOfflineAttachmentRemoval(attachmentIds);
    await transaction.done;
  }, undefined, "clearAll");
}



/** Offline snapshot writes are strict: quota or transaction failures must stop cursor advancement. */
export async function putCompleteOfflineNote(note: CachedNote): Promise<void> {
  const connection = getDb();
  if (!connection) throw new Error("离线数据库尚未初始化");
  const detailCached = note.__detailCached === true
    || (note.__detailCached !== false && typeof note.content === "string");
  await (await connection).put("notes", { ...note, __detailCached: detailCached });
}

export async function putCompleteOfflineNotebooks(notebooks: Notebook[]): Promise<void> {
  const connection = getDb();
  if (!connection) throw new Error("离线数据库尚未初始化");
  const db = await connection;
  const transaction = db.transaction("notebooks", "readwrite");
  for (const notebook of notebooks) await transaction.store.put(notebook);
  await transaction.done;
}

export async function putCompleteOfflineTags(tags: Tag[]): Promise<void> {
  const connection = getDb();
  if (!connection) throw new Error("离线数据库尚未初始化");
  const db = await connection;
  const transaction = db.transaction("tags", "readwrite");
  for (const tag of tags) await transaction.store.put(tag);
  await transaction.done;
}

function dispatchOfflineAttachmentRemoval(ids: readonly string[]): void {
  if (ids.length === 0 || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("nowen:offline-attachments-removed", {
    detail: { ids: [...ids] },
  }));
}

export async function putOfflineAttachment(record: OfflineAttachmentRecord): Promise<void> {
  const connection = getDb();
  if (!connection) throw new Error("离线数据库尚未初始化");
  await (await connection).put("offlineAttachments", record);
}


export async function putOfflineAttachmentJob(job: OfflineAttachmentJob): Promise<void> {
  const connection = getDb();
  if (!connection) throw new Error("离线数据库尚未初始化");
  await (await connection).put("offlineAttachmentJobs", job);
}

export async function getAllOfflineAttachmentJobs(): Promise<OfflineAttachmentJob[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(
    async () => (await connection).getAllFromIndex("offlineAttachmentJobs", "by-queued"),
    [],
    "getAllOfflineAttachmentJobs",
  );
}

export async function deleteOfflineAttachmentJob(id: string): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await (await connection).delete("offlineAttachmentJobs", id);
}

export async function deleteOfflineAttachmentJobsByNote(noteId: string): Promise<string[]> {
  const connection = getDb();
  if (!connection) return [];
  const db = await connection;
  const jobs = await db.getAllFromIndex("offlineAttachmentJobs", "by-note", noteId);
  if (jobs.length === 0) return [];
  const transaction = db.transaction("offlineAttachmentJobs", "readwrite");
  for (const job of jobs) await transaction.store.delete(job.id);
  await transaction.done;
  return jobs.map((job) => job.id);
}

export async function reconcileOfflineAttachmentJobs(
  noteId: string,
  keepIds: ReadonlySet<string>,
): Promise<string[]> {
  const connection = getDb();
  if (!connection) return [];
  const db = await connection;
  const jobs = await db.getAllFromIndex("offlineAttachmentJobs", "by-note", noteId);
  const removed = jobs.filter((job) => !keepIds.has(job.id));
  if (removed.length === 0) return [];
  const transaction = db.transaction("offlineAttachmentJobs", "readwrite");
  for (const job of removed) await transaction.store.delete(job.id);
  await transaction.done;
  return removed.map((job) => job.id);
}

export async function getOfflineAttachment(id: string): Promise<OfflineAttachmentRecord | undefined> {
  const connection = getDb();
  if (!connection) return undefined;
  return safe(async () => (await connection).get("offlineAttachments", id), undefined, "getOfflineAttachment");
}

export async function getOfflineAttachmentsByNote(noteId: string): Promise<OfflineAttachmentRecord[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(
    async () => (await connection).getAllFromIndex("offlineAttachments", "by-note", noteId),
    [],
    "getOfflineAttachmentsByNote",
  );
}

export async function markOfflineAttachmentsAccessed(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("offlineAttachments", "readwrite");
    const now = Date.now();
    for (const id of ids) {
      const row = await transaction.store.get(id);
      if (row) await transaction.store.put({ ...row, cachedAt: now });
    }
    await transaction.done;
  }, undefined, "markOfflineAttachmentsAccessed");
}

export async function deleteOfflineAttachment(id: string): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    await (await connection).delete("offlineAttachments", id);
    dispatchOfflineAttachmentRemoval([id]);
  }, undefined, "deleteOfflineAttachment");
}

export async function deleteOfflineAttachmentsByNote(noteId: string): Promise<string[]> {
  const records = await getOfflineAttachmentsByNote(noteId);
  if (records.length === 0) return [];
  const connection = getDb();
  if (!connection) return [];
  const ids = records.map((record) => record.id);
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("offlineAttachments", "readwrite");
    await Promise.all(ids.map((id) => transaction.store.delete(id)));
    await transaction.done;
  }, undefined, "deleteOfflineAttachmentsByNote");
  dispatchOfflineAttachmentRemoval(ids);
  return ids;
}

export async function reconcileOfflineAttachments(
  noteId: string,
  keepIds: ReadonlySet<string>,
): Promise<string[]> {
  const current = await getOfflineAttachmentsByNote(noteId);
  const removed = current.filter((record) => !keepIds.has(record.id)).map((record) => record.id);
  if (removed.length === 0) return [];
  const connection = getDb();
  if (!connection) return [];
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("offlineAttachments", "readwrite");
    await Promise.all(removed.map((id) => transaction.store.delete(id)));
    await transaction.done;
  }, undefined, "reconcileOfflineAttachments");
  dispatchOfflineAttachmentRemoval(removed);
  return removed;
}

export async function evictOfflineAttachmentsToFit(
  bytesToFree: number,
  preserveIds: ReadonlySet<string> = new Set(),
): Promise<{ freedBytes: number; evictedIds: string[] }> {
  if (bytesToFree <= 0) return { freedBytes: 0, evictedIds: [] };
  const connection = getDb();
  if (!connection) return { freedBytes: 0, evictedIds: [] };
  return safe(async () => {
    const db = await connection;
    const rows = await db.getAllFromIndex("offlineAttachments", "by-cached");
    let freedBytes = 0;
    const evictedIds: string[] = [];
    const transaction = db.transaction("offlineAttachments", "readwrite");
    for (const row of rows) {
      if (freedBytes >= bytesToFree) break;
      if (preserveIds.has(row.id)) continue;
      await transaction.store.delete(row.id);
      freedBytes += Number(row.size || row.blob?.size || 0);
      evictedIds.push(row.id);
    }
    await transaction.done;
    dispatchOfflineAttachmentRemoval(evictedIds);
    return { freedBytes, evictedIds };
  }, { freedBytes: 0, evictedIds: [] }, "evictOfflineAttachmentsToFit");
}

function recordMatchesWorkspace(value: { workspaceId?: string | null }, workspaceId: string | null): boolean {
  return (value.workspaceId ?? null) === workspaceId;
}

export async function reconcileOfflineScope(
  workspaceId: string | null,
  options: OfflineScopeReconcileOptions,
): Promise<string[]> {
  const preserve = options.preserveNoteIds || new Set<string>();
  const localNotes = await getAllNotes();
  const localNotebooks = await getAllNotebooks();
  const localTags = await getAllTags();
  const deleteNoteIds = new Set<string>();

  if (options.deleteNoteIds) {
    for (const id of options.deleteNoteIds) {
      if (!preserve.has(id)) deleteNoteIds.add(id);
    }
  }
  if (options.noteIds) {
    for (const note of localNotes) {
      if (
        recordMatchesWorkspace(note, workspaceId)
        && !options.noteIds.has(note.id)
        && !preserve.has(note.id)
      ) deleteNoteIds.add(note.id);
    }
  }

  const removedAttachmentIds: string[] = [];
  for (const noteId of deleteNoteIds) {
    removedAttachmentIds.push(...await deleteOfflineAttachmentsByNote(noteId));
    await deleteOfflineAttachmentJobsByNote(noteId);
    await deleteNote(noteId);
  }

  const connection = getDb();
  if (!connection) return removedAttachmentIds;
  await safe(async () => {
    const db = await connection;
    if (options.notebookIds) {
      const transaction = db.transaction("notebooks", "readwrite");
      for (const notebook of localNotebooks) {
        if (recordMatchesWorkspace(notebook, workspaceId) && !options.notebookIds.has(notebook.id)) {
          await transaction.store.delete(notebook.id);
        }
      }
      await transaction.done;
    }
    if (options.tagIds) {
      const transaction = db.transaction("tags", "readwrite");
      for (const tag of localTags) {
        if (recordMatchesWorkspace(tag, workspaceId) && !options.tagIds.has(tag.id)) {
          await transaction.store.delete(tag.id);
        }
      }
      await transaction.done;
    }
  }, undefined, "reconcileOfflineScope");
  return removedAttachmentIds;
}

export async function clearOfflineScope(
  workspaceId: string | null,
  preserveNoteIds: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  return reconcileOfflineScope(workspaceId, {
    noteIds: new Set(),
    notebookIds: new Set(),
    tagIds: new Set(),
    preserveNoteIds,
  });
}

export async function getOfflineStorageStats(): Promise<OfflineStorageStats> {
  const connection = getDb();
  if (!connection) {
    return {
      cachedNotes: 0,
      placeholderNotes: 0,
      noteBytes: 0,
      attachmentCount: 0,
      attachmentBytes: 0,
      totalBytes: 0,
    };
  }
  return safe(async () => {
    const db = await connection;
    const [notes, attachments] = await Promise.all([
      db.getAll("notes"),
      db.getAll("offlineAttachments"),
    ]);
    let cachedNotes = 0;
    let placeholderNotes = 0;
    let noteBytes = 0;
    for (const note of notes) {
      if (isNoteDetailCached(note)) cachedNotes += 1;
      else placeholderNotes += 1;
      noteBytes += (note.content?.length || 0) * 2;
      noteBytes += (note.contentText?.length || 0) * 2;
      noteBytes += (note.title?.length || 0) * 2;
    }
    const attachmentBytes = attachments.reduce(
      (sum, attachment) => sum + Number(attachment.size || attachment.blob?.size || 0),
      0,
    );
    return {
      cachedNotes,
      placeholderNotes,
      noteBytes,
      attachmentCount: attachments.length,
      attachmentBytes,
      totalBytes: noteBytes + attachmentBytes,
    };
  }, {
    cachedNotes: 0,
    placeholderNotes: 0,
    noteBytes: 0,
    attachmentCount: 0,
    attachmentBytes: 0,
    totalBytes: 0,
  }, "getOfflineStorageStats");
}

export function isReady(): boolean {
  return !!currentCacheIdentity;
}

export function getCurrentUserId(): string | null {
  return currentUserId;
}
