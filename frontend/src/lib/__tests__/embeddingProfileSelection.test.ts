import { describe, expect, it } from "vitest";
import {
  buildEmbeddingSettingsPayload,
  inferEmbeddingCredentialSource,
} from "../embeddingProfileSelection";

describe("embedding profile selection", () => {
  it("prefers a fixed profile over legacy dedicated credentials", () => {
    expect(inferEmbeddingCredentialSource({
      ai_embedding_profile_id: "profile-1",
      ai_embedding_url: "https://legacy.example/v1",
      ai_embedding_key_set: true,
    })).toBe("profile");
  });

  it("detects custom and chat credential sources", () => {
    expect(inferEmbeddingCredentialSource({ ai_embedding_url: "https://embed.example/v1" })).toBe("custom");
    expect(inferEmbeddingCredentialSource({ ai_embedding_key_set: true })).toBe("custom");
    expect(inferEmbeddingCredentialSource({})).toBe("chat");
  });

  it("stores only the profile id and clears duplicated dedicated secrets", () => {
    expect(buildEmbeddingSettingsPayload({
      source: "profile",
      profileId: "profile-1",
      url: "https://should-not-save.example/v1",
      key: "should-not-save",
      keySet: true,
      model: "bge-m3",
    })).toEqual({
      ai_embedding_profile_id: "profile-1",
      ai_embedding_url: "",
      ai_embedding_model: "bge-m3",
      ai_embedding_key: "",
    });
  });

  it("preserves an existing custom key when the field is left blank", () => {
    expect(buildEmbeddingSettingsPayload({
      source: "custom",
      profileId: "",
      url: "https://embed.example/v1/",
      key: "",
      keySet: true,
      model: "embed-model",
    })).toEqual({
      ai_embedding_profile_id: "",
      ai_embedding_url: "https://embed.example/v1/",
      ai_embedding_model: "embed-model",
    });
  });
});
