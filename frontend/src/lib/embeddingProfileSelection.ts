export type EmbeddingCredentialSource = "chat" | "profile" | "custom";

export interface EmbeddingSettingsLike {
  ai_embedding_profile_id?: string;
  ai_embedding_url?: string;
  ai_embedding_key_set?: boolean;
}

export interface EmbeddingSettingsDraftLike {
  source: EmbeddingCredentialSource;
  profileId: string;
  url: string;
  key: string;
  keySet: boolean;
  model: string;
}

export interface EmbeddingSettingsPayload {
  ai_embedding_profile_id: string;
  ai_embedding_url: string;
  ai_embedding_model: string;
  ai_embedding_key?: string;
}

export function inferEmbeddingCredentialSource(
  settings: EmbeddingSettingsLike,
): EmbeddingCredentialSource {
  if ((settings.ai_embedding_profile_id || "").trim()) return "profile";
  if ((settings.ai_embedding_url || "").trim() || settings.ai_embedding_key_set) return "custom";
  return "chat";
}

/**
 * Build a settings payload without copying a saved Profile's secret into the dedicated key field.
 */
export function buildEmbeddingSettingsPayload(
  draft: EmbeddingSettingsDraftLike,
): EmbeddingSettingsPayload {
  const base: EmbeddingSettingsPayload = {
    ai_embedding_profile_id: draft.source === "profile" ? draft.profileId.trim() : "",
    ai_embedding_url: draft.source === "custom" ? draft.url.trim() : "",
    ai_embedding_model: draft.model.trim(),
  };

  if (draft.source !== "custom") {
    return { ...base, ai_embedding_key: "" };
  }
  if (draft.key.trim()) {
    return { ...base, ai_embedding_key: draft.key.trim() };
  }
  if (!draft.keySet) {
    return { ...base, ai_embedding_key: "" };
  }
  return base;
}
