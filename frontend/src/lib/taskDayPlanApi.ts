import { getBaseUrl, getCurrentWorkspace } from "./api";

export interface TaskDayPlan {
  date: string;
  workspaceId: string;
  taskIds: string[];
  focusTaskIds: string[];
  updatedAt: string | null;
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

export async function getTaskDayPlan(date: string): Promise<TaskDayPlan> {
  const params = new URLSearchParams({
    date,
    workspaceId: currentWorkspaceId(),
  });
  return request<TaskDayPlan>(`/user-preferences/task-day-plans?${params.toString()}`);
}

export async function saveTaskDayPlan(
  plan: Pick<TaskDayPlan, "date" | "taskIds" | "focusTaskIds">,
): Promise<TaskDayPlan> {
  return request<TaskDayPlan>("/user-preferences/task-day-plans", {
    method: "PUT",
    body: JSON.stringify({
      ...plan,
      workspaceId: currentWorkspaceId(),
    }),
  });
}

export async function clearTaskDayPlan(date: string): Promise<TaskDayPlan> {
  const params = new URLSearchParams({
    date,
    workspaceId: currentWorkspaceId(),
  });
  return request<TaskDayPlan>(`/user-preferences/task-day-plans?${params.toString()}`, {
    method: "DELETE",
  });
}
