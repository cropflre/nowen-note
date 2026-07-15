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
const OTHER_ID = "ai-toggle-other";
const DEFAULTS_ID = "ai-toggle-defaults";

function setSetting(key: string, value: string, userId = USER_ID): void {
  getDb().prepare(`
    INSERT INTO user_ai_settings (userId, key, value, updatedAt)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(userId, key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')
  `).run(userId, key, value);
}

function getSetting(key: string, userId = USER_ID): string {
  return (getDb().prepare("SELECT value FROM user_ai_settings WHERE userId = ? AND key = ?").get(userId, key) as { value?: string } | undefined)?.value || "";
}

async function jsonRequest(method: string, route: string, body?: unknown, userId = USER_ID) {
  const response = await app.request(route, {
    method,
    headers: {
      "X-User-Id": userId,
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
  getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(OTHER_ID, OTHER_ID, "hash");
  getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(DEFAULTS_ID, DEFAULTS_ID, "hash");

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
  setSetting("ai_api_key", "other-secret", OTHER_ID);
  setSetting("ai_model", "other-model", OTHER_ID);
});

test.after(async () => {
  closeDb();
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
  assert.equal(getSetting("ai_api_key", OTHER_ID), "other-secret");
  assert.equal(getSetting("ai_model", OTHER_ID), "other-model");

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

test("disabling and enabling preserves effective default settings", async () => {
  setSetting("ai_api_key", "defaults-secret", DEFAULTS_ID);

  const before = await jsonRequest("GET", "/user-preferences/ai-reliable/status", undefined, DEFAULTS_ID);
  assert.equal(before.json.provider, "openai");
  assert.equal(before.json.model, "gpt-4o-mini");
  assert.equal(before.json.apiHost, "api.openai.com");

  await jsonRequest("PUT", "/user-preferences/ai-reliable/config-enabled", { enabled: false }, DEFAULTS_ID);
  await jsonRequest("PUT", "/user-preferences/ai-reliable/config-enabled", { enabled: true }, DEFAULTS_ID);
  const after = await jsonRequest("GET", "/user-preferences/ai-reliable/status", undefined, DEFAULTS_ID);

  assert.equal(after.json.provider, "openai");
  assert.equal(after.json.model, "gpt-4o-mini");
  assert.equal(after.json.apiHost, "api.openai.com");
  assert.equal(getSetting("ai_api_key", DEFAULTS_ID), "defaults-secret");
});
