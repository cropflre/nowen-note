import { getBaseUrl } from "@/lib/api";
import { fetchWithAuthRefresh, getAccessToken } from "@/lib/authSession";
import {
  ATTACHMENT_UPLOAD_MIN_TIMEOUT_MS,
  fetchJsonWithUploadDeadline,
} from "@/lib/uploadRequest";

export interface TaskAttachmentItem {
  id: string;
  taskId: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  /** 当前运行时可直接消费的绝对 URL。 */
  url: string;
}

export interface TaskAttachmentUploadResult {
  id: string;
  /** 当前运行时可直接消费的绝对 URL。 */
  url: string;
  /** 适合写回 task.description / task.title 的稳定相对 URL。 */
  stableUrl: string;
  filename: string;
  mimeType: string;
  size: number;
}

export const TASK_ATTACHMENTS_CHANGED_EVENT = "nowen:task-attachments-changed";
const TASK_ATTACHMENT_STABLE_PREFIX = "/api/task-attachments/";

function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  let payload: any = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!response.ok) {
    const message = typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.message === "string"
        ? payload.message
        : typeof payload === "string" && payload.trim()
          ? payload.slice(0, 240)
          : `${fallback}（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

export function taskAttachmentStableUrl(id: string): string {
  return `${TASK_ATTACHMENT_STABLE_PREFIX}${encodeURIComponent(id)}`;
}

export function taskAttachmentUrl(id: string, options: { download?: boolean } = {}): string {
  const suffix = options.download ? "?download=1" : "";
  return `${getBaseUrl()}/task-attachments/${encodeURIComponent(id)}${suffix}`;
}

/**
 * task.description 永远保存部署无关的 /api/task-attachments/<id>；编辑器显示时再
 * 转换为当前 getBaseUrl()，避免 Electron / Capacitor 把相对地址请求到壳页面。
 */
export function resolveTaskAttachmentMarkdownForEditor(markdown: string): string {
  if (!markdown || !markdown.includes(TASK_ATTACHMENT_STABLE_PREFIX)) return markdown;
  const runtimePrefix = `${getBaseUrl()}/task-attachments/`;
  return markdown.replace(/\/api\/task-attachments\/([A-Za-z0-9_-]+)/g, `${runtimePrefix}$1`);
}

export function stabilizeTaskAttachmentMarkdown(markdown: string): string {
  if (!markdown) return markdown;
  const runtimePrefix = `${getBaseUrl()}/task-attachments/`;
  return markdown.split(runtimePrefix).join(TASK_ATTACHMENT_STABLE_PREFIX);
}

export function emitTaskAttachmentsChanged(taskId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TASK_ATTACHMENTS_CHANGED_EVENT, { detail: { taskId } }));
}

export function subscribeTaskAttachmentsChanged(
  taskId: string,
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ taskId?: string }>).detail;
    if (!detail?.taskId || detail.taskId === taskId) listener();
  };
  window.addEventListener(TASK_ATTACHMENTS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(TASK_ATTACHMENTS_CHANGED_EVENT, handler);
}

export async function listTaskAttachments(taskId: string): Promise<TaskAttachmentItem[]> {
  const baseUrl = getBaseUrl();
  const response = await fetchWithAuthRefresh(
    `${baseUrl}/task-attachments?taskId=${encodeURIComponent(taskId)}`,
    { headers: authHeaders() },
    baseUrl,
  );
  const items = await readJsonResponse<Array<Omit<TaskAttachmentItem, "url"> & { url?: string }>>(
    response,
    "加载任务附件失败",
  );
  return items.map((item) => ({
    ...item,
    url: taskAttachmentUrl(item.id),
  }));
}

export async function uploadTaskAttachment(
  file: File,
  taskId: string,
): Promise<TaskAttachmentUploadResult> {
  const baseUrl = getBaseUrl();
  const form = new FormData();
  form.append("file", file);
  form.append("taskId", taskId);

  const result = await fetchJsonWithUploadDeadline<Omit<TaskAttachmentUploadResult, "stableUrl">>(
    `${baseUrl}/task-attachments`,
    {
      method: "POST",
      headers: authHeaders(),
      body: form,
    },
    {
      timeoutMs: ATTACHMENT_UPLOAD_MIN_TIMEOUT_MS,
      timeoutMessage: "任务附件上传超时，请检查网络后重试",
      httpErrorMessage: "任务附件上传失败",
    },
  );
  emitTaskAttachmentsChanged(taskId);
  return {
    ...result,
    url: taskAttachmentUrl(result.id),
    stableUrl: taskAttachmentStableUrl(result.id),
  };
}

export async function removeTaskAttachment(id: string, taskId: string): Promise<void> {
  const baseUrl = getBaseUrl();
  const response = await fetchWithAuthRefresh(
    `${baseUrl}/task-attachments/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: authHeaders() },
    baseUrl,
  );
  await readJsonResponse<{ success: boolean }>(response, "删除任务附件失败");
  emitTaskAttachmentsChanged(taskId);
}
