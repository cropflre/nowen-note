import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type Database from "better-sqlite3";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-user-ai-settings-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let db: Database.Database;
let closeDb: () => void;
let repository: typeof import("../src/repositories/userAISettingsRepository").userAISettingsRepository;
let settingsService: typeof import("../src/services/user-ai-settings");
let aiApp: Hono;

test.before(async () => {
  const [schema, repositoryModule, serviceModule, aiRoutes] = await Promise.all([
    import("../src/db/schema"),
    import("../src/repositories/userAISettingsRepository"),
    import("../src/services/user-ai-settings"),
    import("../src/routes/ai"),
  ]);
  db = schema.getDb();
  closeDb = schema.closeDb;
  repository = repositoryModule.userAISettingsRepository;
  settingsService = serviceModule;
  aiApp = new Hono();
  aiApp.route("/ai", aiRoutes.default);
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("user-a", "user-a", "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("user-b", "user-b", "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("service-a", "service-a", "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("service-b", "service-b", "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("route-a", "route-a", "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("route-b", "route-b", "hash");
});

test.after(async () => {
  closeDb?.();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (error?.code !== "EBUSY" || attempt === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("repository keeps AI settings isolated by user", () => {
  repository.setMany("user-a", [
    { key: "ai_provider", value: "openai" },
    { key: "ai_api_key", value: "key-a" },
  ]);
  repository.setMany("user-b", [
    { key: "ai_provider", value: "deepseek" },
    { key: "ai_api_key", value: "key-b" },
  ]);

  assert.equal(repository.get("user-a", "ai_api_key")?.value, "key-a");
  assert.equal(repository.get("user-b", "ai_api_key")?.value, "key-b");
  assert.deepEqual(
    repository.getMany("user-a", ["ai_provider", "ai_api_key"]).map((row) => [row.key, row.value]),
    [["ai_api_key", "key-a"], ["ai_provider", "openai"]],
  );
});

test("deleting a user cascades only that user's AI settings", () => {
  db.prepare("DELETE FROM users WHERE id = ?").run("user-a");
  assert.equal(repository.get("user-a", "ai_api_key"), undefined);
  assert.equal(repository.get("user-b", "ai_api_key")?.value, "key-b");
});

test("service resolves chat and embedding settings by user", () => {
  settingsService.setUserAISettings("service-a", [
    { key: "ai_provider", value: "openai" },
    { key: "ai_api_key", value: "key-a" },
    { key: "ai_model", value: "model-a" },
    { key: "ai_embedding_model", value: "embed-a" },
  ]);
  settingsService.setUserAISettings("service-b", [
    { key: "ai_provider", value: "deepseek" },
    { key: "ai_api_key", value: "key-b" },
    { key: "ai_model", value: "model-b" },
    { key: "ai_embedding_model", value: "embed-b" },
  ]);

  assert.deepEqual(settingsService.getUserAISettings("service-a"), {
    ai_provider: "openai",
    ai_api_url: "https://api.openai.com/v1",
    ai_api_key: "key-a",
    ai_model: "model-a",
    ai_embedding_profile_id: "",
    ai_embedding_url: "",
    ai_embedding_key: "",
    ai_embedding_model: "embed-a",
  });
  assert.equal(settingsService.getUserAISettings("service-b").ai_api_key, "key-b");
  assert.equal(settingsService.getUserAISettings("service-b").ai_model, "model-b");
  assert.throws(() => settingsService.getUserAISettings(""), /userId/);
});

test("guarded writes only respect the target user's manual AI switch", () => {
  settingsService.setUserAISetting("service-a", "ai_manual_enabled", "false");
  settingsService.setGuardedUserAISettings("service-a", [
    { key: "ai_api_key", value: "blocked-key" },
    { key: "ai_model", value: "blocked-model" },
  ]);
  settingsService.setGuardedUserAISettings("service-b", [
    { key: "ai_api_key", value: "updated-key-b" },
  ]);

  assert.equal(settingsService.getUserAISettings("service-a").ai_api_key, "key-a");
  assert.equal(settingsService.getUserAISettings("service-a").ai_model, "model-a");
  assert.equal(settingsService.getUserAISettings("service-b").ai_api_key, "updated-key-b");
  assert.equal(settingsService.isManualAIEnabled("service-a"), false);
  assert.equal(settingsService.isManualAIEnabled("service-b"), true);
});

test("AI settings endpoints do not leak configuration across users", async () => {
  const updated = await aiApp.request("/ai/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-User-Id": "route-a" },
    body: JSON.stringify({
      ai_provider: "deepseek",
      ai_api_url: "https://route-a.example/v1/",
      ai_api_key: "route-a-secret",
      ai_model: "route-a-model",
      ai_embedding_profile_id: "route-a-embedding-profile",
    }),
  });
  assert.equal(updated.status, 200);

  const userA = await aiApp.request("/ai/settings", {
    headers: { "X-User-Id": "route-a" },
  });
  const userB = await aiApp.request("/ai/settings", {
    headers: { "X-User-Id": "route-b" },
  });
  const missingUser = await aiApp.request("/ai/settings");
  const userABody = await userA.json() as any;
  const userBBody = await userB.json() as any;

  assert.equal(userABody.ai_api_url, "https://route-a.example/v1");
  assert.equal(userABody.ai_api_key_set, true);
  assert.equal(userABody.ai_embedding_profile_id, "route-a-embedding-profile");
  assert.equal(userBBody.ai_embedding_profile_id, "");
  assert.equal(userBBody.ai_api_url, "https://api.openai.com/v1");
  assert.equal(userBBody.ai_api_key_set, false);
  assert.equal(missingUser.status, 401);
});
