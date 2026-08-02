import type { Task } from "@/types";
import { getBaseUrl, getCurrentWorkspace } from "./api";

export type TaskCaptureSourceType =
  | "manual"
  | "global"
  | "selection"
  | "note"
  | "diary"
  | "share"
  | "other";

export interface TaskInboxItem extends Task {
  inboxAt: string;
  captureSourceType: TaskCaptureSourceType;
  captureSourceId: string | null;
  captureSourceTitle: string | null;
  captureExcerpt: string;
}

export interface TaskInboxResponse {
  workspaceId: string;
  count: number;
  items: TaskInboxItem[];
}

export interface TaskCaptureInput {
  title: string;
  description?: string;
  priority?: number;
  dueDate?: string | null;
  dueAt?: string | null;
  startDate?: string | null;
  noteId?: string | null;
  sourceType?: TaskCaptureSourceType;
  sourceId?: string | null;
  sourceTitle?: string | null;
  excerpt?: string;
}

function currentWorkspaceId(): string {
  const workspaceId = getCurrentWorkspace();
  return workspaceId && workspaceId !== "personal" ? workspaceId : "personal";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("nowen-token");
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
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

export async function getTaskInbox(): Promise<TaskInboxResponse> {
  const params = new URLSearchParams({ workspaceId: currentWorkspaceId() });
  return request<TaskInboxResponse>(`/user-preferences/task-inbox?${params.toString()}`);
}

export async function getTaskInboxCount(): Promise<number> {
  const params = new URLSearchParams({ workspaceId: currentWorkspaceId() });
  const result = await request<{ count: number }>(
    `/user-preferences/task-inbox/count?${params.toString()}`,
  );
  return result.count;
}

export async function captureTaskToInbox(input: TaskCaptureInput): Promise<{
  task: TaskInboxItem;
  count: number;
}> {
  return request("/user-preferences/task-inbox/capture", {
    method: "POST",
    body: JSON.stringify({
      ...input,
      workspaceId: currentWorkspaceId(),
    }),
  });
}

export async function addTaskToInbox(
  taskId: string,
  source?: Pick<TaskCaptureInput, "sourceType" | "sourceId" | "sourceTitle" | "excerpt">,
): Promise<{ success: boolean; taskId: string; count: number }> {
  return request(`/user-preferences/task-inbox/${encodeURIComponent(taskId)}`, {
    method: "POST",
    body: JSON.stringify(source || { sourceType: "manual" }),
  });
}

export async function removeTaskFromInbox(
  taskId: string,
): Promise<{ success: boolean; taskId: string; count: number }> {
  return request(`/user-preferences/task-inbox/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
}

export function publishTaskInboxChanged(detail?: { taskId?: string; count?: number }): void {
  window.dispatchEvent(new CustomEvent("nowen:task-inbox-changed", { detail }));
}

export function openTaskQuickCapture(detail?: {
  text?: string;
  sourceType?: TaskCaptureSourceType;
  sourceId?: string | null;
  sourceTitle?: string | null;
  noteId?: string | null;
}): void {
  window.dispatchEvent(new CustomEvent("nowen:open-task-capture", { detail }));
}
