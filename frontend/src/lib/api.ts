export * from "./api.impl";

import { api as baseApi, getBaseUrl, getCurrentWorkspace, getServerUrl } from "./api.impl";
import { invalidateNotebooks } from "./notebookInvalidation";
import { registerAttachmentAccessUrls } from "./noteAttachmentAccessBridge";
import {
  fetchJsonWithUploadDeadline,
  IMAGE_HOSTING_UPLOAD_TIMEOUT_MS,
  isElectronFullLocalRuntime,
  LOCAL_ATTACHMENT_UPLOAD_TIMEOUT_MS,
  UploadRequestError,
} from "./uploadRequest";
import type { Note, Task } from "@/types";

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

type EnhancedApi = typeof baseApi & {
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

// Multipart uploads intentionally bypass api.impl's JSON request() wrapper. Give both image
// targets a hard deadline and a real AbortController so an unreachable NAS or image host can no
// longer leave the editor lifecycle stuck in "uploading" indefinitely.
api.imageHosting.upload = (async (file: File | Blob, source?: string) => {
  if (isExplicitlyOffline()) {
    throw offlineUploadError("当前处于离线状态，第三方图床不可用");
  }
  const token = localStorage.getItem("nowen-token");
  const form = new FormData();
  form.append("file", file);
  if (source) form.append("source", source);
  return fetchJsonWithUploadDeadline<Awaited<ReturnType<typeof baseApi.imageHosting.upload>>>(
    `${getBaseUrl()}/image-hosting/upload`,
    {
      method: "POST",
      credentials: "include",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    },
    {
      timeoutMs: IMAGE_HOSTING_UPLOAD_TIMEOUT_MS,
      timeoutMessage: "图床上传超时，正在尝试本地存储",
      httpErrorMessage: "图床上传失败",
    },
  );
}) as typeof baseApi.imageHosting.upload;

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
