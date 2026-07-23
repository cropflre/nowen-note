import { getUserAISetting, getUserAISettings } from "./user-ai-settings";

export type EmbeddingCredentialSource = "chat" | "profile" | "custom";

export interface EmbeddingConfig {
  url: string;
  model: string;
  apiKey: string;
  provider: string;
}

export interface EmbeddingConfigResolution {
  source: EmbeddingCredentialSource;
  profileId: string | null;
  profileName: string | null;
  config: EmbeddingConfig | null;
  errorCode: string | null;
  error: string | null;
}

export interface StoredAIProfile {
  id: string;
  name: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
}

const OLLAMA_DOCKER_URL = process.env.OLLAMA_URL || "";

export function normalizeServiceUrl(provider: string, rawUrl: string): string {
  let url = rawUrl.trim().replace(/\/+$/, "");
  if (
    OLLAMA_DOCKER_URL
    && provider === "ollama"
    && url.includes("localhost:11434")
  ) {
    url = url.replace(/http:\/\/localhost:11434/, OLLAMA_DOCKER_URL.replace(/\/+$/, ""));
  }
  return url;
}

export function readProfiles(userId: string): StoredAIProfile[] {
  const raw = getUserAISetting(userId, "ai_profiles_v1");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const profile = item as Record<string, unknown>;
        const id = String(profile.id || "").trim();
        if (!id) return null;
        return {
          id,
          name: String(profile.name || "未命名配置").trim() || "未命名配置",
          provider: String(profile.provider || "openai").trim() || "openai",
          apiUrl: String(profile.apiUrl || "").trim(),
          apiKey: String(profile.apiKey || "").trim(),
        } satisfies StoredAIProfile;
      })
      .filter((profile): profile is StoredAIProfile => !!profile);
  } catch {
    return [];
  }
}

function failure(
  source: EmbeddingCredentialSource,
  profileId: string | null,
  profileName: string | null,
  errorCode: string,
  error: string,
): EmbeddingConfigResolution {
  return { source, profileId, profileName, config: null, errorCode, error };
}

/**
 * Resolve the effective embedding endpoint for one user.
 *
 * Precedence:
 * 1. A fixed saved AI Profile, referenced only by ID.
 * 2. Dedicated embedding URL/key fields.
 * 3. The current chat configuration.
 *
 * The embedding model always stays independent from the chat profile model.
 */
export function resolveEmbeddingConfig(userId: string): EmbeddingConfigResolution {
  const settings = getUserAISettings(userId);
  const model = settings.ai_embedding_model.trim();
  const profileId = settings.ai_embedding_profile_id.trim();

  if (profileId) {
    const profile = readProfiles(userId).find((item) => item.id === profileId);
    if (!profile) {
      return failure(
        "profile",
        profileId,
        null,
        "EMBEDDING_PROFILE_NOT_FOUND",
        "绑定的 AI 配置已被删除，请重新选择 Embedding 服务",
      );
    }
    const url = normalizeServiceUrl(profile.provider, profile.apiUrl);
    if (!url) {
      return failure(
        "profile",
        profile.id,
        profile.name,
        "EMBEDDING_PROFILE_URL_MISSING",
        `AI 配置“${profile.name}”没有可用的 API 地址`,
      );
    }
    if (!model) {
      return failure(
        "profile",
        profile.id,
        profile.name,
        "EMBEDDING_MODEL_MISSING",
        "尚未配置 Embedding 模型",
      );
    }
    return {
      source: "profile",
      profileId: profile.id,
      profileName: profile.name,
      config: {
        url,
        model,
        apiKey: profile.apiKey,
        provider: profile.provider,
      },
      errorCode: null,
      error: null,
    };
  }

  const embeddingUrl = settings.ai_embedding_url.trim();
  const embeddingKey = settings.ai_embedding_key.trim();
  const source: EmbeddingCredentialSource = embeddingUrl || embeddingKey ? "custom" : "chat";
  const provider = settings.ai_provider.trim() || "openai";
  const url = normalizeServiceUrl(provider, embeddingUrl || settings.ai_api_url);
  const apiKey = embeddingKey || settings.ai_api_key.trim();

  if (!url) {
    return failure(source, null, null, "EMBEDDING_URL_MISSING", "尚未配置可用的 Embedding API 地址");
  }
  if (!model) {
    return failure(source, null, null, "EMBEDDING_MODEL_MISSING", "尚未配置 Embedding 模型");
  }

  return {
    source,
    profileId: null,
    profileName: null,
    config: { url, model, apiKey, provider },
    errorCode: null,
    error: null,
  };
}
