import { getBaseUrl, getCurrentWorkspace } from "./api";

export type TaskMetadataStatus = "todo" | "doing" | "blocked" | "done";
export type TaskMetadataDue = "all" | "pending" | "today" | "week" | "overdue" | "completed";
export type TaskLabelMode = "any" | "all";

export interface TaskLabel {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  color: string;
  sortOrder: number;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSavedViewFilters {
  labelIds: string[];
  labelMode: TaskLabelMode;
  priorities: number[];
  statuses: TaskMetadataStatus[];
  due: TaskMetadataDue;
  keyword: string;
  projectId?: string | null;
}

export interface TaskSavedView {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  filters: TaskSavedViewFilters;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMetadataSnapshot {
  workspaceId: string;
  labels: TaskLabel[];
  assignments: Record<string, string[]>;
  views: TaskSavedView[];
}

export const EMPTY_TASK_SAVED_VIEW_FILTERS: TaskSavedViewFilters = {
  labelIds: [],
  labelMode: "any",
  priorities: [],
  statuses: [],
  due: "all",
  keyword: "",
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("nowen-token");
  const response = await fetch(`${getBaseUrl()}/user-preferences/task-metadata${path}`, {
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
    try { payload = JSON.parse(text); } catch { payload = text; }
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

function workspaceId(): string {
  return getCurrentWorkspace() || "personal";
}

export function getTaskMetadata(): Promise<TaskMetadataSnapshot> {
  return request(`?workspaceId=${encodeURIComponent(workspaceId())}`);
}

export function createTaskLabel(input: { name: string; color?: string }): Promise<{ label: TaskLabel }> {
  return request("/labels", {
    method: "POST",
    body: JSON.stringify({ ...input, workspaceId: workspaceId() }),
  });
}

export function updateTaskLabel(
  id: string,
  input: { name?: string; color?: string; sortOrder?: number },
): Promise<{ label: TaskLabel }> {
  return request(`/labels/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteTaskLabel(id: string): Promise<{ success: boolean }> {
  return request(`/labels/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function setTaskLabels(
  taskId: string,
  labelIds: string[],
): Promise<{ taskId: string; labelIds: string[] }> {
  return request(`/tasks/${encodeURIComponent(taskId)}/labels`, {
    method: "PUT",
    body: JSON.stringify({ labelIds }),
  });
}

export function createTaskSavedView(input: {
  name: string;
  filters: TaskSavedViewFilters;
}): Promise<{ view: TaskSavedView }> {
  return request("/views", {
    method: "POST",
    body: JSON.stringify({ ...input, workspaceId: workspaceId() }),
  });
}

export function updateTaskSavedView(
  id: string,
  input: { name?: string; filters?: TaskSavedViewFilters; sortOrder?: number },
): Promise<{ view: TaskSavedView }> {
  return request(`/views/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteTaskSavedView(id: string): Promise<{ success: boolean }> {
  return request(`/views/${encodeURIComponent(id)}`, { method: "DELETE" });
}
