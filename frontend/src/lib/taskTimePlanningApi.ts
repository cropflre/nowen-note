import { getBaseUrl, getCurrentWorkspace } from "./api";

export interface TaskTimeBlock {
  id: string;
  taskId: string;
  userId: string;
  workspaceId: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  createdAt: string;
  updatedAt: string;
  taskTitle: string;
  priority: number;
  projectId: string | null;
  isCompleted: number;
  estimatedMinutes: number | null;
}

export interface TaskTimeBlockList {
  workspaceId: string;
  from: string;
  to: string;
  blocks: TaskTimeBlock[];
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

export async function getTaskTimeBlocks(from: string, to: string): Promise<TaskTimeBlockList> {
  const params = new URLSearchParams({
    workspaceId: currentWorkspaceId(),
    from,
    to,
  });
  return request<TaskTimeBlockList>(`/user-preferences/task-time-blocks?${params.toString()}`);
}

export async function createTaskTimeBlock(input: {
  taskId: string;
  startAt: string;
  endAt: string;
  timeZone: string;
}): Promise<TaskTimeBlock> {
  const response = await request<{ block: TaskTimeBlock }>("/user-preferences/task-time-blocks", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return response.block;
}

export async function updateTaskTimeBlock(
  id: string,
  input: { startAt: string; endAt: string; timeZone?: string },
): Promise<TaskTimeBlock> {
  const response = await request<{ block: TaskTimeBlock }>(`/user-preferences/task-time-blocks/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  return response.block;
}

export async function deleteTaskTimeBlock(id: string): Promise<void> {
  await request<{ success: true }>(`/user-preferences/task-time-blocks/${id}`, {
    method: "DELETE",
  });
}

export async function updateTaskEstimate(
  taskId: string,
  estimatedMinutes: number | null,
): Promise<{ taskId: string; estimatedMinutes: number | null }> {
  return request(`/user-preferences/task-time-blocks/tasks/${taskId}/estimate`, {
    method: "PUT",
    body: JSON.stringify({ estimatedMinutes }),
  });
}
