/**
 * Clipper 本地通道（Phase 8）。
 *
 * 目标：没有 NAS、没有服务器也能剪藏。
 *
 *   Extension → Native Messaging（发现/启动 Desktop）
 *             → localhost HTTP（传输网页内容）
 *             → Local SQLite
 *
 * Clipper **永远不关心用户是否开启了同步**。它只负责"存到 Nowen"，
 * 后续是否上传到服务器由 Desktop 的 Sync Engine 决定。
 *
 * 为什么内容走 HTTP 而不是 Native Messaging：
 * 后者有 1MB 单条消息上限，带图片的剪藏很容易超限，
 * 二进制还要额外编码。Native Messaging 只适合传"去哪里连"这类小信息。
 */

const NATIVE_HOST_NAME = "cn.nowen.note.clipper";

export interface LocalRuntimeInfo {
  port: number;
  token: string;
}

export interface LocalClipPayload {
  title: string;
  content: string;
  contentText?: string;
  contentFormat?: string;
  notebookId?: string;
  notebookName?: string;
  tags?: string[];
  sourceUrl?: string;
}

export interface LocalClipResult {
  noteId: string;
  notebookId: string;
  savedLocally: true;
}

interface NativeResponse {
  ok: boolean;
  running?: boolean;
  stale?: boolean;
  paired?: boolean;
  port?: number;
  token?: string;
  error?: string;
  detail?: string;
}

function chromeRuntime(): any {
  const api = (globalThis as any).chrome || (globalThis as any).browser;
  return api?.runtime;
}

function sendNative(message: unknown): Promise<NativeResponse> {
  return new Promise((resolve) => {
    const runtime = chromeRuntime();
    if (!runtime?.sendNativeMessage) {
      resolve({ ok: false, error: "NATIVE_UNAVAILABLE" });
      return;
    }
    try {
      runtime.sendNativeMessage(NATIVE_HOST_NAME, message, (response: NativeResponse) => {
        // lastError 说明 Native Host 未安装或崩溃；这不是用户能理解的错误，
        // 上层会翻译成"请先安装 Nowen 桌面端"。
        if (runtime.lastError) {
          resolve({ ok: false, error: "NATIVE_HOST_MISSING" });
          return;
        }
        resolve(response || { ok: false, error: "NATIVE_EMPTY_RESPONSE" });
      });
    } catch {
      resolve({ ok: false, error: "NATIVE_UNAVAILABLE" });
    }
  });
}

/**
 * 确保 Desktop 可用，必要时启动它。
 *
 * 用户点「保存到 Nowen」时 Desktop 可能没运行。此时先尝试启动并等待就绪，
 * 而不是直接抛出 "Connection refused 127.0.0.1"——那对普通用户毫无意义。
 */
export async function ensureDesktopReady(): Promise<
  { ok: true; runtime: LocalRuntimeInfo } | { ok: false; reason: string }
> {
  const discovered = await sendNative({ type: "discover" });
  if (discovered.ok && discovered.running && discovered.port) {
    if (discovered.token) {
      return { ok: true, runtime: { port: discovered.port, token: discovered.token } };
    }
    // Desktop 在运行但尚未配对：走配对流程（需用户在 Desktop 内确认）。
    const paired = await sendNative({ type: "pair" });
    if (paired.ok && paired.token && paired.port) {
      return { ok: true, runtime: { port: paired.port, token: paired.token } };
    }
    return { ok: false, reason: paired.error || "PAIR_FAILED" };
  }

  if (!discovered.ok && discovered.error === "NATIVE_HOST_MISSING") {
    return { ok: false, reason: "NATIVE_HOST_MISSING" };
  }

  // 未运行（或运行时文件残留）→ 尝试启动。
  const launched = await sendNative({ type: "launch" });
  if (launched.ok && launched.port) {
    if (launched.token) {
      return { ok: true, runtime: { port: launched.port, token: launched.token } };
    }
    const paired = await sendNative({ type: "pair" });
    if (paired.ok && paired.token && paired.port) {
      return { ok: true, runtime: { port: paired.port, token: paired.token } };
    }
    return { ok: false, reason: paired.error || "PAIR_FAILED" };
  }

  return { ok: false, reason: launched.error || "DESKTOP_UNAVAILABLE" };
}

/** 把技术错误翻译成用户能理解的话。 */
export function describeLocalFailure(reason: string): string {
  switch (reason) {
    case "NATIVE_HOST_MISSING":
    case "NATIVE_UNAVAILABLE":
      return "未检测到 Nowen 桌面端。请先安装并启动 Nowen Note。";
    case "LAUNCH_TIMEOUT":
      return "Nowen 正在启动，请稍后重试。本次剪藏已暂存，稍后会自动保存。";
    case "LAUNCH_FAILED":
      return "无法启动 Nowen 桌面端，请手动打开后重试。";
    case "PAIR_DECLINED":
      return "尚未在 Nowen 中允许浏览器扩展保存。请在桌面端确认后重试。";
    default:
      return "暂时无法保存到 Nowen，本次剪藏已暂存，稍后会自动重试。";
  }
}

async function localRequest<T>(
  runtime: LocalRuntimeInfo,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/local/clipper${path}`, {
    method: init?.method || "GET",
    headers: {
      Authorization: `Bearer ${runtime.token}`,
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const data = await response.json() as any;
      if (data?.error) message = String(data.error);
    } catch { /* 保留默认 */ }
    throw new Error(message);
  }
  return await response.json() as T;
}

export function listLocalNotebooks(runtime: LocalRuntimeInfo) {
  return localRequest<{ items: Array<{ id: string; name: string }> }>(runtime, "/notebooks");
}

export function listLocalTags(runtime: LocalRuntimeInfo) {
  return localRequest<{ items: Array<{ id: string; name: string }> }>(runtime, "/tags");
}

export function clipToLocal(runtime: LocalRuntimeInfo, payload: LocalClipPayload) {
  return localRequest<LocalClipResult>(runtime, "/clip", { method: "POST", body: payload });
}

// ---------------------------------------------------------------------------
// Pending Queue（第三十九条）
// ---------------------------------------------------------------------------

/**
 * 暂存队列。
 *
 * Desktop 临时不可用时把剪藏存进扩展自己的 IndexedDB，
 * 之后 Desktop 可用就自动 flush。用户的网页剪藏尽量不丢——
 * 用户已经关掉网页了，内容没保存下来就是永久丢失。
 *
 * 用 IndexedDB 而非 chrome.storage.local：后者有 5MB 配额，
 * 带图片的剪藏很容易撑爆。
 */
const DB_NAME = "nowen-clipper-pending";
const STORE = "clips";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export interface PendingClip {
  id?: number;
  payload: LocalClipPayload;
  queuedAt: number;
  retryCount: number;
  lastError?: string;
}

export async function enqueuePendingClip(payload: LocalClipPayload): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add({ payload, queuedAt: Date.now(), retryCount: 0 } as PendingClip);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function listPendingClips(): Promise<PendingClip[]> {
  const db = await openDb();
  const items = await new Promise<PendingClip[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as PendingClip[]);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return items;
}

async function removePendingClip(id: number): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function bumpPendingRetry(clip: PendingClip, error: string): Promise<void> {
  if (clip.id === undefined) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({
      ...clip,
      retryCount: clip.retryCount + 1,
      lastError: error.slice(0, 200),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/**
 * 尝试把暂存的剪藏全部保存到 Desktop。
 *
 * 失败的条目**保留**并累加重试次数，绝不因次数用尽而删除——
 * 那等于直接丢掉用户的内容。
 */
export async function flushPendingClips(): Promise<{ flushed: number; remaining: number }> {
  const pending = await listPendingClips();
  if (pending.length === 0) return { flushed: 0, remaining: 0 };

  const ready = await ensureDesktopReady();
  if (!ready.ok) return { flushed: 0, remaining: pending.length };

  let flushed = 0;
  for (const clip of pending) {
    try {
      await clipToLocal(ready.runtime, clip.payload);
      if (clip.id !== undefined) await removePendingClip(clip.id);
      flushed += 1;
    } catch (error) {
      await bumpPendingRetry(clip, error instanceof Error ? error.message : String(error));
    }
  }
  const remaining = (await listPendingClips()).length;
  return { flushed, remaining };
}

/**
 * 保存一条剪藏（带暂存兜底）。
 *
 * Desktop 不可用时不报错失败，而是暂存并告知用户"稍后会自动保存"。
 */
export async function saveClipLocalFirst(
  payload: LocalClipPayload,
): Promise<{ ok: true; noteId: string } | { ok: false; queued: true; message: string }> {
  const ready = await ensureDesktopReady();
  if (!ready.ok) {
    await enqueuePendingClip(payload);
    return { ok: false, queued: true, message: describeLocalFailure(ready.reason) };
  }
  try {
    const result = await clipToLocal(ready.runtime, payload);
    // 本次成功时顺手把之前积压的也 flush 掉。
    void flushPendingClips();
    return { ok: true, noteId: result.noteId };
  } catch (error) {
    await enqueuePendingClip(payload);
    return {
      ok: false,
      queued: true,
      message: describeLocalFailure(error instanceof Error ? error.message : "UNKNOWN"),
    };
  }
}
