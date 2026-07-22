import { getBaseUrl } from "./api";

export const ROUND_TRIP_IMPORT_COMPLETED_EVENT = "nowen:roundtrip-import-completed";
export const ROUND_TRIP_IMPORT_HISTORY_EVENT = "nowen:open-roundtrip-import-history";

export interface RoundTripImportBatchSummary {
  id: string;
  workspaceId: string | null;
  importMode: string;
  packageKind: string | null;
  sourceInstanceId: string | null;
  sourceExportBatchId: string | null;
  status: "running" | "completed" | "failed" | "undone";
  createdAt: string;
  completedAt: string | null;
  undoneAt: string | null;
  undo: {
    available: boolean;
    expiresAt: string | null;
    reason: string | null;
    error: string | null;
  };
  counts: Record<string, number>;
  warningCount: number;
  errorCount: number;
}

export interface RoundTripImportBatchDetail extends RoundTripImportBatchSummary {
  preview: Record<string, any>;
  result: Record<string, any>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("nowen-token");
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as T & {
    error?: string;
    code?: string;
    conflicts?: string[];
  };
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`) as Error & {
      code?: string;
      conflicts?: string[];
      status?: number;
    };
    error.code = payload.code;
    error.conflicts = payload.conflicts;
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function listRoundTripImportBatches(options: {
  workspaceId?: string | null;
  limit?: number;
} = {}): Promise<RoundTripImportBatchSummary[]> {
  const params = new URLSearchParams();
  if (options.workspaceId !== undefined) params.set("workspaceId", options.workspaceId || "personal");
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  const payload = await request<{ items: RoundTripImportBatchSummary[] }>(`/settings/import-batches${query ? `?${query}` : ""}`);
  return Array.isArray(payload.items) ? payload.items : [];
}

export function getRoundTripImportBatch(batchId: string): Promise<RoundTripImportBatchDetail> {
  return request(`/settings/import-batches/${encodeURIComponent(batchId)}`);
}

export function undoRoundTripImportBatch(batchId: string): Promise<RoundTripImportBatchDetail> {
  return request(`/settings/import-batches/${encodeURIComponent(batchId)}/undo`, { method: "POST" });
}

export function announceRoundTripImportCompleted(batchId: string): void {
  if (typeof window === "undefined" || !batchId) return;
  try {
    localStorage.setItem("nowen-last-roundtrip-import-batch", batchId);
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(ROUND_TRIP_IMPORT_COMPLETED_EVENT, { detail: { batchId } }));
}

export function openRoundTripImportHistory(batchId?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ROUND_TRIP_IMPORT_HISTORY_EVENT, { detail: { batchId } }));
}
