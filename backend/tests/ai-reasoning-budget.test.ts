import assert from "node:assert/strict";
import test from "node:test";
import { callAIChat, type AISettings } from "../src/services/ai-client";

const settings: AISettings = {
  ai_provider: "custom", ai_api_url: "https://gateway.example/v1",
  ai_api_key: "private-api-key", ai_model: "opaque-model-id",
  ai_custom_headers: '{"x-session":"private-session"}',
  ai_embedding_profile_id: "", ai_embedding_url: "", ai_embedding_key: "", ai_embedding_model: "",
};

test("empty answers exhausted by reasoning fail clearly without exposing upstream content or retrying", async () => {
  const original = globalThis.fetch;
  const reasoning = "private reasoning private-api-key private-session";
  const responses = [
    { choices: [{ finish_reason: "length", message: { content: "", reasoning_content: reasoning } }] },
    { choices: [{ finish_reason: "length", message: { content: null, reasoning_content: reasoning } }] },
    { choices: [{ finish_reason: "length", message: { content: `<think>${reasoning}</think>` } }] },
    { stop_reason: "max_tokens", content: [{ type: "thinking", thinking: reasoning }] },
  ];
  try {
    for (const response of responses) {
      let requests = 0;
      globalThis.fetch = (async () => {
        requests++;
        return Response.json(response);
      }) as typeof fetch;
      await assert.rejects(callAIChat(settings, [{ role: "user", content: "private note content" }]), (error: Error) => {
        assert.match(error.message, /token.*上限/);
        assert.match(error.message, /推理/);
        assert.doesNotMatch(error.message, /private/);
        return true;
      });
      assert.equal(requests, 1);
    }
  } finally { globalThis.fetch = original; }
});

test("length-limited answers with visible text remain usable and exclude reasoning", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    choices: [{ finish_reason: "length", message: { content: "周末计划", reasoning_content: "private reasoning" } }],
  })) as typeof fetch;
  try {
    assert.equal(await callAIChat(settings, [{ role: "user", content: "Generate a title" }]), "周末计划");
  } finally { globalThis.fetch = original; }
});

test("an empty response without token exhaustion keeps its existing behavior", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: "private reasoning" } }],
  })) as typeof fetch;
  try {
    assert.equal(await callAIChat(settings, [{ role: "user", content: "Hi" }]), "");
  } finally { globalThis.fetch = original; }
});
