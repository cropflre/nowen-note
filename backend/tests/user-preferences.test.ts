import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-user-prefs-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

const USER_ID = "user-prefs";
const OTHER_ID = "other-prefs";

function db() {
  return getDb();
}

function seedUsers() {
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(OTHER_ID, OTHER_ID, "hash");
}

async function requestJson(method: string, url: string, body?: unknown, userId = USER_ID) {
  const res = await app.request(url, {
    method,
    headers: {
      "X-User-Id": userId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

function writeSetting(key: string, value: string) {
  db().prepare(`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')
  `).run(key, value);
}

function readSetting(key: string): string {
  const row = db().prepare("SELECT value FROM system_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value || "";
}

test.before(async () => {
  const [prefsModule, schemaModule] = await Promise.all([
    import("../src/routes/user-preferences"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/user-preferences", prefsModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  seedUsers();
});

test.beforeEach(() => {
  db().prepare("DELETE FROM user_preferences").run();
  db().prepare("DELETE FROM system_settings WHERE key LIKE 'ai_%'").run();
});

test.after(async () => {
  closeDb();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (err?.code !== "EBUSY") throw err;
      if (i === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("stores user preferences per user", async () => {
  const put = await requestJson("PUT", "/user-preferences", {
    noteTitleAsAppTitle: true,
    showNotesInNotebookTree: true,
    markdownDefaultViewMode: "split",
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.noteTitleAsAppTitle, true);
  assert.equal(put.json.showNotesInNotebookTree, true);
  assert.equal(put.json.markdownDefaultViewMode, "split");

  const get = await requestJson("GET", "/user-preferences");
  assert.equal(get.status, 200);
  assert.equal(get.json.noteTitleAsAppTitle, true);
  assert.equal(get.json.showNotesInNotebookTree, true);
  assert.equal(get.json.markdownDefaultViewMode, "split");
});

test("does not leak preferences across users", async () => {
  await requestJson("PUT", "/user-preferences", {
    noteTitleAsAppTitle: true,
    enableNoteTabs: true,
  }, USER_ID);

  const other = await requestJson("GET", "/user-preferences", undefined, OTHER_ID);
  assert.equal(other.status, 200);
  assert.equal(other.json.noteTitleAsAppTitle, false);
  assert.equal(other.json.enableNoteTabs, false);
});

test("migrates the legacy AI settings into one masked default profile", async () => {
  writeSetting("ai_provider", "deepseek");
  writeSetting("ai_api_url", "https://api.deepseek.com/v1");
  writeSetting("ai_api_key", "secret-key-1234");
  writeSetting("ai_model", "deepseek-chat");

  const result = await requestJson("GET", "/user-preferences/ai-profiles");

  assert.equal(result.status, 200);
  assert.equal(result.json.profiles.length, 1);
  assert.equal(result.json.profiles[0].provider, "deepseek");
  assert.equal(result.json.profiles[0].model, "deepseek-chat");
  assert.equal(result.json.profiles[0].apiKey, "****1234");
  assert.equal(result.json.profiles[0].apiKeySet, true);
  assert.equal(result.json.activeProfileId, result.json.profiles[0].id);
  assert.ok(readSetting("ai_profiles_v1"));
});

test("creates and activates a profile while keeping legacy AI callers compatible", async () => {
  const created = await requestJson("POST", "/user-preferences/ai-profiles", {
    name: "通义生产",
    provider: "qwen",
    apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/",
    apiKey: "dash-key-5678",
    model: "qwen-plus",
    activate: true,
  });

  assert.equal(created.status, 201);
  assert.equal(created.json.profile.apiKey, "****5678");
  assert.equal(created.json.activeProfileId, created.json.profile.id);
  assert.equal(readSetting("ai_provider"), "qwen");
  assert.equal(readSetting("ai_api_url"), "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(readSetting("ai_api_key"), "dash-key-5678");
  assert.equal(readSetting("ai_model"), "qwen-plus");
});

test("updating a profile with its masked key preserves the stored secret", async () => {
  const created = await requestJson("POST", "/user-preferences/ai-profiles", {
    name: "OpenAI",
    provider: "openai",
    apiUrl: "https://api.openai.com/v1",
    apiKey: "secret-openai-9999",
    model: "gpt-4o-mini",
  });
  const profileId = created.json.profile.id as string;

  const updated = await requestJson("PUT", `/user-preferences/ai-profiles/${profileId}`, {
    name: "OpenAI 主力",
    provider: "openai",
    apiUrl: "https://api.openai.com/v1",
    apiKey: "****9999",
    model: "gpt-4o",
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.json.profile.apiKey, "****9999");
  assert.equal(readSetting("ai_api_key"), "secret-openai-9999");
  assert.equal(readSetting("ai_model"), "gpt-4o");
});

test("discovers and normalizes OpenAI-compatible model lists", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedAuth = "";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedAuth = new Headers(init?.headers).get("authorization") || "";
    return new Response(JSON.stringify({
      data: [
        { id: "model-b" },
        { id: "model-a", display_name: "Model A" },
        { id: "model-b" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await requestJson("POST", "/user-preferences/ai-profiles/discover-models", {
      name: "Custom",
      provider: "custom",
      apiUrl: "https://example.test/v1",
      apiKey: "key-1",
      model: "",
    });

    assert.equal(result.status, 200);
    assert.equal(requestedUrl, "https://example.test/v1/models");
    assert.equal(requestedAuth, "Bearer key-1");
    assert.deepEqual(result.json.models, [
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "model-b" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discovers Ollama models through the native tags endpoint without an API key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.equal(String(input), "http://ollama.local:11434/api/tags");
    return new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await requestJson("POST", "/user-preferences/ai-profiles/discover-models", {
      name: "Ollama",
      provider: "ollama",
      apiUrl: "http://ollama.local:11434/v1",
      apiKey: "",
      model: "qwen2.5:7b",
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.models, [{ id: "qwen2.5:7b", name: "qwen2.5:7b" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
