import { getBaseUrl } from "./api";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";
import { getOfflineQueueStorageKey } from "./offlineScope";

export const OPEN_AI_MEMORY = "nowen:open-ai-memory";
export function openAIMemory(tab: "archive" | "memories" | "connections" = "archive"): void { window.dispatchEvent(new CustomEvent(OPEN_AI_MEMORY, { detail: { tab } })); }
export interface AIMemorySource { id: string; provider: string; accountScope: string; displayName: string; notebookId: string;
  captureEnabled: boolean; permissionState: "granted" | "revoked"; lastSyncedAt: string | null }
export interface AIConversation { id: string; sourceId: string; title: string; sourceUrl: string; noteId: string | null;
  completeness: string; revision: number; messageCount: number; projectionStatus: string; lastSyncedAt: string; deletedAt: string | null }
export interface AIImportJob { id: string; sourceId: string; filename: string; status: string; previewDigest: string; expiresAt: string;
  warnings: string[]; counts: { total: number; saved: number; failed: number; pending: number; skipped: number };
  items: Array<{ index: number; title: string; messages: number; completeness: string; expectedRevision: number; status: string; noteId?: string; error?: string; preview?: string }> }
export interface AIConversationMessage { id: string; role: string; text: string; captureState: string }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const scope = getOfflineQueueStorageKey(), base = getBaseUrl();
  const guardedFetch: typeof fetch = (url, options) => {
    if (scope !== getOfflineQueueStorageKey() || base !== getBaseUrl()) throw new Error("AI_MEMORY_ACCOUNT_CHANGED");
    return fetch(url, options);
  };
  const token = getAccessToken();
  const response = await fetchWithAuthRefresh(`${base}/ai-memory${path}`, { ...init, credentials: "include",
    headers: { ...(init.body ? { "Content-Type": init.body instanceof Blob ? "application/octet-stream" : "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } }, base, guardedFetch);
  if (scope !== getOfflineQueueStorageKey()) throw new Error("AI_MEMORY_ACCOUNT_CHANGED");
  const body = await response.json().catch(() => null);
  if (scope !== getOfflineQueueStorageKey()) throw new Error("AI_MEMORY_ACCOUNT_CHANGED");
  if (!response.ok) throw Object.assign(new Error(body?.error || `HTTP ${response.status}`), { code: body?.code, status: response.status });
  if (!body || typeof body !== "object") throw new Error("AI_MEMORY_INVALID_RESPONSE");
  return body as T;
}
function items<T>(body: { items: T[] }): T[] {
  if (!Array.isArray(body.items)) throw new Error("AI_MEMORY_INVALID_RESPONSE");
  return body.items;
}
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const aiMemoryApi = {
  sources: async () => items(await request<{ items: AIMemorySource[] }>("/sources")),
  createSource: (body: { provider: string; accountScope: string; notebookId: string; displayName: string; permissionState: "granted"; captureEnabled: false }) => request<AIMemorySource>("/sources", json("POST", body)),
  updateSource: (id: string, body: { captureEnabled?: boolean; permissionState?: "granted" | "revoked"; displayName?: string }) => request<AIMemorySource>(`/sources/${encodeURIComponent(id)}`, json("PATCH", body)),
  revokeSource: (id: string) => request<AIMemorySource>(`/sources/${encodeURIComponent(id)}`, json("DELETE")),
  conversations: (options: { sourceId?: string; q?: string; offset?: number; includeDeleted?: boolean } = {}) => {
    const query = new URLSearchParams({ limit: "30", offset: String(options.offset || 0) });
    if (options.sourceId) query.set("sourceId", options.sourceId);
    if (options.q) query.set("q", options.q);
    if (options.includeDeleted) query.set("includeDeleted", "true");
    return request<{ items: AIConversation[]; total: number }>(`/conversations?${query}`);
  },
  messages: async (id: string) => items(await request<{ items: AIConversationMessage[] }>(`/conversations/${encodeURIComponent(id)}/messages`)),
  exportConversation: (id: string) => request<Record<string, unknown>>(`/conversations/${encodeURIComponent(id)}/export`),
  deleteConversation: (id: string) => request(`/conversations/${encodeURIComponent(id)}`, json("DELETE")),
  restoreConversation: (id: string) => request(`/conversations/${encodeURIComponent(id)}/restore`, json("POST")),
  rebuildNote: (id: string) => request(`/conversations/${encodeURIComponent(id)}/rebuild-note`, json("POST")),
  imports: async () => items(await request<{ items: AIImportJob[] }>("/imports")),
  previewImport: (sourceId: string, file: File, signal?: AbortSignal) => {
    if (file.size > 64 * 1024 * 1024 || !file.size) throw new Error("AI_IMPORT_UPLOAD_LIMIT");
    return request<AIImportJob>(`/imports/preview?${new URLSearchParams({ sourceId, filename: file.name })}`, { method: "POST", body: file, signal });
  },
  importJob: (id: string) => request<AIImportJob>(`/imports/${encodeURIComponent(id)}`),
  startImport: (job: AIImportJob) => request<AIImportJob>("/imports", json("POST", { jobId: job.id, previewDigest: job.previewDigest })),
  cancelImport: (id: string) => request<AIImportJob>(`/imports/${encodeURIComponent(id)}/cancel`, json("POST")),
  retryImport: (job: AIImportJob) => request<AIImportJob>(`/imports/${encodeURIComponent(job.id)}/retry`, json("POST", { previewDigest: job.previewDigest })),
  discardImport: (id: string) => request(`/imports/${encodeURIComponent(id)}`, json("DELETE")),
};
