import { getBaseUrl } from "./api";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";
import { getOfflineQueueStorageKey } from "./offlineScope";

export type MigrationStatus =
  | "CREATED" | "UPLOADING" | "SCANNING" | "NORMALIZING" | "PREVIEW_READY"
  | "APPROVED" | "IMPORTING" | "VERIFYING" | "PAUSED"
  | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED" | "UNDONE";

export interface MigrationJob {
  id: string;
  name: string;
  source: { platform: string; exportId: string };
  workspaceId: string | null;
  targetNotebookId?: string | null;
  status: MigrationStatus;
  counts: {
    total: number; create: number; existing: number; skipped: number; needsAttention: number;
    imported: number; failed: number; attachments: number; bytes: number;
  };
  previewDigest: string | null;
  warnings: string[];
  rootNotebookId: string | null;
  createdAt: string;
  updatedAt: string;
  error?: string | null;
  undo?: { available: boolean; reason: string | null };
}

export interface CreateMigrationInput {
  operationId: string;
  source: { platform: string; exportId: string };
  name: string;
  workspaceId?: string;
  targetNotebookId?: string;
}

interface MigrationReportPage {
  job: MigrationJob;
  items: Record<string, unknown>[];
  nextCursor: string | null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const scope = getOfflineQueueStorageKey();
  const token = getAccessToken();
  const response = await fetchWithAuthRefresh(`${getBaseUrl()}/migrations${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body && !(init.body instanceof Blob) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  }, getBaseUrl());
  // An old response must not update the newly signed-in account's UI or trigger another upload.
  if (scope !== getOfflineQueueStorageKey()) throw new Error("MIGRATION_ACCOUNT_CHANGED");
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error || `HTTP ${response.status}`), {
      status: response.status, code: payload?.code, conflicts: payload?.conflicts,
    });
  }
  if (!payload || typeof payload !== "object") throw new Error("MIGRATION_INVALID_RESPONSE");
  return payload as T;
}

const action = (id: string, name: string, body?: unknown) => request<MigrationJob>(`/${encodeURIComponent(id)}/${name}`, {
  method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const migrationApi = {
  list: async () => {
    const payload = await request<{ items: MigrationJob[] }>("");
    if (!Array.isArray(payload.items)) throw new Error("MIGRATION_INVALID_RESPONSE");
    return payload.items;
  },
  get: (id: string) => request<MigrationJob>(`/${encodeURIComponent(id)}`),
  create: (input: CreateMigrationInput) => request<MigrationJob>("", { method: "POST", body: JSON.stringify(input) }),
  upload: (id: string, file: File) => request<MigrationJob>(`/${encodeURIComponent(id)}/uploads?${new URLSearchParams({ filename: file.name })}`, {
    method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" },
  }),
  preview: (id: string) => action(id, "preview"),
  approve: (id: string, previewDigest: string) => action(id, "approve", { previewDigest }),
  retry: (id: string) => action(id, "retry"),
  cancel: (id: string) => action(id, "cancel"),
  pause: (id: string) => action(id, "pause"),
  resume: (id: string) => action(id, "resume"),
  undo: (id: string) => action(id, "undo"),
  report: async (id: string): Promise<{ job: MigrationJob; items: Record<string, unknown>[] }> => {
    const scope = getOfflineQueueStorageKey();
    const items: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    let page: MigrationReportPage;
    do {
      if (scope !== getOfflineQueueStorageKey()) throw new Error("MIGRATION_ACCOUNT_CHANGED");
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      page = await request<MigrationReportPage>(`/${encodeURIComponent(id)}/report?${query}`);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return { job: page.job, items };
  },
};

export const migrationIsActive = (status: MigrationStatus) => [
  "SCANNING", "NORMALIZING", "APPROVED", "IMPORTING", "VERIFYING",
].includes(status);
