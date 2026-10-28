import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-remote-shared-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
let db: ReturnType<typeof import("../src/db/schema").getDb>;
let schema: typeof import("../src/db/schema");
let remote: typeof import("../src/services/remote-shared-ai");
let profiles: typeof import("../src/sync/profile");
let credentials: typeof import("../src/sync/credentials");
let userSettings: typeof import("../src/services/user-ai-settings");
let shared: typeof import("../src/services/shared-ai-profiles");
let client: typeof import("../src/services/ai-client");
let invoke: typeof import("../src/services/shared-ai-invocation").createSharedAIInvocationResponse;
let active: ReturnType<typeof import("../src/sync/profile").createProfile>;
const originalFetch = globalThis.fetch;
const directoryReply = () => new Response(JSON.stringify({ capabilities: { sharedProfiles: 1 }, sharedProfiles: [
  { id: "remote-model", name: "Team", provider: "openai", model: "model-v1", apiKey: "must-not-copy", customHeaders: { secret: "must-not-copy" } },
] }), { headers: { "Content-Type": "application/json" } });

test.before(async () => {
  schema = await import("../src/db/schema"); db = schema.getDb();
  for (const id of ["local-user", "other-local"]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,?)").run(id, id, "hash");
  remote = await import("../src/services/remote-shared-ai");
  profiles = await import("../src/sync/profile");
  credentials = await import("../src/sync/credentials");
  userSettings = await import("../src/services/user-ai-settings");
  shared = await import("../src/services/shared-ai-profiles");
  client = await import("../src/services/ai-client");
  invoke = (await import("../src/services/shared-ai-invocation")).createSharedAIInvocationResponse;
  active = profiles.createProfile(db, { name: "Server", serverUrl: "https://team.example", remoteUserId: "remote-user" });
});
test.beforeEach(() => {
  delete process.env.NOWEN_LOCAL_FIRST_SYNC_V2;
  profiles.setProfileRemoteUser(db, active.id, "remote-user");
  profiles.switchActiveProfile(db, active.id);
  credentials.saveRemoteCredential({ profileId: active.id, serverUrl: active.serverUrl, remoteUserId: "remote-user", token: "device-login-token" });
  userSettings.setUserAISettings("local-user", [{ key: "ai_active_shared_profile_id", value: "" }, { key: "ai_manual_enabled", value: "true" }]);
  globalThis.fetch = async () => directoryReply();
});
test.afterEach(() => { globalThis.fetch = originalFetch; });
test.after(() => { schema.closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });

async function select() {
  const result = await remote.listRemoteSharedProfiles("local-user");
  assert.equal(result.profiles.length, 1);
  assert.equal(await remote.activateRemoteSharedProfile("local-user", result.profiles[0].id), true);
  return result.profiles[0].id;
}

test("DCC-006: Full uses the bound remote account and stores only public shared metadata", async () => {
  const requests: any[] = [];
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return directoryReply(); };
  const id = await select();
  assert.equal(requests[0].url, "https://team.example/api/ai/profiles/available");
  assert.equal(requests[0].init.headers.Authorization, "Bearer device-login-token");
  assert.equal(requests[0].init.headers["X-Nowen-Shared-Directory"], "local");
  const stored = userSettings.getUserAISetting("local-user", "ai_active_shared_profile_id");
  assert.ok(!stored.includes("must-not-copy") && !stored.includes("device-login-token"));
  assert.equal(remote.getRemoteSharedSelectionId(stored), id);
  const resolved = remote.resolveRemoteSharedChatSettings("local-user")!;
  assert.equal(resolved.ai_api_key, "");
  assert.equal(resolved.ai_custom_headers, "{}");
  assert.equal((await remote.listRemoteSharedProfiles("other-local")).profiles.length, 0);
  assert.equal(requests.length, 2);
});

test("model channel preserves long text, streaming and local Agent tool requests without secrets", async () => {
  await select();
  const settings = remote.resolveRemoteSharedChatSettings("local-user")!;
  const content = "Complete response ".repeat(100);
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://team.example/api/ai/shared-profiles/remote-model/invoke");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messages[0].content, "local context");
    assert.ok(!("model" in body) && !("apiUrl" in body));
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  };
  assert.equal(await client.callAIChat(settings, [{ role: "user", content: "local context" }]), content.trim());
  globalThis.fetch = async () => new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"stream text"}}\n\ndata: {"type":"message_stop"}\n\n', {
    headers: { "Content-Type": "text/event-stream", "X-Nowen-AI-Provider": "anthropic" },
  });
  let streamed = "";
  for await (const chunk of client.callAIChatStream(settings, [{ role: "user", content: "local context" }])) streamed += chunk;
  assert.equal(streamed, "stream text");
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools[0].function.name, "get_current_note_context");
    assert.equal(body.tool_choice, "required");
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "t1", type: "function", function: { name: "get_current_note_context", arguments: "{}" } }] } }] }));
  };
  const result = await (await import("../src/agent/model")).callAgentModel(settings, [{ role: "user", content: "local context" }], [{ type: "function", function: { name: "get_current_note_context", description: "Local only", parameters: {} } }], new AbortController().signal);
  assert.equal(result.calls[0].function.name, "get_current_note_context");
});

test("DCC-009: stopping sync or disabling AI prevents remote model access without changing local data", async () => {
  await select();
  const settings = remote.resolveRemoteSharedChatSettings("local-user")!;
  let calls = 0; globalThis.fetch = async () => { calls++; return directoryReply(); };
  profiles.disableAllProfiles(db);
  await assert.rejects(() => client.callAIChat(settings, [{ role: "user", content: "keep local" }]), /原服务器账号/);
  profiles.switchActiveProfile(db, active.id);
  userSettings.setUserAISetting("local-user", "ai_manual_enabled", "false");
  await assert.rejects(() => client.callAIChat(settings, [{ role: "user", content: "keep local" }]), /AI 已关闭/);
  assert.equal(calls, 0);
  assert.ok(userSettings.getUserAISetting("local-user", "ai_active_shared_profile_id").includes("remote-model"));
});

test("DCC-006: server/account changes discard late directory responses and reject old model handles", async () => {
  const id = await select();
  const settings = remote.resolveRemoteSharedChatSettings("local-user")!;
  globalThis.fetch = async () => {
    profiles.setProfileRemoteUser(db, active.id, "another-remote-user");
    return directoryReply();
  };
  await assert.rejects(() => remote.activateRemoteSharedProfile("local-user", id), /原服务器账号/);
  assert.throws(() => remote.resolveRemoteSharedChatSettings("local-user"), /原服务器账号/);
  await assert.rejects(() => client.callAIChat(settings, [{ role: "user", content: "old account text" }]), /原服务器账号/);
});

test("saved-model invocation rejects endpoint overrides and redacts split SSE credentials", async () => {
  const profile = shared.saveSharedAIProfile("local-user", { name: "Server shared", provider: "openai", apiUrl: "https://upstream.example/v1", apiKey: "upstream-secret", customHeaders: { "x-secret": 'quote"secret' }, model: "chat-model", memberIds: ["other-local"] });
  await assert.rejects(() => invoke("other-local", profile.id, { messages: [{ role: "user", content: "Hi" }], apiUrl: "https://attacker.example" }), /参数无效/);
  const content = "Preserved ".repeat(100);
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://upstream.example/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer upstream-secret");
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  };
  assert.equal((await (await invoke("other-local", profile.id, { messages: [{ role: "user", content: "Hi" }] })).json()).choices[0].message.content, content);
  const event = 'data: ' + JSON.stringify({ error: { message: 'upstream-secret quote"secret' } }) + '\n\n';
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(event.slice(0, 35)));
    controller.enqueue(new TextEncoder().encode(event.slice(35))); controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
  const text = await (await invoke("other-local", profile.id, { messages: [{ role: "user", content: "Hi" }], stream: true })).text();
  assert.ok(!text.includes("upstream-secret") && !text.includes("quote"));
  assert.ok(text.startsWith("data: "));
  const stale = shared.resolveSharedProfileSettings("other-local", profile.id);
  stale.shared_ai_user_id = "other-local";
  userSettings.setUserAISetting("other-local", "ai_active_shared_profile_id", profile.id);
  db.prepare("DELETE FROM shared_ai_profile_grants WHERE profileId=?").run(profile.id);
  await assert.rejects(() => client.callAIChat(stale, [{ role: "user", content: "must not send" }]), /不可用/);
});

test("member invocation HTTP route permits granted sessions and refuses PATs, foreign users and overrides", async () => {
  const app = new Hono(); app.route("/ai", (await import("../src/routes/shared-ai-profiles")).default);
  const profile = shared.saveSharedAIProfile("local-user", { name: "HTTP shared", provider: "openai", apiUrl: "https://upstream.example/v1", apiKey: "server-key", model: "chat-model", memberIds: ["other-local"] });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: "Allowed" } }] })); };
  const post = (userId: string, body: unknown, authMode = "jwt") => app.request(`/ai/shared-profiles/${profile.id}/invoke`, { method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": userId, "X-Auth-Mode": authMode }, body: JSON.stringify(body) });
  const body = { messages: [{ role: "user", content: "Hi" }] };
  assert.equal((await post("other-local", body)).status, 200);
  assert.equal((await post("other-local", body, "api-token")).status, 403);
  assert.equal((await post("local-user", body)).status, 403);
  assert.equal((await post("other-local", { ...body, model: "forged" })).status, 400);
  assert.equal(calls, 1);
});

test("stale shared handles parse the newly selected provider and redact its rotated credentials", async () => {
  const profile = shared.saveSharedAIProfile("local-user", { name: "Rotated", provider: "openai", apiUrl: "https://upstream.example/v1", apiKey: "old-secret", model: "chat-model", memberIds: ["other-local"] });
  shared.activateSharedAIProfile("other-local", profile.id);
  const snapshot = shared.resolveSharedChatSettings("other-local")!;
  snapshot.shared_ai_user_id = "other-local";
  shared.saveSharedAIProfile("local-user", { revision: 1, provider: "anthropic", apiKey: "fresh-rotated-secret" }, profile.id);
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://upstream.example/v1/messages");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "fresh-rotated-secret");
    return new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"new protocol"}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  };
  let text = "";
  for await (const delta of client.callAIChatStream(snapshot, [{ role: "user", content: "Hi" }])) text += delta;
  assert.equal(text, "new protocol");
  assert.equal(snapshot.ai_provider, "openai", "a shared settings handle remains immutable across concurrent calls");
  globalThis.fetch = async () => new Response('data: {"type":"error","error":{"message":"fresh-rotated-secret"}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  await assert.rejects(async () => { for await (const _delta of client.callAIChatStream(snapshot, [{ role: "user", content: "Hi" }])) {} }, error => !String(error).includes("fresh-rotated-secret"));
});

test("direct shared raw JSON and SSE hide credential echoes in values, keys and tool arguments", async () => {
  const profile = shared.saveSharedAIProfile("local-user", { name: "Direct echoes", provider: "openai", apiUrl: "https://upstream.example/v1", apiKey: "echoed-upstream-key", customHeaders: { "x-secret": 'quote"secret' }, model: "chat-model", memberIds: ["other-local"] });
  shared.activateSharedAIProfile("other-local", profile.id);
  const snapshot = { ...shared.resolveSharedChatSettings("other-local")!, shared_ai_user_id: "other-local" };
  const argumentsText = JSON.stringify({ text: 'quote"secret' });
  globalThis.fetch = async () => new Response(JSON.stringify({ "echoed-upstream-key": true, choices: [{ message: { content: "echoed-upstream-key", tool_calls: [{ function: { arguments: argumentsText } }] } }] }));
  const response = await client.requestAIChat(snapshot, [{ role: "user", content: "Hi" }]);
  const raw = await response.text();
  assert.ok(!raw.includes("echoed-upstream-key") && !raw.includes("quote"));
  const parsed = JSON.parse(raw);
  assert.equal(parsed["****"], true);
  assert.deepEqual(JSON.parse(parsed.choices[0].message.tool_calls[0].function.arguments), { text: "****" });
  globalThis.fetch = async () => new Response('data: ' + JSON.stringify({ "echoed-upstream-key": true, choices: [{ delta: { content: "echoed-upstream-key" } }] }) + '\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  const sse = await (await client.requestAIChat(snapshot, [{ role: "user", content: "Hi" }], {}, true)).text();
  assert.ok(!sse.includes("echoed-upstream-key") && sse.includes("[DONE]"));
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'quote"secret echoed-upstream-key' }), { status: 400 });
  const failed = await client.requestAIChat(snapshot, [{ role: "user", content: "Hi" }]);
  assert.equal(failed.status, 400);
  assert.ok(!(await failed.text()).includes("secret"));
});

test("concurrent shared streams retain independent provider and redaction contexts during rotation", async () => {
  const profile = shared.saveSharedAIProfile("local-user", { name: "Concurrent rotation", provider: "openai", apiUrl: "https://upstream.example/v1", apiKey: "first-key", model: "chat-model", memberIds: ["other-local"] });
  shared.activateSharedAIProfile("other-local", profile.id);
  const snapshot = { ...shared.resolveSharedChatSettings("other-local")!, shared_ai_user_id: "other-local" };
  let release!: (value: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(resolve => { release = resolve; });
  const first = client.callAIChatStream(snapshot, [{ role: "user", content: "Hi" }]);
  const firstResult = first.next();
  await Promise.resolve();
  shared.saveSharedAIProfile("local-user", { revision: 1, provider: "anthropic", apiKey: "second-key" }, profile.id);
  globalThis.fetch = async () => new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"second-key"}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  let second = "";
  for await (const text of client.callAIChatStream(snapshot, [{ role: "user", content: "Hi" }])) second += text;
  assert.equal(second, "****");
  release(new Response('data: {"choices":[{"delta":{"content":"first-key"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } }));
  assert.equal((await firstResult).value, "****");
  await first.return();
  assert.equal(snapshot.ai_provider, "openai");
});
