import assert from "node:assert/strict";
import test from "node:test";
import { callAIChat, callAIChatStream, type AISettings } from "../src/services/ai-client";

const settings: AISettings = {
  ai_provider: "anthropic", ai_api_url: "https://gateway.example/anthropic/v1/",
  ai_api_key: "test-api-key", ai_model: "claude-test",
  ai_custom_headers: JSON.stringify({ "x-session": "gateway-secret" }),
  ai_embedding_profile_id: "", ai_embedding_url: "", ai_embedding_key: "", ai_embedding_model: "",
};

test("Anthropic sends Messages with system prompt and gateway headers and reads text blocks", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://gateway.example/anthropic/v1/messages");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), "test-api-key");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.equal(headers.get("x-session"), "gateway-secret");
    assert.equal(headers.has("authorization"), false);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.system, "Be concise");
    assert.deepEqual(body.messages, [{ role: "user", content: "Hi" }]);
    assert.ok(body.max_tokens > 0);
    return Response.json({ content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Hello" }] });
  }) as typeof fetch;
  try {
    assert.equal(await callAIChat(settings, [{ role: "system", content: "Be concise" }, { role: "user", content: "Hi" }]), "Hello");
  } finally { globalThis.fetch = original; }
});

test("Anthropic stream handles split frames, CRLF, thinking and completion", async () => {
  const original = globalThis.fetch;
  const frames = [
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hidden"}}\r\n\r\n',
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\r\n\r\n',
    'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
  ].join("");
  const bytes = new TextEncoder().encode(frames);
  globalThis.fetch = (async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    } }));
  }) as typeof fetch;
  try {
    let text = "";
    for await (const delta of callAIChatStream(settings, [{ role: "user", content: "Hi" }])) text += delta;
    assert.equal(text, "你好");
  } finally { globalThis.fetch = original; }
});

test("gateway headers can override default auth case-insensitively without changing OpenAI bodies", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://gateway.example/anthropic/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Session custom-token");
    assert.deepEqual(JSON.parse(String(init?.body)).messages, [{ role: "user", content: "Hi" }]);
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  }) as typeof fetch;
  try {
    assert.equal(await callAIChat({ ...settings, ai_provider: "custom", ai_custom_headers: '{"authorization":"Session custom-token"}' }, [{ role: "user", content: "Hi" }]), "OK");
  } finally { globalThis.fetch = original; }
});

test("stream cancellation reaches the upstream fetch and releases the reader", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let upstreamSignal: AbortSignal | null | undefined;
  let cancelled = false;
  globalThis.fetch = (async (_url, init) => {
    upstreamSignal = init?.signal;
    return new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"First"}}\n\n')); },
      cancel() { cancelled = true; },
    }));
  }) as typeof fetch;
  try {
    for await (const delta of callAIChatStream(settings, [{ role: "user", content: "Hi" }], { signal: controller.signal })) {
      assert.equal(delta, "First");
      controller.abort();
      break;
    }
    assert.equal(upstreamSignal?.aborted, true);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});

test("OpenAI-compatible streaming still reads deltas and an unterminated final frame", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"content":" world"}}]}',
  )) as typeof fetch;
  try {
    let result = "";
    for await (const delta of callAIChatStream({ ...settings, ai_provider: "gemini" }, [{ role: "user", content: "Hi" }])) result += delta;
    assert.equal(result, "Hello world");
  } finally { globalThis.fetch = original; }
});

test("upstream HTTP and stream errors never echo gateway credentials", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("invalid gateway-secret test-api-key", { status: 401 })) as typeof fetch;
    await assert.rejects(callAIChat(settings, [{ role: "user", content: "Hi" }]), (error: Error) =>
      /401/.test(error.message) && !/gateway-secret|test-api-key/.test(error.message));
    globalThis.fetch = (async () => new Response("not-json gateway-secret")) as typeof fetch;
    await assert.rejects(callAIChat(settings, [{ role: "user", content: "Hi" }]), (error: Error) =>
      /JSON/.test(error.message) && !error.message.includes("gateway-secret"));
    globalThis.fetch = (async () => new Response('event: error\ndata: {"type":"error","error":{"message":"invalid gateway-secret"}}\n\n')) as typeof fetch;
    await assert.rejects(async () => {
      for await (const _delta of callAIChatStream(settings, [{ role: "user", content: "Hi" }])) { /* consume */ }
    }, (error: Error) => !error.message.includes("gateway-secret"));
  } finally { globalThis.fetch = original; }
});
