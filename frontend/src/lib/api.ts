export * from "./api.impl";

import { api as baseApi, getBaseUrl, getCurrentWorkspace } from "./api.impl";
import type { Task } from "@/types";

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
    ) as Error & { code?: string; status?: number };
    error.code = payload?.code;
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

const api = baseApi as EnhancedApi;

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

// Preserve real completion time when a caller (notably task backup import) supplies it.
const nativeCreateTask = baseApi.createTask.bind(baseApi);
api.createTask = (async (data: Partial<Task>) => {
  const created = await nativeCreateTask(data);
  if (!created.isCompleted || !data.completedAt) return created;
  const parsed = new Date(data.completedAt);
  if (Number.isNaN(parsed.getTime())) return created;
  return api.restoreTaskCompletedAt(created.id, parsed.toISOString());
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
