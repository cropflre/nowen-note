import { getBaseUrl } from "@/lib/api";
import type { EmbeddingCredentialSource } from "@/lib/embeddingProfileSelection";

export interface EmbeddingProbeDraft {
  source: EmbeddingCredentialSource;
  profileId: string;
  url: string;
  key: string;
  model: string;
}

export interface EmbeddingProbePayload {
  source: EmbeddingCredentialSource;
  profileId?: string;
  url?: string;
  apiKey?: string;
  model?: string;
}

export interface EmbeddingModelOption {
  id: string;
  name: string;
  recommended: boolean;
}

export interface EmbeddingModelDiscoveryResult {
  models: EmbeddingModelOption[];
  source: EmbeddingCredentialSource;
  endpoint: string;
  discoveredCount: number;
  filteredCount: number;
}

export interface EmbeddingTestResult {
  success: true;
  source: EmbeddingCredentialSource;
  provider: string;
  model: string;
  dimension: number;
  durationMs: number;
}

export interface EmbeddingRequestError extends Error {
  code?: string;
  upstreamStatus?: number | null;
  status?: number;
}

export function buildEmbeddingProbePayload(draft: EmbeddingProbeDraft): EmbeddingProbePayload {
  const payload: EmbeddingProbePayload = { source: draft.source };
  if (draft.source === "profile" && draft.profileId.trim()) {
    payload.profileId = draft.profileId.trim();
  }
  if (draft.source === "custom") {
    if (draft.url.trim()) payload.url = draft.url.trim();
    if (draft.key.trim() && !draft.key.includes("****")) payload.apiKey = draft.key.trim();
  }
  if (draft.model.trim()) payload.model = draft.model.trim();
  return payload;
}

export function mergeEmbeddingModelOptions(
  defaults: string[],
  discovered: EmbeddingModelOption[],
): EmbeddingModelOption[] {
  const byId = new Map<string, EmbeddingModelOption>();
  for (const id of defaults) {
    const clean = id.trim();
    if (!clean) continue;
    byId.set(clean, { id: clean, name: clean, recommended: true });
  }
  for (const model of discovered) {
    const id = model.id.trim();
    if (!id) continue;
    const current = byId.get(id);
    byId.set(id, {
      id,
      name: model.name.trim() || current?.name || id,
      recommended: !!model.recommended || !!current?.recommended,
    });
  }
  return [...byId.values()].sort(
    (a, b) => Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name),
  );
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem("nowen-token") || "";
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request<T>(path: string, payload: EmbeddingProbePayload): Promise<T> {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error || `请求失败: ${response.status}`) as EmbeddingRequestError;
    error.code = body?.code;
    error.upstreamStatus = body?.upstreamStatus ?? null;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

export function discoverEmbeddingModels(draft: EmbeddingProbeDraft): Promise<EmbeddingModelDiscoveryResult> {
  return request<EmbeddingModelDiscoveryResult>(
    "/ai/embeddings/models",
    buildEmbeddingProbePayload(draft),
  );
}

export function testEmbeddingModel(draft: EmbeddingProbeDraft): Promise<EmbeddingTestResult> {
  return request<EmbeddingTestResult>(
    "/ai/embeddings/test",
    buildEmbeddingProbePayload(draft),
  );
}
