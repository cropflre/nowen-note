export * from "./api.impl";

import { api as baseApi, getBaseUrl, getCurrentWorkspace, getServerUrl } from "./api.impl";
import { invalidateNotebooks } from "./notebookInvalidation";
import { registerAttachmentAccessUrls } from "./noteAttachmentAccessBridge";
import { getProgressiveSearchExtraDelayMs } from "./searchRequestPolicy";
import {
  fetchJsonWithUploadDeadline,
  isElectronFullLocalRuntime,
  LOCAL_ATTACHMENT_UPLOAD_TIMEOUT_MS,
  UploadRequestError,
} from "./uploadRequest";
import type { Note, SearchResult, Task } from "@/types";

export type TaskActivityEvent = {
  id: string;
  taskId: string | null;
  taskTitle: string;
  eventType: "created" | "completed";
  userId: string;
  workspaceId: string | null;
  projectId: string | null;
  occurredAt: string;
  createdAt: string;
};

type TaskActivityQuery = {
  from?: string;
  to?: string;
  limit?: number;
};

type SearchRequestOptions = {
  signal?: AbortSignal;
  /** Internal escape hatch for explicit callers that already debounce short terms. */
  skipProgressiveDelay?: boolean;
};

type EnhancedApi = typeof baseApi & {
  search: (q: string, options?: SearchRequestOptions) => Promise<SearchResult[]>;
  getTaskActivityEvents: (params?: TaskActivityQuery) => Promise<TaskActivityEvent[]>;
  restoreTaskCompletedAt: (taskId: string, completedAt: string) => Promise<Task>;
  /**
   * Conflict resolution writes must be confirmed by the server immediately. Unlike the normal
   * note mutation methods, these calls never turn a network failure into an optimistic offline
   * queue item, because doing so would make the UI claim that a conflict was resolved too early.
   */
  createNoteConfirmed: (data: Partial<Note>) => Promise<Note>;
  updateNoteConfirmed: (id: string, data: Partial<Note>) => Promise<Note>;
};

async function authenticatedJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("nowen-token");
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Nowen-Content-View": "internal",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const error = new Error(
      typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`,
    ) as Error & { code?: string; status?: number; currentVersion?: number };
    error.code = payload?.code;
    error.status = response.status;
    if (typeof payload?.currentVersion === "number") error.currentVersion = payload.currentVersion;
    throw error;
  }
  return payload as T;
}

function generateConfirmedNoteId(): string {
  const randomUUID = typeof crypto !== "undefined" ? (crypto as any).randomUUID : undefined;
  if (typeof randomUUID === "function") return randomUUID.call(crypto);
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-4${Math.random().toString(16).slice(2, 5)}-${Math.random().toString(16).slice(2, 6)}-${Math.random().toString(16).slice(2, 14)}`;
}

async function confirmedNoteJson<T>(path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 30_000);
  try {
    return await authenticatedJson<T>(path, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      throw new Error("服务器确认超时，请检查网络后重试。");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function isExplicitlyOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function isDesktopFullLocalUploadRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return isElectronFullLocalRuntime(
    getServerUrl(),
    Boolean((window as any).nowenDesktop?.isDesktop),
  );
}

function offlineUploadError(message: string): UploadRequestError {
  return new UploadRequestError(message, {
    code: "OFFLINE",
    retryable: true,
  });
}

const api = baseApi as EnhancedApi;
let activeSearchController: AbortController | null = null;
let activeSearchDelayTimer: ReturnType<typeof setTimeout> | null = null;
let rejectActiveDelayedSearch: ((reason: unknown) => void) | null = null;
let activeSearchSequence = 0;

function createSearchAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Search superseded", "AbortError");
  }
  const error = new Error("Search superseded");
  error.name = "AbortError";
  return error;
}

function cancelActiveSearch(): void {
  activeSearchController?.abort();
  activeSearchController = null;
  if (activeSearchDelayTimer !== null) {
    clearTimeout(activeSearchDelayTimer);
    activeSearchDelayTimer = null;
  }
  const reject = rejectActiveDelayedSearch;
  rejectActiveDelayedSearch = null;
  reject?.(createSearchAbortError());
}

function executeSearch(
  normalized: string,
  sequence: number,
  options: SearchRequestOptions,
): Promise<SearchResult[]> {
  const controller = new AbortController();
  activeSearchController = controller;
  const abortFromCaller = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  const params = new URLSearchParams();
  params.set("q", normalized);
  const workspace = getCurrentWorkspace();
  if (workspace && workspace !== "personal") params.set("workspaceId", workspace);

  const path = `/search?${params.toString()}`;
  return authenticatedJson<SearchResult[]>(path, {
    signal: controller.signal,
  }).catch((error) => {
    if ((error as { name?: string })?.name === "AbortError") throw error;
    // Keep Android/native compatibility: api.impl's request wrapper can fall back to
    // CapacitorHttp when WebView fetch is unavailable. This path is only used after the
    // cancellable fetch itself has failed, never for an intentionally aborted stale request.
    return baseApi.search(normalized);
  }).finally(() => {
    options.signal?.removeEventListener("abort", abortFromCaller);
    if (sequence === activeSearchSequence && activeSearchController === controller) {
      activeSearchController = null;
    }
  });
}

/**
 * SearchCenter already debounces input by 180 ms, but requests that crossed that boundary used
 * to continue after the next keystroke. With synchronous better-sqlite3, obsolete M/MT literal
 * scans could therefore make the final MTU query wait several seconds on a low-power NAS.
 *
 * Latest-query-wins cancellation handles requests already in flight. One/two-character Latin
 * fragments receive an additional 420 ms grace period, so ordinary progressive typing never
 * sends them; when the user intentionally pauses on C or AI, the short query still executes.
 */
api.search = ((q: string, options: SearchRequestOptions = {}) => {
  const normalized = q.trim();
  const sequence = ++activeSearchSequence;
  cancelActiveSearch();
  if (!normalized) return Promise.resolve([]);

  const extraDelay = options.skipProgressiveDelay
    ? 0
    : getProgressiveSearchExtraDelayMs(normalized);
  if (extraDelay === 0) return executeSearch(normalized, sequence, options);

  return new Promise<SearchResult[]>((resolve, reject) => {
    const abortDelayed = () => {
      if (sequence !== activeSearchSequence) return;
      if (activeSearchDelayTimer !== null) {
        clearTimeout(activeSearchDelayTimer);
        activeSearchDelayTimer = null;
      }
      rejectActiveDelayedSearch = null;
      reject(createSearchAbortError());
    };

    if (options.signal?.aborted) {
      reject(createSearchAbortError());
      return;
    }
    options.signal?.addEventListener("abort", abortDelayed, { once: true });

    rejectActiveDelayedSearch = (reason) => {
      options.signal?.removeEventListener("abort", abortDelayed);
      reject(reason);
    };
    activeSearchDelayTimer = setTimeout(() => {
      activeSearchDelayTimer = null;
      rejectActiveDelayedSearch = null;
      options.signal?.removeEventListener("abort", abortDelayed);
      if (sequence !== activeSearchSequence) {
        reject(createSearchAbortError());
        return;
      }
      void executeSearch(normalized, sequence, options).then(resolve, reject);
    }, extraDelay);
  });
}) as EnhancedApi["search"];

// Multipart attachment uploads intentionally bypass api.impl's JSON request() wrapper. Give the
// Nowen attachment target a hard deadline and a real AbortController so an unreachable NAS can no
// longer leave the editor lifecycle stuck in "uploading" indefinitely.
api.attachments.upload = (async (noteId: string, file: File) => {
  if (isExplicitlyOffline() && !isDesktopFullLocalUploadRuntime()) {
    throw offlineUploadError("当前处于离线状态，图片尚未上传；请恢复网络后重试");
  }
  const token = localStorage.getItem("nowen-token");
  const form = new FormData();
  form.append("file", file);
  form.append("noteId", noteId);
  const fullUrl = `${getBaseUrl()}/attachments`;
  const payload = await fetchJsonWithUploadDeadline<Awaited<ReturnType<typeof baseApi.attachments.upload>>>(
    fullUrl,
    {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    },
    {
      timeoutMs: LOCAL_ATTACHMENT_UPLOAD_TIMEOUT_MS,
      timeoutMessage: "附件上传超时，请检查本地服务或网络后重试",
      httpErrorMessage: "附件上传失败",
    },
  );
  registerAttachmentAccessUrls(payload.accessUrls, fullUrl);
  return payload;
}) as typeof baseApi.attachments.upload;

const nativeMoveNotebook = baseApi.moveNotebook.bind(baseApi);
const nativeReorderNotebooks = baseApi.reorderNotebooks.bind(baseApi);
const nativeUpdateNotebook = baseApi.updateNotebook.bind(baseApi);

api.moveNotebook = (async (...args: Parameters<typeof baseApi.moveNotebook>) => {
  const moved = await nativeMoveNotebook(...args);
  invalidateNotebooks("move");
  return moved;
}) as typeof baseApi.moveNotebook;

api.reorderNotebooks = (async (...args: Parameters<typeof baseApi.reorderNotebooks>) => {
  const reordered = await nativeReorderNotebooks(...args);
  invalidateNotebooks("reorder");
  return reordered;
}) as typeof baseApi.reorderNotebooks;

api.updateNotebook = (async (...args: Parameters<typeof baseApi.updateNotebook>) => {
  const updated = await nativeUpdateNotebook(...args);
  const patch = args[1] as Record<string, unknown> | undefined;
  if (patch && Object.prototype.hasOwnProperty.call(patch, "parentId")) {
    invalidateNotebooks("move");
  }
  return updated;
}) as typeof baseApi.updateNotebook;

api.getTaskActivityEvents = (params: TaskActivityQuery = {}) => {
  const search = new URLSearchParams();
  const workspace = getCurrentWorkspace();
  if (workspace && workspace !== "personal") search.set("workspaceId", workspace);
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.limit) search.set("limit", String(params.limit));
  const query = search.toString();
  return authenticatedJson<TaskActivityEvent[]>(`/tasks/stats/activity-events${query ? `?${query}` : ""}`);
};

api.restoreTaskCompletedAt = (taskId: string, completedAt: string) =>
  authenticatedJson<Task>(`/tasks/${encodeURIComponent(taskId)}/completed-at`, {
    method: "PATCH",
    body: JSON.stringify({ completedAt }),
  });

api.createNoteConfirmed = async (data: Partial<Note>) => {
  const payload: Partial<Note> & { id: string } = {
    ...data,
    id: data.id || generateConfirmedNoteId(),
  };
  const created = await confirmedNoteJson<Note>("/notes", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  void import("@/lib/syncEngine").then((module) => module.cacheNoteContent(created)).catch(() => {});
  return created;
};

api.updateNoteConfirmed = async (id: string, data: Partial<Note>) => {
  const updated = await confirmedNoteJson<Note>(`/notes/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
  void import("@/lib/syncEngine").then((module) => module.cacheNoteContent(updated)).catch(() => {});
  return updated;
};

// Preserve real completion time when a caller (notably task backup import) supplies it.
const nativeCreateTask = baseApi.createTask.bind(baseApi);
api.createTask = (async (data: Partial<Task>) => {
  const created = await nativeCreateTask(data);
  if (!created.isCompleted || !data.completedAt) return created;
  const parsed = new Date(data.completedAt);
  if (Number.isNaN(parsed.getTime())) return created;
  try {
    return await api.restoreTaskCompletedAt(created.id, parsed.toISOString());
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 404 || status === 405 || status === 501) {
      console.warn("[task-import] old backend cannot restore completedAt; keeping imported task", error);
      return created;
    }
    throw error;
  }
}) as typeof baseApi.createTask;

// Statistics only render the current year. Bound the collection request when callers
// omit a range so long-lived workspaces do not download their entire check-in history.
const nativeGetHabitCheckinLog = baseApi.getHabitCheckinLog.bind(baseApi);
api.getHabitCheckinLog = ((params?: {
  from?: string;
  to?: string;
  includeArchived?: boolean;
}) => {
  const year = new Date().getFullYear();
  return nativeGetHabitCheckinLog({
    ...params,
    from: params?.from || `${year}-01-01`,
    to: params?.to || `${year}-12-31`,
  });
}) as typeof baseApi.getHabitCheckinLog;

export { api };
