/**
 * Offline mutation queue for note writes.
 *
 * Queue entries are scoped by server + user, persisted in localStorage, and
 * replayed serially. Failed entries are never silently discarded: retryable
 * failures remain available for retry and permanent failures keep their local
 * payload for diagnostics/export.
 */

export type OfflineMutationType = "createNote" | "updateNote" | "deleteNote";

export interface OfflineQueueItem {
  id: string;
  type: OfflineMutationType;
  noteId: string;
  url: string;
  method: "POST" | "PUT" | "DELETE";
  body: Record<string, unknown> | null;
  enqueuedAt: number;
  retryCount: number;
  conflict?: boolean;
  blocked?: boolean;
  retryable?: boolean;
  errorCode?: "VERSION_CONFLICT" | string;
  serverVersion?: number;
  localPayload?: Record<string, unknown> | null;
  failedAt?: number;
  lastAttemptAt?: number;
  lastHttpStatus?: number;
  message?: string;
}

export interface OfflineQueueFetchContext {
  idempotencyKey: string;
  item: OfflineQueueItem;
}

export type OfflineQueueFetch = (
  url: string,
  method: string,
  body: Record<string, unknown> | null,
  context?: OfflineQueueFetchContext,
) => Promise<{ ok: boolean; status: number; data?: any }>;

export type FlushResult = {
  success: number;
  failed: number;
  remaining: number;
};

const LEGACY_STORAGE_KEY = "nowen-offline-queue";
const STORAGE_KEY_PREFIX = "nowen-offline-queue:v2";
const LEGACY_LOCAL_ID_MAP_KEY = "nowen-offline-id-map";
const LOCAL_ID_MAP_KEY_PREFIX = "nowen-offline-id-map:v2";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETRY = 10;

function generateId(): string {
  return `oq_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeScopePart(value: string): string {
  return encodeURIComponent((value || "unknown").replace(/\/+$/, "").toLowerCase());
}

function decodeUserIdFromToken(token: string | null): string {
  if (!token) return "anonymous";
  try {
    const payload = token.split(".")[1];
    if (!payload) return "anonymous";
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")))
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join(""),
    );
    const data = JSON.parse(json) as { userId?: string; sub?: string };
    return data.userId || data.sub || "anonymous";
  } catch {
    return "anonymous";
  }
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

export function getOfflineQueueStorageKey(): string {
  let token: string | null = null;
  try { token = localStorage.getItem("nowen-token"); } catch { /* ignore */ }
  return `${STORAGE_KEY_PREFIX}:${normalizeScopePart(getServerScope())}:${normalizeScopePart(decodeUserIdFromToken(token))}`;
}

function getLocalIdMapStorageKey(): string {
  const queueScope = getOfflineQueueStorageKey().slice(STORAGE_KEY_PREFIX.length + 1);
  return `${LOCAL_ID_MAP_KEY_PREFIX}:${queueScope}`;
}

function readQueueFromKey(key: string): OfflineQueueItem[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function uuidV4Fallback(): string {
  const bytes = new Uint8Array(16);
  const cryptoApi = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Offline-created notes use a UUID accepted by the backend. Replaying the same
 * create operation therefore becomes idempotent instead of producing a second
 * note with a new server-side id.
 */
export function generateLocalNoteId(): string {
  const randomUUID = typeof globalThis !== "undefined" ? globalThis.crypto?.randomUUID : undefined;
  return typeof randomUUID === "function" ? randomUUID.call(globalThis.crypto) : uuidV4Fallback();
}

function persistQueue(items: OfflineQueueItem[]): void {
  try {
    const key = getOfflineQueueStorageKey();
    if (items.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(items));
  } catch (error) {
    console.warn("[offlineQueue] persistQueue failed:", error);
  }
}

export function getQueue(): OfflineQueueItem[] {
  try {
    const key = getOfflineQueueStorageKey();
    let items = readQueueFromKey(key);
    if (items.length === 0) {
      const legacy = readQueueFromKey(LEGACY_STORAGE_KEY);
      if (legacy.length > 0) {
        items = legacy;
        localStorage.setItem(key, JSON.stringify(items));
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
    return items;
  } catch {
    return [];
  }
}

function clearFailureState(item: OfflineQueueItem): OfflineQueueItem {
  const next = { ...item };
  delete next.conflict;
  delete next.blocked;
  delete next.retryable;
  delete next.errorCode;
  delete next.serverVersion;
  delete next.localPayload;
  delete next.failedAt;
  delete next.lastAttemptAt;
  delete next.lastHttpStatus;
  delete next.message;
  return next;
}

export function enqueue(item: Omit<OfflineQueueItem, "id" | "enqueuedAt" | "retryCount">): void {
  const queue = getQueue();
  const newItem: OfflineQueueItem = {
    ...item,
    id: generateId(),
    enqueuedAt: Date.now(),
    retryCount: 0,
  };

  // 用户明确移入回收站时，删除意图优先于此前尚未处理的内容更新或版本冲突。
  // 这里只替换同一笔记的 update，保留新的回收站操作等待服务器确认。
  if (newItem.type === "updateNote" && newItem.body?.isTrashed === 1) {
    const next = queue.filter(
      (queued) => queued.noteId !== newItem.noteId || queued.type !== "updateNote",
    );
    next.push(newItem);
    persistQueue(next);
    notifyListeners();
    return;
  }

  if (newItem.type === "updateNote") {
    const createIndex = queue.findIndex(
      (queued) => queued.type === "createNote" && queued.noteId === newItem.noteId && !queued.conflict,
    );
    if (createIndex !== -1) {
      const existing = clearFailureState(queue[createIndex]);
      queue[createIndex] = {
        ...existing,
        body: { ...(existing.body || {}), ...(newItem.body || {}) },
        retryCount: 0,
      };
      persistQueue(queue);
      notifyListeners();
      return;
    }

    const updateIndex = queue.findIndex(
      (queued) => queued.type === "updateNote" && queued.noteId === newItem.noteId && !queued.conflict,
    );
    if (updateIndex !== -1) {
      const existing = clearFailureState(queue[updateIndex]);
      queue[updateIndex] = {
        ...existing,
        url: newItem.url,
        method: newItem.method,
        body: newItem.body,
        retryCount: 0,
      };
      persistQueue(queue);
      notifyListeners();
      return;
    }
  }

  if (newItem.type === "deleteNote") {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const queued = queue[index];
      if (queued.noteId === newItem.noteId && queued.type === "updateNote") {
        queue.splice(index, 1);
      }
    }
  }

  queue.push(newItem);
  persistQueue(queue);
  notifyListeners();
}

export function dequeue(itemId: string): void {
  const queue = getQueue();
  persistQueue(queue.filter((item) => item.id !== itemId));
  notifyListeners();
}

/** 服务器确认笔记已删除后，按 noteId 精准移除对应的全部队列记录。 */
export function discardNoteQueueItems(noteIds: readonly string[]): number {
  if (noteIds.length === 0) return 0;
  const ids = new Set(noteIds);
  const queue = getQueue();
  const next = queue.filter((item) => !ids.has(item.noteId));
  const removed = queue.length - next.length;
  if (removed > 0) {
    persistQueue(next);
    notifyListeners();
  }
  return removed;
}

export function updateItem(itemId: string, patch: Partial<OfflineQueueItem>): void {
  const queue = getQueue();
  const index = queue.findIndex((item) => item.id === itemId);
  if (index === -1) return;
  queue[index] = { ...queue[index], ...patch };
  persistQueue(queue);
  notifyListeners();
}

/** 用新身份替换队列项，使在途处理能够识别期间发生的本地内容更新。 */
export function replaceItem(
  itemId: string,
  patch: Partial<OfflineQueueItem>,
): OfflineQueueItem | null {
  const queue = getQueue();
  const index = queue.findIndex((item) => item.id === itemId);
  if (index === -1) return null;
  const replacement: OfflineQueueItem = {
    ...queue[index],
    ...patch,
    id: generateId(),
    enqueuedAt: Date.now(),
    retryCount: 0,
  };
  queue[index] = replacement;
  persistQueue(queue);
  notifyListeners();
  return replacement;
}

function queuePayloadFingerprint(item: OfflineQueueItem): string {
  return JSON.stringify(item.localPayload ?? item.body ?? null);
}

/**
 * 仅当待处理项的身份和 payload 都未变化时，清理它及同一笔记更早的队列项。
 * 若处理期间出现新编辑，保留新队列项和所有恢复数据。
 */
export function discardResolvedQueueItems(expected: OfflineQueueItem): {
  discarded: boolean;
  remainingForNote: boolean;
} {
  const queue = getQueue();
  const resolvedIndex = queue.findIndex((item) => item.id === expected.id);
  if (resolvedIndex === -1 || queuePayloadFingerprint(queue[resolvedIndex]) !== queuePayloadFingerprint(expected)) {
    return {
      discarded: false,
      remainingForNote: queue.some((item) => item.noteId === expected.noteId),
    };
  }

  const next = queue.filter((item, index) => item.noteId !== expected.noteId || index > resolvedIndex);
  persistQueue(next);
  notifyListeners();
  return {
    discarded: true,
    remainingForNote: next.some((item) => item.noteId === expected.noteId),
  };
}

function markVersionConflict(item: OfflineQueueItem, currentVersion?: number): void {
  const localPayload = item.body ? { ...item.body } : null;
  const message = "版本冲突：已停止自动覆盖，并保留本地内容等待处理。";
  updateItem(item.id, {
    conflict: true,
    blocked: true,
    retryable: false,
    errorCode: "VERSION_CONFLICT",
    serverVersion: currentVersion,
    localPayload,
    failedAt: Date.now(),
    lastAttemptAt: Date.now(),
    lastHttpStatus: 409,
    message,
  });
  console.warn("[offlineQueue] VERSION_CONFLICT stopped auto overwrite:", {
    noteId: item.noteId,
    localVersion: item.body?.version,
    serverVersion: currentVersion,
  });
}

function messageFromResponse(status: number, data: any): string {
  const detail = data?.error || data?.message || data?.code;
  return detail ? `HTTP ${status}: ${String(detail)}` : `HTTP ${status}`;
}

function markBlockedFailure(
  item: OfflineQueueItem,
  errorCode: string,
  message: string,
  options: { retryable: boolean; status?: number; retryCount?: number },
): void {
  updateItem(item.id, {
    blocked: true,
    retryable: options.retryable,
    errorCode,
    message,
    failedAt: Date.now(),
    lastAttemptAt: Date.now(),
    lastHttpStatus: options.status,
    retryCount: options.retryCount ?? item.retryCount,
    localPayload: item.body ? { ...item.body } : null,
  });
}

export function getQueueLength(): number {
  return getQueue().length;
}

export function getFailedQueueItems(): OfflineQueueItem[] {
  return getQueue().filter(
    (item) => item.conflict || item.blocked || !!item.errorCode || item.retryCount > 0,
  );
}

export function retryQueueItem(itemId: string): boolean {
  const queue = getQueue();
  const index = queue.findIndex((item) => item.id === itemId);
  if (index === -1 || queue[index].conflict || queue[index].errorCode === "VERSION_CONFLICT") return false;
  const reset = clearFailureState(queue[index]);
  queue[index] = { ...reset, retryCount: 0, enqueuedAt: Date.now() };
  persistQueue(queue);
  notifyListeners();
  return true;
}

export function retryFailedQueueItems(): number {
  const queue = getQueue();
  let changed = 0;
  const next = queue.map((item) => {
    const failed = item.blocked || !!item.errorCode || item.retryCount > 0;
    if (!failed || item.conflict || item.errorCode === "VERSION_CONFLICT") return item;
    changed += 1;
    return { ...clearFailureState(item), retryCount: 0, enqueuedAt: Date.now() };
  });
  if (changed > 0) {
    persistQueue(next);
    notifyListeners();
  }
  return changed;
}

export function exportQueueDiagnostics(): string {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    storageKey: getOfflineQueueStorageKey(),
    pending: getQueueLength(),
    items: getQueue(),
  }, null, 2);
}

export function clearQueue(): void {
  persistQueue([]);
  notifyListeners();
}

export function getLocalIdMap(): Record<string, string> {
  try {
    const key = getLocalIdMapStorageKey();
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
    const legacy = localStorage.getItem(LEGACY_LOCAL_ID_MAP_KEY);
    if (legacy) {
      localStorage.setItem(key, legacy);
      localStorage.removeItem(LEGACY_LOCAL_ID_MAP_KEY);
      return JSON.parse(legacy);
    }
    return {};
  } catch {
    return {};
  }
}

export function setLocalIdMapping(localId: string, realId: string): void {
  const map = getLocalIdMap();
  map[localId] = realId;
  try { localStorage.setItem(getLocalIdMapStorageKey(), JSON.stringify(map)); } catch { /* ignore */ }

  const queue = getQueue();
  let changed = false;
  for (const item of queue) {
    if (item.noteId === localId) {
      item.noteId = realId;
      item.url = item.url.replace(localId, realId);
      changed = true;
    }
  }
  if (changed) {
    persistQueue(queue);
    notifyListeners();
  }
}

export function clearLocalIdMap(): void {
  try { localStorage.removeItem(getLocalIdMapStorageKey()); } catch { /* ignore */ }
}

let flushPromise: Promise<FlushResult> | null = null;

async function flushQueueInternal(fetchFn: OfflineQueueFetch): Promise<FlushResult> {
  const result: FlushResult = { success: 0, failed: 0, remaining: 0 };
  try {
    const queue = getQueue();
    for (const item of queue) {
      if (item.conflict || item.blocked || item.errorCode === "VERSION_CONFLICT") continue;

      if (Date.now() - item.enqueuedAt >= MAX_AGE_MS) {
        markBlockedFailure(item, "QUEUE_ITEM_EXPIRED", "该操作已等待超过 7 天，已保留本地副本，请手动重试或导出诊断。", {
          retryable: true,
        });
        result.failed += 1;
        continue;
      }

      if (item.retryCount >= MAX_RETRY) {
        markBlockedFailure(item, "MAX_RETRY_REACHED", `已重试 ${item.retryCount} 次，已暂停自动重试并保留本地副本。`, {
          retryable: true,
        });
        result.failed += 1;
        continue;
      }

      try {
        const replayBody = item.type === "createNote" && item.body && !item.body.id && !item.noteId.startsWith("local-")
          ? { ...item.body, id: item.noteId }
          : item.body;
        const response = await fetchFn(item.url, item.method, replayBody, {
          idempotencyKey: item.id,
          item,
        });

        if (response.ok) {
          if (item.type === "createNote" && item.noteId.startsWith("local-") && response.data?.id) {
            setLocalIdMapping(item.noteId, response.data.id);
          }
          dequeue(item.id);
          result.success += 1;
          continue;
        }

        if (item.type === "createNote" && response.status === 409 && response.data?.code === "NOTE_ID_CONFLICT") {
          dequeue(item.id);
          result.success += 1;
          continue;
        }

        if (response.status === 409 || response.data?.code === "VERSION_CONFLICT") {
          const currentVersion = typeof response.data?.currentVersion === "number"
            ? response.data.currentVersion
            : undefined;
          markVersionConflict(item, currentVersion);
          result.failed += 1;
          continue;
        }

        if (response.status === 404 && item.type === "deleteNote") {
          dequeue(item.id);
          result.success += 1;
          continue;
        }

        if (response.status === 404 && item.type === "updateNote") {
          markBlockedFailure(item, "NOTE_NOT_FOUND", "服务端已不存在该笔记，更新未丢弃；可导出本地内容后处理。", {
            retryable: false,
            status: response.status,
          });
          result.failed += 1;
          continue;
        }

        if (response.status >= 400 && response.status < 500) {
          const code = String(response.data?.code || `HTTP_${response.status}`);
          markBlockedFailure(item, code, messageFromResponse(response.status, response.data), {
            retryable: false,
            status: response.status,
          });
          result.failed += 1;
          continue;
        }

        const retryCount = item.retryCount + 1;
        updateItem(item.id, {
          retryCount,
          blocked: retryCount >= MAX_RETRY,
          retryable: true,
          errorCode: retryCount >= MAX_RETRY ? "MAX_RETRY_REACHED" : `HTTP_${response.status || 500}`,
          message: messageFromResponse(response.status || 500, response.data),
          failedAt: Date.now(),
          lastAttemptAt: Date.now(),
          lastHttpStatus: response.status,
          localPayload: item.body ? { ...item.body } : null,
        });
        result.failed += 1;
        break;
      } catch (error) {
        const retryCount = item.retryCount + 1;
        const message = error instanceof Error ? error.message : String(error || "Network error");
        updateItem(item.id, {
          retryCount,
          blocked: retryCount >= MAX_RETRY,
          retryable: true,
          errorCode: retryCount >= MAX_RETRY ? "MAX_RETRY_REACHED" : "NETWORK_ERROR",
          message,
          failedAt: Date.now(),
          lastAttemptAt: Date.now(),
          localPayload: item.body ? { ...item.body } : null,
        });
        result.failed += 1;
        break;
      }
    }
  } finally {
    result.remaining = getQueueLength();
    notifyListeners();
  }
  return result;
}

export function flushQueue(fetchFn: OfflineQueueFetch): Promise<FlushResult> {
  if (flushPromise) return flushPromise;
  flushPromise = flushQueueInternal(fetchFn).finally(() => {
    flushPromise = null;
  });
  return flushPromise;
}

type Listener = (count: number) => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyListeners(): void {
  const count = getQueueLength();
  listeners.forEach((listener) => {
    try { listener(count); } catch { /* listener isolation */ }
  });
}

export function shouldEnqueue(url: string, method: string, error: any): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod !== "POST" && normalizedMethod !== "PUT" && normalizedMethod !== "DELETE") return false;
  if (!isNotesMutationUrl(url)) return false;
  if (isNetworkError(error)) return true;
  return error?.status >= 500;
}

function isNotesMutationUrl(url: string): boolean {
  return /^\/notes(\/[^/]+)?$/.test(url);
}

export function isNetworkError(error: any): boolean {
  if (!error) return false;
  if (error instanceof TypeError || error.name === "TypeError") return true;
  if (error.name === "AbortError") return false;
  return !error.status && !!error.message && /fetch|network|ERR_/i.test(error.message);
}

export function inferMutationType(url: string, method: string): OfflineMutationType | null {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "POST" && url === "/notes") return "createNote";
  if (normalizedMethod === "PUT" && /^\/notes\/[^/]+$/.test(url)) return "updateNote";
  if (normalizedMethod === "DELETE" && /^\/notes\/[^/]+$/.test(url)) return "deleteNote";
  return null;
}

export function extractNoteId(url: string): string {
  const match = url.match(/^\/notes\/([^/?]+)/);
  return match ? match[1] : "";
}
