import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-embedding-profile-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let closeDb: () => void;
let resolveEmbeddingConfig: typeof import("../src/services/embedding-config").resolveEmbeddingConfig;
let setUserAISettings: typeof import("../src/services/user-ai-settings").setUserAISettings;
let getUserAISetting: typeof import("../src/services/user-ai-settings").getUserAISetting;

const USER_ID = "embedding-profile-user";

function profiles(apiUrl = "https://profile.example/v1", apiKey = "profile-secret") {
  return JSON.stringify([{
    id: "profile-embed",
    name: "向量服务",
    provider: "openai",
    apiUrl,
    apiKey,
    model: "chat-model",
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  }]);
}

test.before(async () => {
  const [schema, configModule, settingsModule] = await Promise.all([
    import("../src/db/schema"),
    import("../src/services/embedding-config"),
    import("../src/services/user-ai-settings"),
  ]);
  closeDb = schema.closeDb;
  resolveEmbeddingConfig = configModule.resolveEmbeddingConfig;
  setUserAISettings = settingsModule.setUserAISettings;
  getUserAISetting = settingsModule.getUserAISetting;
  schema.getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
});

test.beforeEach(() => {
  setUserAISettings(USER_ID, [
    { key: "ai_provider", value: "deepseek" },
    { key: "ai_api_url", value: "https://chat.example/v1" },
    { key: "ai_api_key", value: "chat-secret" },
    { key: "ai_profiles_v1", value: profiles() },
    { key: "ai_embedding_profile_id", value: "profile-embed" },
    { key: "ai_embedding_url", value: "" },
    { key: "ai_embedding_key", value: "" },
    { key: "ai_embedding_model", value: "bge-m3" },
  ]);
});

test.after(async () => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("fixed profile credentials are independent from the active chat config", () => {
  const first = resolveEmbeddingConfig(USER_ID);
  assert.equal(first.source, "profile");
  assert.equal(first.profileId, "profile-embed");
  assert.equal(first.profileName, "向量服务");
  assert.deepEqual(first.config, {
    url: "https://profile.example/v1",
    model: "bge-m3",
    apiKey: "profile-secret",
    provider: "openai",
  });
  assert.equal(getUserAISetting(USER_ID, "ai_embedding_key"), "");

  setUserAISettings(USER_ID, [
    { key: "ai_provider", value: "ollama" },
    { key: "ai_api_url", value: "http://chat-changed.example/v1" },
    { key: "ai_api_key", value: "changed-chat-secret" },
  ]);

  assert.deepEqual(resolveEmbeddingConfig(USER_ID).config, first.config);
});

test("profile edits are read dynamically without copying the secret", () => {
  setUserAISettings(USER_ID, [
    { key: "ai_profiles_v1", value: profiles("https://profile-new.example/v1/", "profile-new-secret") },
  ]);

  assert.deepEqual(resolveEmbeddingConfig(USER_ID).config, {
    url: "https://profile-new.example/v1",
    model: "bge-m3",
    apiKey: "profile-new-secret",
    provider: "openai",
  });
  assert.equal(getUserAISetting(USER_ID, "ai_embedding_key"), "");
});

test("deleted profiles return an explicit non-fallback error", () => {
  setUserAISettings(USER_ID, [{ key: "ai_profiles_v1", value: "[]" }]);

  const result = resolveEmbeddingConfig(USER_ID);
  assert.equal(result.source, "profile");
  assert.equal(result.config, null);
  assert.equal(result.errorCode, "EMBEDDING_PROFILE_NOT_FOUND");
  assert.match(result.error || "", /已被删除/);
});

test("legacy custom and chat modes remain compatible", () => {
  setUserAISettings(USER_ID, [
    { key: "ai_embedding_profile_id", value: "" },
    { key: "ai_embedding_url", value: "https://custom.example/v1/" },
    { key: "ai_embedding_key", value: "custom-secret" },
  ]);
  assert.equal(resolveEmbeddingConfig(USER_ID).source, "custom");
  assert.equal(resolveEmbeddingConfig(USER_ID).config?.url, "https://custom.example/v1");

  setUserAISettings(USER_ID, [
    { key: "ai_embedding_url", value: "" },
    { key: "ai_embedding_key", value: "" },
  ]);
  const chat = resolveEmbeddingConfig(USER_ID);
  assert.equal(chat.source, "chat");
  assert.equal(chat.config?.url, "https://chat.example/v1");
  assert.equal(chat.config?.apiKey, "chat-secret");
});
