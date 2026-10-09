import { getBaseUrl } from "./api.impl";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";

export interface TaskDigestConfig {
  userId: string;
  morningEnabled: number;
  eveningEnabled: number;
  dueEnabled: number;
  morningTime: string;
  eveningTime: string;
  timezone: string;
}
export interface TaskDigestPreview {
  kind: "morning" | "evening";
  date: string;
  timezone: string;
  summary: string;
  counts: { dueToday: number; pendingToday: number; completedDueToday: number; completedToday: number; overdue: number };
  tasks: Array<{ taskId: string; title: string; dueAt: string | null; dueDate: string | null }>;
}
async function request<T>(path: string, init: RequestInit = {}, apiPath = "/task-digest"): Promise<T> {
  const token = getAccessToken();
  const baseUrl = getBaseUrl();
  const response = await fetchWithAuthRefresh(`${baseUrl}${apiPath}${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...(init.headers || {}) },
  }, baseUrl);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result as T;
}
export const taskDigestApi = {
  listWebhooks: () => request<Array<{ id: string; url: string; events: string[] }>>("", {}, "/webhooks"),
  addWebhook: (url: string) => request<{ id: string; secret: string }>("", { method: "POST", body: JSON.stringify({ url, events: ["task.digest.morning", "task.digest.evening", "task.due"], description: "每日任务简报" }) }, "/webhooks"),
  createPersonalTask: (title: string) => request<{ id: string }>("?workspaceId=personal", { method: "POST", body: JSON.stringify({ title }) }, "/tasks"),
  completePersonalTask: async (id: string) => {
    const task = await request<{ id: string; workspaceId: string | null }>(`/${encodeURIComponent(id)}`, {}, "/tasks");
    if (task.workspaceId != null) throw new Error("AI 助手暂不支持修改工作区任务，请在任务中心操作");
    return request<{ task?: { id: string } }>(`/${encodeURIComponent(id)}`, {
      method: "PUT", body: JSON.stringify({ isCompleted: 1 }),
    }, "/tasks");
  },
  get: () => request<TaskDigestConfig>(""),
  save: (body: Omit<TaskDigestConfig, "userId">) => request<TaskDigestConfig>("", { method: "PUT", body: JSON.stringify(body) }),
  preview: (kind: "morning" | "evening") => request<TaskDigestPreview>(`/preview?kind=${kind}`),
  test: (kind: "morning" | "evening") => request<{ queued: boolean; digest: TaskDigestPreview }>("/test", { method: "POST", body: JSON.stringify({ kind }) }),
};
