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
  const [routes, profileRoutes, schema] = await Promise.all([
    import("../src/routes/ai"),
    import("../src/routes/user-preferences-legacy"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/ai", routes.default);
  app.route("/user-preferences", profileRoutes.default);
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
    for (const route of ["/ai/chat", "/ai/test"]) {
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
