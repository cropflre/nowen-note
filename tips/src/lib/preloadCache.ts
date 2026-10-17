/**
 * 本地缓存预加载。
 *
 * 目的：让「打开 App」和「点开一篇笔记」不再等网络。
 *   · 笔记列表 → localStorage（只是元数据，很小）
 *   · 笔记正文 → IndexedDB（正文可能几十上百 KB，localStorage 只有 ~5MB 且同步阻塞）
 *
 * 策略是 **stale-while-revalidate**：先用缓存立刻渲染，再用网络结果覆盖。
 * 用户看到的永远是「立刻有内容」，而不是白屏转圈。
 *
 * ⚠️ 三条边界：
 *   1. **缓存只是副本**，任何清缓存动作都不碰服务器数据。
 *   2. **配额满了要能活下来**：IndexedDB 写入可能因 QuotaExceededError 失败，
 *      失败时静默降级（不缓存），绝不让它把正常流程带崩。
 *   3. **按条数做 LRU**，不是无上限堆积 —— 默认 20 篇，用户可调。
 */
import type { NoteSummary } from "../../sdk/types";

const ENABLED_KEY = "nowen-lite.preload-enabled";
const COUNT_KEY = "nowen-lite.preload-count";
const LIST_KEY = "nowen-lite.cache.note-list";
const LIST_AT_KEY = "nowen-lite.cache.note-list-at";

const DB_NAME = "nowen-lite-cache";
const DB_VERSION = 1;
const STORE = "notes";

/** 可选的预加载条数（0 = 只缓存列表，不缓存正文） */
export const PRELOAD_COUNTS = [0, 10, 20, 50, 100] as const;
export const DEFAULT_PRELOAD_COUNT = 20;

// ---------------------------------------------------------------- 偏好

export function isPreloadEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setPreloadEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {
    /* 隐私模式 */
  }
}

export function getPreloadCount(): number {
  try {
    const raw = localStorage.getItem(COUNT_KEY);
    // ⚠️ 必须先判 null 再 Number()：`Number(null)` 是 0，而 0 在 PRELOAD_COUNTS 里
    //    是合法的「关闭」值 → 没存过偏好时会被误读成「用户选了关闭」，
    //    表现是「预加载开关是开的，但缓存永远是空的」。
    if (raw === null) return DEFAULT_PRELOAD_COUNT;
    const n = Number(raw);
    return PRELOAD_COUNTS.includes(n as (typeof PRELOAD_COUNTS)[number])
      ? n
      : DEFAULT_PRELOAD_COUNT;
  } catch {
    return DEFAULT_PRELOAD_COUNT;
  }
}

export function setPreloadCount(n: number): void {
  try {
    localStorage.setItem(COUNT_KEY, String(n));
  } catch {
    /* 隐私模式 */
  }
}

// ---------------------------------------------------------------- IndexedDB

interface CachedNote {
  id: string;
  /** 服务端返回的完整笔记对象 */
  note: unknown;
  /** 最后访问时间，用来做 LRU */
  at: number;
  /** 粗略体积（JSON 字符串长度），只用来给用户看占用 */
  bytes: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("at", "at");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      // 有些环境（隐私模式）打开会卡住，给个超时兜底
      setTimeout(() => resolve(null), 3000);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const t = db.transaction(STORE, mode);
          const req = run(t.objectStore(STORE));
          req.onsuccess = () => resolve(req.result as T);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

// ---------------------------------------------------------------- 笔记列表

/** 列表缓存：只存元数据，很小，放 localStorage 够用且读取是同步的（能赶上首帧） */
export function cacheNoteList(notes: NoteSummary[]): void {
  if (!isPreloadEnabled()) return;
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(notes));
    localStorage.setItem(LIST_AT_KEY, String(Date.now()));
  } catch {
    /* 超配额就算了，列表下次还能从网络拿 */
  }
}

export function getCachedNoteList(): NoteSummary[] | null {
  if (!isPreloadEnabled()) return null;
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NoteSummary[]) : null;
  } catch {
    return null;
  }
}

export function getCachedNoteListAt(): number | null {
  try {
    const raw = Number(localStorage.getItem(LIST_AT_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 笔记正文

export async function cacheNote(note: { id: string } & Record<string, unknown>): Promise<void> {
  if (!isPreloadEnabled() || getPreloadCount() === 0) return;
  const payload = JSON.stringify(note);
  const item: CachedNote = { id: note.id, note, at: Date.now(), bytes: payload.length };
  await tx("readwrite", (store) => store.put(item));
  void evictOld();
}

export async function getCachedNote<T = unknown>(id: string): Promise<T | null> {
  if (!isPreloadEnabled() || getPreloadCount() === 0) return null;
  const hit = await tx<CachedNote>("readonly", (store) => store.get(id));
  if (!hit) return null;
  // 命中即刷新访问时间，LRU 才有意义
  void tx("readwrite", (store) => store.put({ ...hit, at: Date.now() }));
  return hit.note as T;
}

/** 超出「预加载条数」就把最久没访问的删掉 */
async function evictOld(): Promise<void> {
  const limit = getPreloadCount();
  if (limit <= 0) return clearNotes();
  const all = await tx<CachedNote[]>("readonly", (store) => store.getAll());
  if (!all || all.length <= limit) return;
  const sorted = [...all].sort((a, b) => a.at - b.at); // 最旧的在前
  for (const item of sorted.slice(0, all.length - limit)) {
    await tx("readwrite", (store) => store.delete(item.id));
  }
}

// ---------------------------------------------------------------- 统计与清理

export interface CacheStats {
  /** 缓存了多少篇正文 */
  noteCount: number;
  /** 正文的粗略字节数 */
  bytes: number;
  /** 是否缓存了列表 */
  hasList: boolean;
  /** 列表缓存时间 */
  listAt: number | null;
}

export async function getCacheStats(): Promise<CacheStats> {
  const all = (await tx<CachedNote[]>("readonly", (store) => store.getAll())) ?? [];
  return {
    noteCount: all.length,
    bytes: all.reduce((sum, x) => sum + (x.bytes || 0), 0),
    hasList: getCachedNoteList() !== null,
    listAt: getCachedNoteListAt(),
  };
}

/** 只清正文缓存 */
async function clearNotes(): Promise<void> {
  await tx("readwrite", (store) => store.clear());
}

/** 清空所有缓存（列表 + 正文）。**不会碰服务器上的任何数据。** */
export async function clearCache(): Promise<void> {
  try {
    localStorage.removeItem(LIST_KEY);
    localStorage.removeItem(LIST_AT_KEY);
  } catch {
    /* ignore */
  }
  await clearNotes();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
