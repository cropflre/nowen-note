import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ai-connection-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
const USER_ID = "ai-connection-user";
const OTHER_ID = "ai-connection-other";
const PROFILE_ID = "opaque-custom-profile";
const API_KEY = "test-key";
const REASONING = "private reasoning must never be displayed";

function setSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO user_ai_settings (userId, key, value, updatedAt)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(userId, key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt
  `).run(USER_ID, key, value);
}

test.before(async () => {
  const [routes, profileRoutes, sharedProfileRoutes, reliableAIRoutes, schema] = await Promise.all([
    import("../src/routes/ai"),
    import("../src/routes/user-preferences-legacy"),
    import("../src/routes/shared-ai-profiles"),
    import("../src/routes/ai-reliable"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/ai", routes.default);
  app.route("/ai", sharedProfileRoutes.default);
  app.route("/user-preferences", profileRoutes.default);
  app.route("/user-preferences/ai-reliable", reliableAIRoutes.default);
  getDb = schema.getDb;
  closeDb = schema.closeDb;

  getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(OTHER_ID, OTHER_ID, "hash");

  setSetting("ai_provider", "custom");
  setSetting("ai_api_url", "https://api.example.test/v1");
  setSetting("ai_api_key", API_KEY);
  setSetting("ai_model", "opaque-gateway-model");
  setSetting("ai_profiles_v1", JSON.stringify([{
    id: PROFILE_ID, name: "Opaque custom model", provider: "custom",
    apiUrl: "https://api.example.test/v1", apiKey: API_KEY,
    model: "opaque-gateway-model", customHeaders: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }]));
  setSetting("ai_active_profile_id", PROFILE_ID);
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

test("connection test succeeds when a reasoning-only response has no display text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { reasoning_content: "internal reasoning", content: "" } }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

  try {
    const response = await app.request("/ai/test", {
      method: "POST",
      headers: { "X-User-Id": USER_ID },
    });
    const body = await response.json() as { success: boolean; message?: string; preview?: string };

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.message, "连接成功（模型未在本次测试中返回可展示文本）");
    assert.equal(body.preview, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("anonymous chat and connection probes are rejected without contacting the provider", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: "unexpected" } }] });
  }) as typeof fetch;
  try {
    for (const route of ["/ai/chat", "/ai/test", "/ai/test?chatOnly=1"]) {
      const response = await app.request(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "title", text: "用户笔记" }),
      });
      assert.equal(response.status, 401);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a model-list response cannot satisfy a chat-only Ollama probe", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  setSetting("ai_provider", "ollama");
  globalThis.fetch = (async (url) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    return path === "/api/tags" ? Response.json({ models: [] }) : new Response("Method Not Allowed", { status: 405 });
  }) as typeof fetch;
  const init = { method: "POST", headers: { "X-User-Id": USER_ID } };
  try {
    const strict = await app.request("/ai/test?chatOnly=1", init);
    assert.equal(strict.status, 500);
    assert.equal((await strict.json()).success, false);
    assert.deepEqual(paths, ["/v1/chat/completions"]);

    const legacy = await app.request("/ai/test", init);
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).success, true);
    assert.deepEqual(paths.slice(1), ["/v1/chat/completions", "/api/tags"]);
  } finally {
    globalThis.fetch = originalFetch;
    setSetting("ai_provider", "custom");
  }
});

test("manual disable refuses the chat-only probe before contacting the provider", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  setSetting("ai_manual_enabled", "false");
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: "unexpected" } }] });
  }) as typeof fetch;
  try {
    const response = await app.request("/ai/test?chatOnly=1", { method: "POST", headers: { "X-User-Id": USER_ID } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "AI_CONFIG_DISABLED");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    setSetting("ai_manual_enabled", "true");
  }
});

test("DCC-006: availability and settings preserve an inactive user's legacy provider across re-enabling AI", async () => {
  const url = "https://legacy.example.test/v1";
  const legacyKey = "legacy-connection-secret";
  const request = (path: string, method = "GET", body?: object) => app.request(path, {
    method, headers: { "X-User-Id": OTHER_ID, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  assert.equal((await request("/ai/settings", "PUT", {
    ai_provider: "custom", ai_api_url: url, ai_api_key: legacyKey, ai_model: "legacy-chat",
  })).status, 200);
  assert.equal((await request("/user-preferences/ai-reliable/config-enabled", "PUT", { enabled: false })).status, 200);

  const anonymous = await app.request("/ai/profiles/available?activeOnly=1");
  assert.equal(anonymous.status, 401);
  const before = getDb().prepare("SELECT key, value FROM user_ai_settings WHERE userId = ? ORDER BY key").all(OTHER_ID);
  const availability = await request("/ai/profiles/available?activeOnly=1");
  assert.equal(availability.status, 200);
  assert.equal((await availability.json()).aiEnabled, false);
  assert.deepEqual(getDb().prepare("SELECT key, value FROM user_ai_settings WHERE userId = ? ORDER BY key").all(OTHER_ID), before);

  const profileSettings = await request("/ai/profiles/available");
  assert.equal(profileSettings.status, 200);
  const directory = await profileSettings.json();
  assert.equal(directory.personalProfiles[0].model, "legacy-chat");
  assert.equal(directory.personalProfiles[0].apiKeySet, true);
  assert.ok(!JSON.stringify(directory).includes(legacyKey));
  assert.equal((await request("/user-preferences/ai-reliable/config-enabled", "PUT", { enabled: true })).status, 200);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (endpoint, init) => {
    assert.equal(String(endpoint), `${url}/chat/completions`);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${legacyKey}`);
    assert.equal(JSON.parse(String(init?.body)).model, "legacy-chat");
    return Response.json({ choices: [{ message: { content: "hello" } }] });
  }) as typeof fetch;
  try {
    const connected = await request("/ai/test?chatOnly=1", "POST");
    assert.equal(connected.status, 200);
    assert.equal((await connected.json()).success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const action of ["title", "tags", "summarize", "mermaid_mindmap", "mermaid_flowchart"]) {
  test(`${action} reserves output budget for reasoning even with an opaque custom model`, async () => {
    const originalFetch = globalThis.fetch;
    const requests: Record<string, unknown>[] = [];
    const answer = action === "tags" ? "笔记,计划,工作" : "可展示的最终结果";
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const enoughBudget = body.max_tokens >= 4096;
      return Response.json({ choices: [{
        finish_reason: enoughBudget ? "stop" : "length",
        message: { reasoning_content: REASONING, content: enoughBudget ? answer : "" },
      }] });
    }) as typeof fetch;
    try {
      const response = await app.request("/ai/chat", {
        method: "POST",
        headers: { "X-User-Id": USER_ID, "Content-Type": "application/json" },
        body: JSON.stringify({ action, text: "用户笔记" }),
      });
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.match(body, new RegExp(answer));
      assert.ok(body.includes("[DONE]"));
      assert.ok(!body.includes(REASONING));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].max_tokens, 4096);
      assert.equal(requests[0].stream, false);
      assert.equal(requests[0].model, "opaque-gateway-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("legacy connection probe reserves reasoning budget and returns only visible text", async () => {
  const originalFetch = globalThis.fetch;
  let budget: number | undefined;
  globalThis.fetch = (async (_url, init) => {
    budget = JSON.parse(String(init?.body)).max_tokens;
    return Response.json({ choices: [{
      finish_reason: budget! >= 4096 ? "stop" : "length",
      message: { reasoning_content: REASONING, content: budget! >= 4096 ? "你好" : "" },
    }] });
  }) as typeof fetch;
  try {
    const response = await app.request("/ai/test", {
      method: "POST", headers: { "X-User-Id": USER_ID },
    });
    const body = await response.json() as { success: boolean; preview?: string };
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.preview, "你好");
    assert.equal(budget, 4096);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const route of ["/ai/chat", "/ai/test"]) {
  test(`${route} reports exhausted reasoning budget without exposing provider content`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ choices: [{
      finish_reason: "length",
      message: { reasoning_content: `${REASONING} ${API_KEY}`, content: "" },
    }] })) as typeof fetch;
    try {
      const response = await app.request(route, {
        method: "POST",
        headers: { "X-User-Id": USER_ID, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "title", text: "用户笔记" }),
      });
      const body = await response.json() as { error?: string; success?: boolean };
      assert.equal(response.status, 500);
      assert.match(body.error || "", /token|预算|推理/i);
      assert.ok(!JSON.stringify(body).includes(REASONING));
      assert.ok(!JSON.stringify(body).includes(API_KEY));
      assert.notEqual(body.success, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

for (const suffix of [`${PROFILE_ID}/test`, "test-draft"]) {
  test(`personal profile ${suffix} probe reserves reasoning budget without activating a profile`, async () => {
    const originalFetch = globalThis.fetch;
    const before = getDb().prepare("SELECT key, value FROM user_ai_settings WHERE userId = ? ORDER BY key").all(USER_ID);
    let budget: number | undefined;
    globalThis.fetch = (async (_url, init) => {
      budget = JSON.parse(String(init?.body)).max_tokens;
      return Response.json({ choices: [{
        finish_reason: budget! >= 4096 ? "stop" : "length",
        message: { reasoning_content: REASONING, content: budget! >= 4096 ? "你好" : "" },
      }] });
    }) as typeof fetch;
    try {
      const response = await app.request(`/user-preferences/ai-profiles/${suffix}`, {
        method: "POST",
        headers: { "X-User-Id": USER_ID, "Content-Type": "application/json" },
        body: JSON.stringify(suffix === "test-draft" ? { profileId: PROFILE_ID, model: "unsaved-opaque-model" } : {}),
      });
      const body = await response.json() as { success: boolean; preview?: string };
      assert.equal(response.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.preview, "你好");
      assert.equal(budget, 4096);
      assert.deepEqual(getDb().prepare("SELECT key, value FROM user_ai_settings WHERE userId = ? ORDER BY key").all(USER_ID), before);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test(`personal profile ${suffix} probe reports exhausted reasoning budget`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ choices: [{
      finish_reason: "length",
      message: { reasoning_content: `${REASONING} ${API_KEY}`, content: "" },
    }] })) as typeof fetch;
    try {
      const response = await app.request(`/user-preferences/ai-profiles/${suffix}`, {
        method: "POST",
        headers: { "X-User-Id": USER_ID, "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: PROFILE_ID }),
      });
      const body = await response.json() as { success: boolean; code?: string; error?: string };
      assert.equal(response.status, 502);
      assert.equal(body.success, false);
      assert.equal(body.code, "AI_UPSTREAM_ERROR");
      assert.match(body.error || "", /token|预算|推理/i);
      assert.ok(!JSON.stringify(body).includes(REASONING));
      assert.ok(!JSON.stringify(body).includes(API_KEY));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("foreign personal profile probes are rejected without contacting the provider", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: "unexpected" } }] });
  }) as typeof fetch;
  try {
    for (const suffix of [`${PROFILE_ID}/test`, "test-draft"]) {
      const response = await app.request(`/user-preferences/ai-profiles/${suffix}`, {
        method: "POST",
        headers: { "X-User-Id": OTHER_ID, "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: PROFILE_ID }),
      });
      assert.equal(response.status, 404);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
