import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { spawnSync } from "node:child_process";
import { maskAIHeaders, normalizeAIHeaders } from "../src/services/ai-provider-config";

let app: Hono;
let schema: typeof import("../src/db/schema");
const USER = "gateway-settings-user";

async function request(method: string, url: string, body?: unknown) {
  return app.request(url, { method, headers: { "X-User-Id": USER, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function configure(provider = "anthropic") {
  const response = await request("POST", "/prefs/ai-profiles", {
    name: "Gateway", provider, apiUrl: "https://gateway.example/anthropic/v1", model: "test-model",
    customHeaders: { "x-session": "runtime-session-secret" },
  });
  assert.equal(response.status, 201);
  return (await response.json() as any).profile;
}

test.before(async () => {
  const [ai, prefs, db] = await Promise.all([import("../src/routes/ai"), import("../src/routes/user-preferences"), import("../src/db/schema")]);
  schema = db;
  schema.getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER, USER, "hash");
  app = new Hono();
  app.route("/ai", ai.default);
  app.route("/prefs", prefs.default);
});
test.beforeEach(() => schema.getDb().prepare("DELETE FROM user_ai_settings WHERE userId = ?").run(USER));
test.after(() => schema.closeDb());

test("legacy settings APIs mask credentials and preserve omitted headers on unrelated updates", async () => {
  await configure();
  const result = await (await request("GET", "/ai/settings")).json() as any;
  assert.equal(result.ai_custom_headers, '{"x-session":"****"}');
  const updated = await (await request("PUT", "/ai/settings", { ai_embedding_model: "bge-m3", ai_custom_headers: result.ai_custom_headers })).json() as any;
  assert.equal(updated.ai_custom_headers, result.ai_custom_headers);
  assert.equal((await request("PUT", "/ai/settings", { ai_custom_headers: '{"host":"wrong.example"}' })).status, 400);
  await request("PUT", "/ai/settings", { ai_embedding_model: "bge-m3" });
  const { getUserAISettings } = await import("../src/services/user-ai-settings");
  assert.equal(JSON.parse(getUserAISettings(USER).ai_custom_headers!)["x-session"], "runtime-session-secret");
});

test("saved gateway credentials can be reopened by a fresh backend process", async () => {
  await configure();
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const assert = require('node:assert/strict');
    const { getUserAISettings, getUserAISetting } = require('./src/services/user-ai-settings.ts');
    assert.equal(JSON.parse(getUserAISettings('${USER}').ai_custom_headers)['x-session'], 'runtime-session-secret');
    const profiles = JSON.parse(getUserAISetting('${USER}', 'ai_profiles_v1'));
    assert.equal(profiles.find(p => p.name === 'Gateway').customHeaders['x-session'], 'runtime-session-secret');
    require('./src/db/schema.ts').closeDb();
  `], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});

test("disabling AI, switching profiles and re-enabling restores the selected headers", async () => {
  await configure();
  await request("PUT", "/prefs/ai-reliable/config-enabled", { enabled: false });
  const next = await configure("custom");
  const { getUserAISettings } = await import("../src/services/user-ai-settings");
  assert.equal(getUserAISettings(USER).ai_custom_headers, "");
  await request("PUT", "/prefs/ai-reliable/config-enabled", { enabled: true });
  assert.equal(getUserAISettings(USER).ai_provider, next.provider);
  assert.equal(JSON.parse(getUserAISettings(USER).ai_custom_headers!)["x-session"], "runtime-session-secret");
});

test("editor short and streaming actions both use the selected header-only native provider", async () => {
  await configure();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), "https://gateway.example/anthropic/v1/messages");
    assert.equal(new Headers(init?.headers).get("x-session"), "runtime-session-secret");
    const body = JSON.parse(String(init?.body));
    assert.equal(typeof body.system, "string");
    assert.ok(!body.messages.some((message: any) => message.role === "system"));
    return body.stream
      ? new Response('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Stream result"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n')
      : Response.json({ content: [{ type: "text", text: "Title result" }] });
  }) as typeof fetch;
  try {
    assert.match(await (await request("POST", "/ai/chat", { action: "title", text: "source" })).text(), /Title result/);
    assert.match(await (await request("POST", "/ai/chat", { action: "rewrite", text: "source" })).text(), /Stream result/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("clip enhancement uses native Messages and parses structured text without OpenAI-only options", async () => {
  await configure();
  const original = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://gateway.example/anthropic/v1/messages");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format, undefined);
    assert.equal(body.max_tokens, 2000);
    assert.equal(new Headers(init?.headers).get("x-session"), "runtime-session-secret");
    return Response.json({ content: [{ type: "text", text: '{"summary":"A useful summary"}' }] });
  }) as typeof fetch;
  try {
    const result = await (await request("POST", "/ai/clip-enhance", { contentText: "Source content with enough text for clip enhancement.", tasks: { summary: true } })).json() as any;
    assert.equal(result.ok, true);
    assert.equal(result.enhanced.summary, "A useful summary");
  } finally { globalThis.fetch = original; }
});

test("embedding inherits gateway headers only from its selected profile or chat source", async () => {
  const profile = await configure("custom");
  const { setUserAISettings } = await import("../src/services/user-ai-settings");
  const { resolveEmbeddingConfig } = await import("../src/services/embedding-config");
  const { callEmbeddings } = await import("../src/services/embedding-client");
  const { resolveEmbeddingProbeConfig, discoverEmbeddingModels, testEmbeddingModel } = await import("../src/services/embedding-model-discovery");
  setUserAISettings(USER, [{ key: "ai_embedding_model", value: "bge-m3" }, { key: "ai_embedding_profile_id", value: profile.id }]);
  assert.equal(resolveEmbeddingConfig(USER).config!.customHeaders!["x-session"], "runtime-session-secret");
  assert.equal(resolveEmbeddingProbeConfig(USER, { source: "chat" }, false).customHeaders!["x-session"], "runtime-session-secret");
  assert.equal(resolveEmbeddingProbeConfig(USER, { source: "custom", url: "https://other.example/v1" }, false).customHeaders, undefined);
  const original = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    assert.equal(new Headers(init?.headers).get("x-session"), "runtime-session-secret");
    return String(url).endsWith("/models") ? Response.json({ data: [{ id: "bge-m3" }] }) : Response.json({ data: [{ embedding: [0.1, 0.2] }] });
  }) as typeof fetch;
  try {
    assert.deepEqual(await callEmbeddings(resolveEmbeddingConfig(USER).config!, ["test"]), [[0.1, 0.2]]);
    assert.equal((await discoverEmbeddingModels(USER, { source: "profile", profileId: profile.id })).models[0].id, "bge-m3");
    assert.equal((await testEmbeddingModel(USER, { source: "profile", profileId: profile.id })).dimension, 2);
  } finally { globalThis.fetch = original; }
  await configure();
  setUserAISettings(USER, [{ key: "ai_embedding_profile_id", value: "" }]);
  assert.equal(resolveEmbeddingConfig(USER).errorCode, "EMBEDDING_PROTOCOL_UNSUPPORTED");
  assert.throws(() => resolveEmbeddingProbeConfig(USER, { source: "chat" }, false), /独立/);
});

test("header limits and masking cannot disclose values or prototype properties", () => {
  assert.throws(() => normalizeAIHeaders({ "x-session": "a".repeat(16_384) }), /16 KB/);
  assert.throws(() => normalizeAIHeaders(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-${i}`, "v"]))), /32/);
  assert.throws(() => normalizeAIHeaders({ constructor: "****" }), /重新输入/);
  assert.deepEqual(maskAIHeaders({ "x-session": "do-not-return" }), { "x-session": "****" });
  assert.equal(Object.keys(normalizeAIHeaders('{"__proto__":"value"}'))[0], "__proto__");
});
