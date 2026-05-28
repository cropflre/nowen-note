/**
 * 离线写入队列（Offline Mutation Queue）
 * =========================================================================
 *
 * 当网络不可用或请求失败（网络错误 / 5xx）时，把写入类 API 调用暂存到
 * localStorage，等恢复网络后自动按 FIFO 串行 flush 到服务器。
 *
 * 设计约束：
 *   - 仅拦截笔记相关的写入操作（PUT /notes/:id、POST /notes、DELETE /notes/:id）；
 *   - GET 请求不拦截——离线时读取依赖 store 缓存；
 *   - 同一笔记的多次 updateNote 会合并（保留最后一次 payload）；
 *   - 单条超过 7 天自动过期丢弃；
 *   - flush 时遇 409 自动用 currentVersion 重试一次（复用 putWithReconcile 语义）；
 *   - 非 409 失败保留在队列里，下次再试。
 *
 * 存储 key: "nowen-offline-queue:v2:<server-scope>:<userId>"
 * 格式: JSON 数组 OfflineQueueItem[]
 *
 * 关键：队列必须按「服务器/本地实例 + 用户」隔离。
 * 否则云端 A 离线写入、切到本地/云端 B 后，可能被 flush 到错误后端。
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type OfflineMutationType = "createNote" | "updateNote" | "deleteNote";

export interface OfflineQueueItem {
  /** 唯一标识，用于去重/合并 */
  id: string;
  /** 操作类型 */
  type: OfflineMutationType;
  /** 笔记 ID（createNote 时为本地临时 ID "local-xxx"） */
  noteId: string;
  /** 请求 URL（相对路径，如 /notes/xxx） */
  url: string;
  /** HTTP method */
  method: "POST" | "PUT" | "DELETE";
  /** 请求体（DELETE 时为 null） */
  body: Record<string, unknown> | null;
  /** 入队时间戳（ms） */
  enqueuedAt: number;
  /** 重试次数 */
  retryCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LEGACY_STORAGE_KEY = "nowen-offline-queue";
const STORAGE_KEY_PREFIX = "nowen-offline-queue:v2";
const LEGACY_LOCAL_ID_MAP_KEY = "nowen-offline-id-map";
const LOCAL_ID_MAP_KEY_PREFIX = "nowen-offline-id-map:v2";
/** 单条最大存活时间：7 天 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** flush 间单条最大重试次数（超出后丢弃） */
const MAX_RETRY = 10;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return `oq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
        .join("")
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
    const u = new URL(url);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
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

  // 桌面 full 本地后端是 loopback + 动态端口，队列 key 必须稳定；远端/lite
  // 通常不是 loopback，仍按 URL 隔离，避免服务器之间串队列。
  if (isDesktop && ((server && isLoopbackUrl(server)) || (!server && origin && isLoopbackUrl(origin)))) {
    return "local-desktop";
  }
  if (server) return normalizeUrl(server);
  if (origin) return normalizeUrl(origin);
  return "same-origin";
}

/** 当前登录上下文对应的队列 key：服务器/本地实例 + 用户 双维度隔离。 */
export function getOfflineQueueStorageKey(): string {
  let token: string | null = null;
  try { token = localStorage.getItem("nowen-token"); } catch { /* ignore */ }
  return `${STORAGE_KEY_PREFIX}:${normalizeScopePart(getServerScope())}:${normalizeScopePart(decodeUserIdFromToken(token))}`;
}

function getLocalIdMapStorageKey(): string {
  const queueKey = getOfflineQueueStorageKey().slice(STORAGE_KEY_PREFIX.length + 1);
  return `${LOCAL_ID_MAP_KEY_PREFIX}:${queueKey}`;
}

function readQueueFromKey(key: string): OfflineQueueItem[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

export function generateLocalNoteId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Queue CRUD ───────────────────────────────────────────────────────────────

/** 从 localStorage 读取队列（带过期清理） */
export function getQueue(): OfflineQueueItem[] {
  try {
    const key = getOfflineQueueStorageKey();
    let items = readQueueFromKey(key);

    // 兼容升级：旧版只有一个全局 key。若当前 scoped key 为空，则把旧队列
    // 迁移到当前登录上下文，然后删除旧 key，避免之后切账号/切服务器误 flush。
    if (items.length === 0) {
      const legacy = readQueueFromKey(LEGACY_STORAGE_KEY);
      if (legacy.length > 0) {
        items = legacy;
        localStorage.setItem(key, JSON.stringify(items));
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }

    const now = Date.now();
    // 过滤过期项
    const valid = items.filter((item) => now - item.enqueuedAt < MAX_AGE_MS);
    if (valid.length !== items.length) {
      // 有过期项被清理，持久化
      persistQueue(valid);
    }
    return valid;
  } catch {
    return [];
  }
}

/** 持久化队列到 localStorage */
function persistQueue(items: OfflineQueueItem[]): void {
  try {
    const key = getOfflineQueueStorageKey();
    if (items.length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(items));
    }
  } catch (e) {
    console.warn("[offlineQueue] persistQueue failed:", e);
  }
}

/** 入队一条操作 */
export function enqueue(item: Omit<OfflineQueueItem, "id" | "enqueuedAt" | "retryCount">): void {
  const queue = getQueue();
  const newItem: OfflineQueueItem = {
    ...item,
    id: generateId(),
    enqueuedAt: Date.now(),
    retryCount: 0,
  };

  // 合并策略：同一 noteId 的 updateNote 只保留最后一次
  if (newItem.type === "updateNote") {
    const existIdx = queue.findIndex(
      (q) => q.type === "updateNote" && q.noteId === newItem.noteId,
    );
    if (existIdx !== -1) {
      // 保留最早的入队时间（用于过期判定），但用最新的 body
      newItem.enqueuedAt = queue[existIdx].enqueuedAt;
      newItem.retryCount = queue[existIdx].retryCount;
      queue[existIdx] = newItem;
      persistQueue(queue);
      notifyListeners();
      return;
    }
  }

  queue.push(newItem);
  persistQueue(queue);
  notifyListeners();
}

/** 移除指定项 */
export function dequeue(itemId: string): void {
  const queue = getQueue();
  const filtered = queue.filter((q) => q.id !== itemId);
  persistQueue(filtered);
  notifyListeners();
}

/** 更新指定项（用于增加 retryCount 等） */
export function updateItem(itemId: string, patch: Partial<OfflineQueueItem>): void {
  const queue = getQueue();
  const idx = queue.findIndex((q) => q.id === itemId);
  if (idx === -1) return;
  queue[idx] = { ...queue[idx], ...patch };
  persistQueue(queue);
}

/** 获取队列长度 */
export function getQueueLength(): number {
  return getQueue().length;
}

/** 清空队列 */
export function clearQueue(): void {
  persistQueue([]);
  notifyListeners();
}

// ─── 本地 ID → 真实 ID 映射 ────────────────────────────────────────────────────

export function getLocalIdMap(): Record<string, string> {
  try {
    const key = getLocalIdMapStorageKey();
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);

    // 兼容旧版全局 id map。只迁移一次到当前上下文，避免 local-* 映射跨服务器污染。
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
  try {
    localStorage.setItem(getLocalIdMapStorageKey(), JSON.stringify(map));
  } catch {}
  // 更新队列中引用该 localId 的后续操作
  const queue = getQueue();
  let changed = false;
  for (const item of queue) {
    if (item.noteId === localId) {
      item.noteId = realId;
      item.url = item.url.replace(localId, realId);
      changed = true;
    }
  }
  if (changed) persistQueue(queue);
}

export function clearLocalIdMap(): void {
  try {
    localStorage.removeItem(getLocalIdMapStorageKey());
  } catch {}
}

// ─── Flush（重试执行队列） ──────────────────────────────────────────────────────

let flushing = false;

export type FlushResult = {
  success: number;
  failed: number;
  remaining: number;
};

/**
 * 串行执行队列中的所有操作。
 * @param fetchFn  实际发送请求的函数（避免循环依赖，由调用方注入）
 * @returns 执行结果统计
 */
export async function flushQueue(
  fetchFn: (url: string, method: string, body: Record<string, unknown> | null) => Promise<{ ok: boolean; status: number; data?: any }>,
): Promise<FlushResult> {
  if (flushing) return { success: 0, failed: 0, remaining: getQueueLength() };
  flushing = true;

  const result: FlushResult = { success: 0, failed: 0, remaining: 0 };

  try {
    const queue = getQueue();
    if (queue.length === 0) {
      return result;
    }

    for (const item of queue) {
      // 检查是否过期
      if (Date.now() - item.enqueuedAt >= MAX_AGE_MS) {
        dequeue(item.id);
        result.failed++;
        continue;
      }

      // 检查重试次数
      if (item.retryCount >= MAX_RETRY) {
        dequeue(item.id);
        result.failed++;
        continue;
      }

      try {
        const res = await fetchFn(item.url, item.method, item.body);

        if (res.ok) {
          // 成功
          // 如果是 createNote 且 noteId 是本地 ID，记录映射
          if (item.type === "createNote" && item.noteId.startsWith("local-") && res.data?.id) {
            setLocalIdMapping(item.noteId, res.data.id);
          }
          dequeue(item.id);
          result.success++;
        } else if (res.status === 409) {
          // 版本冲突：尝试用服务端返回的 currentVersion 重发
          const currentVersion = res.data?.currentVersion;
          if (typeof currentVersion === "number" && item.body) {
            const retryBody = { ...item.body, version: currentVersion };
            const retryRes = await fetchFn(item.url, item.method, retryBody);
            if (retryRes.ok) {
              dequeue(item.id);
              result.success++;
            } else {
              // reconcile 也失败了——尝试 GET 最新版本号再来一次
              updateItem(item.id, { retryCount: item.retryCount + 1, body: retryBody });
              result.failed++;
              // 不 break：继续处理后续（可能是不同笔记）
            }
          } else {
            // 没有 currentVersion 可用，标记重试
            updateItem(item.id, { retryCount: item.retryCount + 1 });
            result.failed++;
          }
        } else if (res.status === 404 && item.type === "deleteNote") {
          // 已被删除，视为成功
          dequeue(item.id);
          result.success++;
        } else if (res.status === 404 && item.type === "updateNote") {
          // 笔记已不存在，放弃
          dequeue(item.id);
          result.failed++;
        } else if (res.status >= 400 && res.status < 500) {
          // 4xx 客户端错误（非 409/404）：不可恢复，丢弃
          dequeue(item.id);
          result.failed++;
        } else {
          // 5xx / 其他网络问题：保留，下次重试
          updateItem(item.id, { retryCount: item.retryCount + 1 });
          result.failed++;
          // 5xx 意味着服务器有问题，后续项也可能失败，break 避免无意义轰炸
          break;
        }
      } catch {
        // 网络错误（仍然离线）：停止 flush
        updateItem(item.id, { retryCount: item.retryCount + 1 });
        result.failed++;
        break;
      }
    }
  } finally {
    flushing = false;
    result.remaining = getQueueLength();
    notifyListeners();
  }

  return result;
}

// ─── Event / Subscription ─────────────────────────────────────────────────────

type Listener = (count: number) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function notifyListeners(): void {
  const count = getQueueLength();
  listeners.forEach((fn) => fn(count));
}

// ─── 判断是否该入队的工具 ──────────────────────────────────────────────────────

/**
 * 判断一个失败的请求是否应该入队离线重试。
 * 条件：
 *   1) 是写入类请求（POST/PUT/DELETE）
 *   2) 是笔记相关 URL（/notes 或 /notes/:id）
 *   3) 失败原因是网络不可达 或 服务器 5xx
 */
export function shouldEnqueue(
  url: string,
  method: string,
  error: any,
): boolean {
  // 只拦截写入方法
  const m = method.toUpperCase();
  if (m !== "POST" && m !== "PUT" && m !== "DELETE") return false;

  // 只拦截笔记相关 URL
  if (!isNotesMutationUrl(url)) return false;

  // 判断错误类型
  if (isNetworkError(error)) return true;
  if (error?.status >= 500) return true;

  return false;
}

/** 判断 URL 是否是笔记写入相关 */
function isNotesMutationUrl(url: string): boolean {
  // /notes, /notes/:id, /notes/:id/... 但排除特殊路径如 /notes/reorder/batch, /notes/trash/empty
  if (/^\/notes(\/[^/]+)?$/.test(url)) return true;
  return false;
}

/** 判断是否为网络错误（fetch 抛出，而非服务端返回） */
export function isNetworkError(error: any): boolean {
  if (!error) return false;
  // fetch 在断网时抛 TypeError: Failed to fetch / Network request failed
  if (error instanceof TypeError) return true;
  if (error.name === "TypeError") return true;
  // AbortError 不算
  if (error.name === "AbortError") return false;
  // 没有 status 的错误通常是网络问题
  if (!error.status && error.message && /fetch|network|ERR_/i.test(error.message)) return true;
  return false;
}

/**
 * 从 URL + method 推断操作类型
 */
export function inferMutationType(url: string, method: string): OfflineMutationType | null {
  const m = method.toUpperCase();
  if (m === "POST" && url === "/notes") return "createNote";
  if (m === "PUT" && /^\/notes\/[^/]+$/.test(url)) return "updateNote";
  if (m === "DELETE" && /^\/notes\/[^/]+$/.test(url)) return "deleteNote";
  return null;
}

/**
 * 从 URL 中提取笔记 ID
 */
export function extractNoteId(url: string): string {
  const match = url.match(/^\/notes\/([^/?]+)/);
  return match ? match[1] : "";
}
