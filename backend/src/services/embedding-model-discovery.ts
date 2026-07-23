import { getUserAISettings } from "./user-ai-settings";
import {
  normalizeServiceUrl,
  readProfiles,
  type EmbeddingCredentialSource,
} from "./embedding-config";

export interface EmbeddingProbeInput {
  source?: EmbeddingCredentialSource;
  profileId?: string;
  url?: string;
  apiKey?: string;
  model?: string;
}

export interface EmbeddingProbeConfig {
  source: EmbeddingCredentialSource;
  profileId: string | null;
  profileName: string | null;
  provider: string;
  url: string;
  apiKey: string;
  model: string;
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

export class EmbeddingDiscoveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
    public readonly upstreamStatus: number | null = null,
  ) {
    super(message);
    this.name = "EmbeddingDiscoveryError";
  }
}

const DISCOVERY_TIMEOUT_MS = 12_000;
const TEST_TIMEOUT_MS = 15_000;
const POSITIVE_MODEL_RE = /(?:^|[-_/:.])(embed(?:ding)?|bge|e5|gte|text2vec|nomic-embed|mxbai-embed|arctic-embed|jina-embeddings?|voyage|multilingual-e5|sentence-transformers?)(?:$|[-_/:.])/i;
const NEGATIVE_MODEL_RE = /(?:^|[-_/:.])(chat|instruct|vision|image|dall-e|whisper|tts|speech|audio|rerank|moderation|transcribe|claude|gemini-pro-vision|qwen-vl|llava)(?:$|[-_/:.])/i;
const CHAT_FAMILY_RE = /^(?:gpt-|o[134](?:-|$)|deepseek-(?:chat|reasoner)|claude-|llama\d|mistral(?:-|$)|qwen(?:\d|[-_:])|gemma(?:\d|[-_:]))/i;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveSource(settings: ReturnType<typeof getUserAISettings>, input: EmbeddingProbeInput): EmbeddingCredentialSource {
  if (input.source === "chat" || input.source === "profile" || input.source === "custom") return input.source;
  if (clean(input.profileId) || settings.ai_embedding_profile_id.trim()) return "profile";
  if (clean(input.url) || clean(input.apiKey) || settings.ai_embedding_url.trim() || settings.ai_embedding_key.trim()) return "custom";
  return "chat";
}

export function resolveEmbeddingProbeConfig(
  userId: string,
  input: EmbeddingProbeInput,
  requireModel: boolean,
): EmbeddingProbeConfig {
  const settings = getUserAISettings(userId);
  const source = resolveSource(settings, input);
  const model = clean(input.model) || settings.ai_embedding_model.trim();

  if (requireModel && !model) {
    throw new EmbeddingDiscoveryError("EMBEDDING_MODEL_MISSING", "请先填写要测试的 Embedding 模型", 400);
  }

  if (source === "profile") {
    const profileId = clean(input.profileId) || settings.ai_embedding_profile_id.trim();
    if (!profileId) {
      throw new EmbeddingDiscoveryError("EMBEDDING_PROFILE_REQUIRED", "请先选择 AI Profile", 400);
    }
    const profile = readProfiles(userId).find((item) => item.id === profileId);
    if (!profile) {
      throw new EmbeddingDiscoveryError(
        "EMBEDDING_PROFILE_NOT_FOUND",
        "绑定的 AI 配置已被删除，请重新选择 Embedding 服务",
        400,
      );
    }
    const url = normalizeServiceUrl(profile.provider, profile.apiUrl);
    if (!url) {
      throw new EmbeddingDiscoveryError(
        "EMBEDDING_PROFILE_URL_MISSING",
        `AI 配置“${profile.name}”没有可用的 API 地址`,
        400,
      );
    }
    return {
      source,
      profileId: profile.id,
      profileName: profile.name,
      provider: profile.provider,
      url,
      apiKey: profile.apiKey,
      model,
    };
  }

  if (source === "custom") {
    const provider = settings.ai_provider.trim() || "openai";
    const rawUrl = clean(input.url) || settings.ai_embedding_url.trim();
    const url = normalizeServiceUrl(provider, rawUrl);
    if (!url) {
      throw new EmbeddingDiscoveryError("EMBEDDING_URL_MISSING", "请先填写 Embedding API 地址", 400);
    }
    const suppliedKey = clean(input.apiKey);
    const apiKey = suppliedKey && !suppliedKey.includes("****")
      ? suppliedKey
      : settings.ai_embedding_key.trim();
    return {
      source,
      profileId: null,
      profileName: null,
      provider,
      url,
      apiKey,
      model,
    };
  }

  const provider = settings.ai_provider.trim() || "openai";
  const url = normalizeServiceUrl(provider, settings.ai_api_url);
  if (!url) {
    throw new EmbeddingDiscoveryError("EMBEDDING_URL_MISSING", "当前对话配置没有可用的 API 地址", 400);
  }
  return {
    source: "chat",
    profileId: null,
    profileName: null,
    provider,
    url,
    apiKey: settings.ai_api_key.trim(),
    model,
  };
}

function requestHeaders(config: EmbeddingProbeConfig): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
    if (config.provider === "gemini") headers["x-goog-api-key"] = config.apiKey;
  }
  return headers;
}

function modelEndpoint(url: string): string {
  const base = url.replace(/\/+$/, "");
  return /\/models$/i.test(base) ? base : `${base}/models`;
}

function modelRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.models)) return record.models;
  return [];
}

function capabilityText(row: Record<string, unknown>): string {
  const values = [row.type, row.object, row.task, row.category, row.capability, row.capabilities];
  return values.map((value) => {
    if (Array.isArray(value)) return value.join(" ");
    if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>)
      .filter(([, enabled]) => enabled === true || enabled === "true")
      .map(([key]) => key)
      .join(" ");
    return String(value || "");
  }).join(" ").toLowerCase();
}

function classifyModel(row: unknown): EmbeddingModelOption | null {
  const record = row && typeof row === "object" ? row as Record<string, unknown> : {};
  const id = typeof row === "string"
    ? row.trim()
    : clean(record.id) || clean(record.name) || clean(record.model);
  if (!id) return null;
  const name = typeof row === "string"
    ? id
    : clean(record.display_name) || clean(record.displayName) || clean(record.name) || id;
  const metadata = capabilityText(record);
  const positive = POSITIVE_MODEL_RE.test(id) || /(?:embedding|embeddings|feature-extraction|sentence-similarity)/i.test(metadata);
  const negative = NEGATIVE_MODEL_RE.test(id)
    || CHAT_FAMILY_RE.test(id)
    || /(?:chat|vision|image|audio|speech|rerank|generation)/i.test(metadata);
  if (negative && !positive) return null;
  return { id, name, recommended: positive };
}

function extractEmbeddingModels(data: unknown): {
  models: EmbeddingModelOption[];
  discoveredCount: number;
  filteredCount: number;
} {
  const rows = modelRows(data);
  const seen = new Set<string>();
  const models: EmbeddingModelOption[] = [];
  for (const row of rows) {
    const model = classifyModel(row);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  models.sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name));
  return {
    models,
    discoveredCount: rows.length,
    filteredCount: Math.max(0, rows.length - models.length),
  };
}

function timeoutError(error: unknown): boolean {
  const name = error && typeof error === "object" ? String((error as { name?: unknown }).name || "") : "";
  const message = error instanceof Error ? error.message : String(error || "");
  return name === "AbortError" || name === "TimeoutError" || /timeout|timed out/i.test(message);
}

function upstreamError(status: number, detail: string, action: "discover" | "test"): EmbeddingDiscoveryError {
  if (status === 401 || status === 403) {
    return new EmbeddingDiscoveryError(
      "EMBEDDING_AUTH_FAILED",
      "Embedding 服务认证失败，请检查 API Key 或 Profile 权限",
      502,
      status,
    );
  }
  if (status === 404) {
    return new EmbeddingDiscoveryError(
      action === "test" ? "EMBEDDING_ENDPOINT_NOT_FOUND" : "EMBEDDING_MODELS_ENDPOINT_NOT_FOUND",
      action === "test"
        ? "服务未提供 /embeddings 接口，请检查 API 地址或兼容模式"
        : "服务未提供模型列表接口，请手动填写 Embedding 模型",
      502,
      status,
    );
  }
  return new EmbeddingDiscoveryError(
    action === "test" ? "EMBEDDING_TEST_FAILED" : "EMBEDDING_MODEL_DISCOVERY_FAILED",
    `Embedding 服务返回 HTTP ${status}${detail ? `：${detail.slice(0, 180)}` : ""}`,
    502,
    status,
  );
}

export async function discoverEmbeddingModels(
  userId: string,
  input: EmbeddingProbeInput,
): Promise<EmbeddingModelDiscoveryResult> {
  const config = resolveEmbeddingProbeConfig(userId, input, false);
  const candidates = config.provider === "ollama"
    ? [
        `${config.url.replace(/\/+$/, "").replace(/\/v1$/i, "")}/api/tags`,
        modelEndpoint(config.url),
      ]
    : [modelEndpoint(config.url)];
  const failures: EmbeddingDiscoveryError[] = [];

  for (const endpoint of Array.from(new Set(candidates))) {
    try {
      const response = await fetch(endpoint, {
        headers: requestHeaders(config),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        failures.push(upstreamError(response.status, await response.text().catch(() => ""), "discover"));
        continue;
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        failures.push(new EmbeddingDiscoveryError(
          "EMBEDDING_MODELS_RESPONSE_INVALID",
          "模型列表接口返回了无法解析的响应，请手动填写模型",
          502,
          response.status,
        ));
        continue;
      }
      const extracted = extractEmbeddingModels(data);
      if (extracted.discoveredCount === 0) {
        failures.push(new EmbeddingDiscoveryError(
          "EMBEDDING_MODELS_EMPTY",
          "模型列表接口没有返回可识别的模型，请手动填写模型",
          502,
          response.status,
        ));
        continue;
      }
      return { ...extracted, source: config.source, endpoint };
    } catch (error) {
      if (error instanceof EmbeddingDiscoveryError) {
        failures.push(error);
      } else if (timeoutError(error)) {
        failures.push(new EmbeddingDiscoveryError(
          "EMBEDDING_DISCOVERY_TIMEOUT",
          "刷新模型列表超时，请检查服务地址和网络",
          504,
        ));
      } else {
        failures.push(new EmbeddingDiscoveryError(
          "EMBEDDING_MODEL_DISCOVERY_FAILED",
          error instanceof Error ? error.message : "模型列表请求失败",
          502,
        ));
      }
    }
  }

  throw failures[failures.length - 1] || new EmbeddingDiscoveryError(
    "EMBEDDING_MODEL_DISCOVERY_FAILED",
    "无法获取模型列表，请手动填写模型",
    502,
  );
}

function extractVector(data: unknown): number[] | null {
  if (!data || typeof data !== "object") return null;
  const rows = (data as { data?: unknown }).data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0];
  if (!first || typeof first !== "object") return null;
  const vector = (first as { embedding?: unknown }).embedding;
  if (!Array.isArray(vector) || vector.length === 0) return null;
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return vector as number[];
}

export async function testEmbeddingModel(
  userId: string,
  input: EmbeddingProbeInput,
): Promise<EmbeddingTestResult> {
  const config = resolveEmbeddingProbeConfig(userId, input, true);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${config.url.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        ...requestHeaders(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        input: ["Nowen Note embedding connectivity test."],
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw upstreamError(response.status, await response.text().catch(() => ""), "test");
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new EmbeddingDiscoveryError(
        "EMBEDDING_RESPONSE_INVALID",
        "/embeddings 返回了无法解析的 JSON",
        502,
        response.status,
      );
    }
    const vector = extractVector(data);
    if (!vector) {
      throw new EmbeddingDiscoveryError(
        "EMBEDDING_RESPONSE_INVALID",
        "/embeddings 响应缺少有效的 data[0].embedding 数组",
        502,
        response.status,
      );
    }
    return {
      success: true,
      source: config.source,
      provider: config.provider,
      model: config.model,
      dimension: vector.length,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } catch (error) {
    if (error instanceof EmbeddingDiscoveryError) throw error;
    if (timeoutError(error)) {
      throw new EmbeddingDiscoveryError(
        "EMBEDDING_TEST_TIMEOUT",
        "测试 Embedding 模型超时，请检查服务状态、模型名称和网络",
        504,
      );
    }
    throw new EmbeddingDiscoveryError(
      "EMBEDDING_TEST_FAILED",
      error instanceof Error ? error.message : "Embedding 连通性测试失败",
      502,
    );
  }
}

export function embeddingDiscoveryErrorBody(error: unknown): {
  error: string;
  code: string;
  upstreamStatus: number | null;
} {
  if (error instanceof EmbeddingDiscoveryError) {
    return { error: error.message, code: error.code, upstreamStatus: error.upstreamStatus };
  }
  return {
    error: error instanceof Error ? error.message : "Embedding 请求失败",
    code: "EMBEDDING_REQUEST_FAILED",
    upstreamStatus: null,
  };
}
