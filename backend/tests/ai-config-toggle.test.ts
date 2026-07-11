import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ai-config-toggle-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
const USER_ID = "ai-toggle-user";

function setSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')
  `).run(key, value);
}

function getSetting(key: string): string {
  return (getDb().prepare("SELECT value FROM system_settings WHERE key = ?").get(key) as { value?: string } | undefined)?.value || "";
}

async function jsonRequest(method: string, route: string, body?: unknown) {
  const response = await app.request(route, {
    method,
    headers: {
      "X-User-Id": USER_ID,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json() as any };
}

test.before(async () => {
  const [routes, schema] = await Promise.all([
    import("../src/routes/user-preferences"),
    import("../src/db/schema"),
  ]);
  getDb = schema.getDb;
  closeDb = schema.closeDb;
  app = new Hono();
  app.route("/user-preferences", routes.default);

  getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");

  const now = new Date().toISOString();
  setSetting("ai_profiles_v1", JSON.stringify([
    {
      id: "profile-one",
      name: "One",
      provider: "openai",
      apiUrl: "https://one.example/v1",
      apiKey: "sk-one-secret",
      model: "model-one",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "profile-two",
      name: "Two",
      provider: "deepseek",
      apiUrl: "https://two.example/v1",
      apiKey: "sk-two-secret",
      model: "model-two",
      createdAt: now,
      updatedAt: now,
    },
  ]));
  setSetting("ai_active_profile_id", "profile-one");
  setSetting("ai_provider", "openai");
  setSetting("ai_api_url", "https://one.example/v1");
  setSetting("ai_api_key", "sk-one-secret");
  setSetting("ai_model", "model-one");
  setSetting("ai_embedding_url", "https://embedding.example/v1");
  setSetting("ai_embedding_key", "embedding-secret");
  setSetting("ai_embedding_model", "embedding-model");
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("disabled AI configuration cannot be reactivated by profile switching", async () => {
  const disabled = await jsonRequest(
    "PUT",
    "/user-preferences/ai-reliable/config-enabled",
    { enabled: false },
  );
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.json.enabled, false);
  assert.equal(getSetting("ai_api_url"), "");
  assert.equal(getSetting("ai_api_key"), "");
  assert.equal(getSetting("ai_embedding_model"), "");

  const activated = await jsonRequest(
    "PUT",
    "/user-preferences/ai-profiles/profile-two/activate",
  );
  assert.equal(activated.response.status, 200);
  assert.equal(activated.json.activeProfileId, "profile-two");
  assert.equal(getSetting("ai_api_url"), "", "guard must ignore legacy sync while disabled");
  assert.equal(getSetting("ai_model"), "");

  const enabled = await jsonRequest(
    "PUT",
    "/user-preferences/ai-reliable/config-enabled",
    { enabled: true },
  );
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.json.enabled, true);
  assert.equal(getSetting("ai_provider"), "deepseek");
  assert.equal(getSetting("ai_api_url"), "https://two.example/v1");
  assert.equal(getSetting("ai_api_key"), "sk-two-secret");
  assert.equal(getSetting("ai_model"), "model-two");
  assert.equal(getSetting("ai_embedding_url"), "https://embedding.example/v1");
  assert.equal(getSetting("ai_embedding_key"), "embedding-secret");
  assert.equal(getSetting("ai_embedding_model"), "embedding-model");
});
