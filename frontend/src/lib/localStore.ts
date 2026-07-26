import { openDB, type IDBPDatabase, type DBSchema } from "idb";
import type { Note, NoteListItem, Notebook, Tag } from "@/types";

/** Extra IndexedDB-only metadata. It is never sent to the server. */
export type CachedNote = Note & {
  __detailCached?: boolean;
};

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
const DB_VERSION = 1;

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
    const transaction = db.transaction(["notebooks", "notes", "tags", "meta"], "readwrite");
    await Promise.all([
      transaction.objectStore("notebooks").clear(),
      transaction.objectStore("notes").clear(),
      transaction.objectStore("tags").clear(),
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
