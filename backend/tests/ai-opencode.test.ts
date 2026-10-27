import assert from "node:assert/strict";
import test from "node:test";
import { callAIChat, callAIChatStream, type AISettings } from "../src/services/ai-client";

const settings: AISettings = {
  ai_provider: "custom", ai_api_url: "https://opencode.ai/zen/go/v1",
  ai_api_key: "test-key", ai_model: "test-model",
  ai_embedding_profile_id: "", ai_embedding_url: "", ai_embedding_key: "", ai_embedding_model: "",
};
const missingSession = { type: "error", error: {
  type: "MissingSessionID",
  message: "Request is missing x-opencode-session and cannot be routed efficiently.",
} };

test("OpenCode missing-session error explains the required configuration for chat and streaming", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(missingSession, { status: 400 })) as typeof fetch;
  const check = (error: Error) => {
    assert.match(error.message, /400/);
    assert.match(error.message, /高级：自定义请求头/);
    assert.match(error.message, /x-opencode-session/);
    assert.match(error.message, /User-Agent/);
    assert.match(error.message, /每个对话/);
    return true;
  };
  try {
    await assert.rejects(callAIChat(settings, [{ role: "user", content: "Hi" }]), check);
    await assert.rejects(async () => {
      for await (const _delta of callAIChatStream(settings, [{ role: "user", content: "Hi" }])) { /* consume */ }
    }, check);
  } finally { globalThis.fetch = original; }
});

test("configured OpenCode headers reach both chat and streaming requests unchanged", async () => {
  const original = globalThis.fetch;
  const configured = { ...settings, ai_custom_headers: JSON.stringify({
    "X-OpenCode-Session": "nowen-conversation-123", "User-Agent": "Nowen-Note/1.5.4",
  }) };
  let requests = 0;
  globalThis.fetch = (async (_url, init) => {
    requests++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-opencode-session"), "nowen-conversation-123");
    assert.equal(headers.get("user-agent"), "Nowen-Note/1.5.4");
    assert.equal(headers.get("authorization"), "Bearer test-key");
    return JSON.parse(String(init?.body)).stream
      ? new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')
      : Response.json({ choices: [{ message: { content: "OK" } }] });
  }) as typeof fetch;
  try {
    assert.equal(await callAIChat(configured, [{ role: "user", content: "Hi" }]), "OK");
    let result = "";
    for await (const delta of callAIChatStream(configured, [{ role: "user", content: "Hi again" }])) result += delta;
    assert.equal(result, "OK");
    assert.equal(requests, 2);
  } finally { globalThis.fetch = original; }
});

test("other upstream 400 errors retain their diagnostic details", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ error: { type: "InvalidModel", message: "model unavailable" } }, { status: 400 })) as typeof fetch;
  try {
    await assert.rejects(callAIChat(settings, [{ role: "user", content: "Hi" }]), /InvalidModel.*model unavailable/);
  } finally { globalThis.fetch = original; }
});
