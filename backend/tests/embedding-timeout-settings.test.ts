import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-embedding-timeout-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
let app: Hono;
let closeDb: () => void;
let resolveEmbeddingConfig: typeof import("../src/services/embedding-config").resolveEmbeddingConfig;
let setUserAISettings: typeof import("../src/services/user-ai-settings").setUserAISettings;

async function request(userId: string, body?: unknown) {
  const response = await app.request("/ai/settings", {
    method: body === undefined ? "GET" : "PUT",
    headers: { "X-User-Id": userId, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

test.before(async () => {
  const [schema, routes, config, settings] = await Promise.all([
    import("../src/db/schema"), import("../src/routes/ai"),
    import("../src/services/embedding-config"), import("../src/services/user-ai-settings"),
  ]);
  closeDb = schema.closeDb;
  resolveEmbeddingConfig = config.resolveEmbeddingConfig;
  setUserAISettings = settings.setUserAISettings;
  for (const userId of ["timeout-a", "timeout-b"]) {
    schema.getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(userId, userId, "hash");
  }
  app = new Hono();
  app.route("/ai", routes.default);
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("index deadlines default to 30s, persist across reopen, and are isolated per user (DCC-006)", async () => {
  assert.equal((await request("timeout-a")).body.ai_embedding_timeout_seconds, "30");
  const saved = await request("timeout-a", { ai_embedding_timeout_seconds: "120", ai_embedding_model: "fixture" });
  assert.equal(saved.status, 200);
  closeDb();
  assert.equal((await request("timeout-a")).body.ai_embedding_timeout_seconds, "120");
  assert.equal((await request("timeout-b")).body.ai_embedding_timeout_seconds, "30");
  assert.equal(resolveEmbeddingConfig("timeout-a").config?.indexTimeoutMs, 120_000);
  // Fixed profiles and dedicated endpoints use the same user-scoped deadline.
  for (const patch of [
    { ai_embedding_url: "https://dedicated.example/v1" },
    { ai_embedding_profile_id: "fixed" },
  ]) {
    setUserAISettings("timeout-a", [{ key: "ai_profiles_v1", value: JSON.stringify([{ id: "fixed", apiUrl: "https://profile.example/v1" }]) }]);
    assert.equal((await request("timeout-a", patch)).status, 200);
    assert.equal(resolveEmbeddingConfig("timeout-a").config?.indexTimeoutMs, 120_000);
  }
});

test("invalid deadlines reject the entire settings update; valid boundaries are accepted", async () => {
  for (const value of [null, true, "", "abc", "29", "601", "30.5", {}, []]) {
    const result = await request("timeout-b", { ai_embedding_timeout_seconds: value, ai_embedding_model: "must-not-save" });
    assert.equal(result.status, 400, JSON.stringify(value));
    assert.equal((await request("timeout-b")).body.ai_embedding_model, "");
  }
  for (const value of [30, "600"]) {
    assert.equal((await request("timeout-b", { ai_embedding_timeout_seconds: value })).status, 200);
    assert.equal((await request("timeout-b")).body.ai_embedding_timeout_seconds, String(value));
  }
  setUserAISettings("timeout-b", [{ key: "ai_embedding_timeout_seconds", value: "broken" }, { key: "ai_embedding_model", value: "fixture" }]);
  assert.equal(resolveEmbeddingConfig("timeout-b").config?.indexTimeoutMs, 30_000);
});

test("older clients preserve the deadline and disabled AI settings cannot change it", async () => {
  await request("timeout-a", { ai_embedding_timeout_seconds: "300" });
  await request("timeout-a", { ai_model: "chat-only-update" });
  assert.equal((await request("timeout-a")).body.ai_embedding_timeout_seconds, "300");
  setUserAISettings("timeout-a", [{ key: "ai_manual_enabled", value: "false" }]);
  await request("timeout-a", { ai_embedding_timeout_seconds: "600" });
  assert.equal((await request("timeout-a")).body.ai_embedding_timeout_seconds, "300");
});

test("unauthenticated updates cannot change a user's index deadline", async () => {
  const response = await app.request("/ai/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ai_embedding_timeout_seconds: "600" }),
  });
  assert.equal(response.status, 401);
  assert.equal((await request("timeout-a")).body.ai_embedding_timeout_seconds, "300");
});
