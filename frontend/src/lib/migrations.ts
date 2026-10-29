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

export interface MigrationReportItem {
  id: string; sourceId: string; title: string; path: string[]; status: string;
  action: "create" | "existing" | "skip";
  decision: "auto" | "skip" | "keep-existing" | "create-copy";
  warnings: string[]; error: string | null; targetNoteId: string | null;
}
export interface MigrationUploadSession {
  id: string; jobId: string; status: "OPEN" | "FINALIZING" | "COMPLETE" | "CANCELLED" | "EXPIRED" | "FAILED";
  offset: number; size: number; chunkBytes: number; sha256: string;
}
export type MigrationUploadProgress = { phase: "hashing" | "uploading"; loaded: number; total: number };

async function uploadResumable(id: string, file: File, options: {
  onProgress?: (progress: MigrationUploadProgress) => void; current?: () => boolean;
} = {}): Promise<MigrationJob> {
  const initialScope = getOfflineQueueStorageKey();
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > (/\.zip$/i.test(file.name) ? 512 : 2) * 1024 * 1024) throw new Error("MIGRATION_UPLOAD_SIZE");
  const check = () => {
    if (initialScope !== getOfflineQueueStorageKey()) throw new Error("MIGRATION_ACCOUNT_CHANGED");
    if (options.current && !options.current()) throw new Error("MIGRATION_UPLOAD_INTERRUPTED");
  };
  const { createSHA256, sha256 } = await import("hash-wasm");
  const digest = await createSHA256(); digest.init();
  const budget = 4 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += budget) {
    check(); const bytes = new Uint8Array(await file.slice(offset, offset + budget).arrayBuffer()); check();
    digest.update(bytes); options.onProgress?.({ phase: "hashing", loaded: Math.min(offset + budget, file.size), total: file.size });
  }
  const fileHash = digest.digest("hex"); check();
  const operationId = await sha256(JSON.stringify([file.name, file.size, fileHash, null])); check();
  const base = `/${encodeURIComponent(id)}/upload-sessions`;
  let session = await request<MigrationUploadSession>(base, { method: "POST", body: JSON.stringify({ operationId, filename: file.name, size: file.size, sha256: fileHash }) });
  const validate = () => {
    check();
    if (session.jobId !== id || session.size !== file.size || session.sha256 !== fileHash
      || !Number.isSafeInteger(session.offset) || session.offset < 0 || session.offset > file.size
      || !Number.isSafeInteger(session.chunkBytes) || session.chunkBytes < 1 || session.chunkBytes > budget) throw new Error("MIGRATION_INVALID_RESPONSE");
  };
  validate();
  const sessionPath = `${base}/${encodeURIComponent(session.id)}`;
  if (session.status === "COMPLETE") return request<MigrationJob>(`/${encodeURIComponent(id)}`);
  while (session.offset < file.size) {
    validate(); const offset = session.offset;
    const chunk = file.slice(offset, offset + session.chunkBytes);
    const chunkHash = await sha256(new Uint8Array(await chunk.arrayBuffer())); check();
    try {
      session = await request<MigrationUploadSession>(`${sessionPath}/chunks?offset=${offset}`, {
        method: "PUT", body: chunk, headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": chunkHash },
      });
    } catch (error) {
      check();
      // A lost response may already have a durable receipt. Never guess the next offset.
      try { session = await request<MigrationUploadSession>(sessionPath); } catch { throw error; }
      validate(); if (session.offset <= offset) throw error;
    }
    validate();
    if (session.offset <= offset) throw new Error("MIGRATION_INVALID_RESPONSE");
    options.onProgress?.({ phase: "uploading", loaded: session.offset, total: file.size });
  }
  check();
  return request<MigrationJob>(`${sessionPath}/complete`, { method: "POST", body: "{}" });
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
  uploadResumable,
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
  items: (id: string, cursor = "") => request<{ job: MigrationJob; items: MigrationReportItem[]; nextCursor: string | null }>(`/${encodeURIComponent(id)}/report?${new URLSearchParams({ limit: "50", cursor })}`),
  decide: (id: string, itemId: string, previewDigest: string, decision: MigrationReportItem["decision"]) => action(id, `items/${encodeURIComponent(itemId)}/decision`, { previewDigest, decision }),
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
  "UPLOADING", "SCANNING", "NORMALIZING", "APPROVED", "IMPORTING", "VERIFYING",
].includes(status);
