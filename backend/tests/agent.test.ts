import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { applyProposal } from "../src/agent/tools.js";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-agent-"));
process.env.DB_PATH = path.join(tmp, "agent.db");
let db: ReturnType<typeof import("../src/db/schema.js").getDb>;
let app: Hono;
let runtime: typeof import("../src/agent/runtime.js").agentRuntime;
let closeDb: () => void;
let originalFetch: typeof fetch;
let requests: any[] = [];
let model: (body: any, signal: AbortSignal) => Promise<Response>;
const headers = { "Content-Type": "application/json", "X-User-Id": "agent-a" };
const call = (name: string, args: unknown, id = "call-1") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const reply = (calls: unknown[]) => new Response(JSON.stringify({ choices: [{ message: { tool_calls: calls } }], usage: { total_tokens: 10 } }));
const send = (url: string, body = {}, extra = {}) => app.request(`/api/agent${url}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
const create = (patch = {}, extra = {}) => send("/runs", { noteId: "note-a", instruction: "Improve wording", content: "Original text", format: "markdown", version: 1, ...patch }, extra);
async function settled(id: string) { for (let i = 0; i < 50; i++) { const r = runtime.get(id, "agent-a"); if (!["running", "queued"].includes(r.status)) return r; await new Promise(r => setTimeout(r, 5)); } throw new Error("run did not settle"); }
test.before(async () => {
  const schema = await import("../src/db/schema.js"); db = schema.getDb(); closeDb = schema.closeDb;
  for (const id of ["agent-a", "agent-b"]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,?)").run(id,id,"hash");
  db.prepare("INSERT INTO notebooks(id,name,userId) VALUES ('book-a','A','agent-a'),('book-b','B','agent-b')").run();
  db.prepare("INSERT INTO notes(id,title,content,contentText,contentFormat,notebookId,userId,version) VALUES ('note-a','Title','Original text','Original text','markdown','book-a','agent-a',1),('note-b','Secret','SECRET','SECRET','markdown','book-b','agent-b',1)").run();
  const settings = await import("../src/services/user-ai-settings.js");
  settings.setUserAISettings("agent-a", [{ key: "ai_api_url", value: "https://agent.example/v1" }, { key: "ai_api_key", value: "secret-test-key" }]);
  runtime = (await import("../src/agent/runtime.js")).agentRuntime;
  app = new Hono(); app.route("/api/agent", (await import("../src/routes/agent.js")).default);
  app.route("/api/notes", (await import("../src/routes/notes.js")).default);
  originalFetch = globalThis.fetch;
});
test.beforeEach(() => {
  db.exec("DELETE FROM agent_runs; UPDATE notes SET content='Original text',contentText='Original text',contentFormat='markdown',version=1,isLocked=0,isTrashed=0 WHERE id='note-a';");
  requests = [];
  model = async body => body.messages.some((m: any) => m.role === "tool") ? reply([call("propose_note_edit", { edits: [{ before: "Original", after: "Improved" }] })]) : reply([call("get_current_note_context", {})]);
  globalThis.fetch = (async (_url: unknown, init: any) => { const body = JSON.parse(init.body); requests.push(body); return model(body, init.signal); }) as typeof fetch;
});
test.afterEach(() => { for (const r of db.prepare("SELECT id FROM agent_runs").all() as any[]) { try { runtime.cancel(r.id, "agent-a"); } catch {} } globalThis.fetch = originalFetch; });
test.after(() => { closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("real tool loop preserves unsaved snapshot; approval never writes; receipt requires durable content", async () => {
  const run = await settled((await (await create({ content: "Original text UNSAVED" })).json()).id); assert.equal(run.status, "waiting_approval");
  assert.ok(JSON.stringify(requests[1]).includes("UNSAVED")); assert.ok(!JSON.stringify(requests).includes("SECRET"));
  assert.equal(db.prepare("SELECT content FROM notes WHERE id='note-a'").get().content, "Original text");
  const token = run.proposal!.token!;
  assert.equal((await send(`/runs/${run.id}/approve`, { token, snapshot: "Original text UNSAVED" })).status, 200);
  assert.equal((await send(`/runs/${run.id}/approve`, { token, snapshot: "Original text UNSAVED" })).status, 409);
  assert.equal((await send(`/runs/${run.id}/receipt`)).status, 409);
  const saved = await app.request("/api/notes/note-a", { method: "PUT", headers, body: JSON.stringify({ content: "Improved text UNSAVED", contentText: "Improved text UNSAVED", contentFormat: "markdown", version: 1 }) });
  assert.equal(saved.status, 200, await saved.text());
  const receipt = await (await send(`/runs/${run.id}/receipt`)).json();
  assert.equal(receipt.status, "completed", JSON.stringify({ receipt, note: db.prepare("SELECT content,contentFormat,version FROM notes WHERE id='note-a'").get() }));
  closeDb(); db = (await import("../src/db/schema.js")).getDb();
  assert.equal((await send(`/runs/${run.id}/receipt`)).status, 200);
  assert.ok((db.prepare("SELECT content FROM notes WHERE id='note-a'").get() as any).content.includes("Improved text UNSAVED"));
  const metadata = JSON.stringify(db.prepare("SELECT * FROM agent_runs").all()) + JSON.stringify(db.prepare("SELECT * FROM agent_steps").all()) + JSON.stringify(db.prepare("SELECT * FROM agent_approvals").all());
  assert.ok(!metadata.includes("Original text") && !metadata.includes("secret-test-key") && !metadata.includes(token));
});
test("expired editor snapshots and concurrent versions cannot approve (DCC-004)", async () => {
  const run = await settled((await (await create()).json()).id);
  assert.equal((await send(`/runs/${run.id}/approve`, { token: run.proposal!.token, snapshot: "New local edit" })).status, 409);
  db.prepare("UPDATE notes SET version=2 WHERE id='note-a'").run();
  assert.equal((await send(`/runs/${run.id}/approve`, { token: run.proposal!.token, snapshot: "Original text" })).status, 409);
  assert.equal(db.prepare("SELECT content FROM notes WHERE id='note-a'").get().content, "Original text");
});
test("reject leaves original and event replay uses stable cursors", async () => {
  const run = await settled((await (await create()).json()).id);
  assert.equal((await (await send(`/runs/${run.id}/reject`)).json()).status, "cancelled");
  assert.equal(db.prepare("SELECT content FROM notes WHERE id='note-a'").get().content, "Original text");
  const text = await (await app.request(`/api/agent/runs/${run.id}/events?after=2`, { headers })).text(); assert.ok(text.includes("id: 3")); assert.ok(!text.includes("id: 1\n"));
});
test("cross user, restricted tokens, locked notes and disabled AI are denied before model access", async () => {
  assert.equal((await create({ noteId: "note-b" })).status, 403);
  assert.equal((await create({}, { "X-Auth-Mode": "api-token", "X-Api-Resource-Mode": "restricted" })).status, 403);
  db.prepare("UPDATE notes SET isLocked=1 WHERE id='note-a'").run(); assert.equal((await create()).status, 403);
  db.prepare("UPDATE notes SET isLocked=0 WHERE id='note-a'").run();
  const settings = await import("../src/services/user-ai-settings.js"); settings.setUserAISetting("agent-a", "ai_manual_enabled", "false"); assert.equal((await create()).status, 403); settings.setUserAISetting("agent-a", "ai_manual_enabled", "true"); assert.equal(requests.length, 0);
});
test("stop aborts upstream and prevents a late proposal", async () => {
  model = async (_body, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  const id = (await (await create()).json()).id; assert.equal((await (await send(`/runs/${id}/cancel`)).json()).status, "cancelled");
  await new Promise(r => setTimeout(r, 10)); assert.equal(runtime.get(id, "agent-a").status, "cancelled"); assert.equal(requests.length, 1);
});
test("upstream request timeout ends the run with a specific timeout error", async t => {
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (ms: number) => timeout(ms === 45_000 ? 1 : ms));
  model = async (_body, signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const run = await settled((await (await create()).json()).id);
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "MODEL_TIMEOUT");
  assert.equal(requests.length, 1);
  assert.equal(run.proposal, undefined);
});
test("unsupported model, unauthorized tools, invalid arguments and loops fail closed", async () => {
  for (const [response, code] of [[new Response(JSON.stringify({ choices: [{ message: { content: '```apply_note_edit```' } }] })), "TOOL_CALLING_UNSUPPORTED"], [reply([call("shell", {})]), "TOOL_NOT_ALLOWED"], [reply([call("propose_note_edit", { edits: [{ before: "Original", after: "New", userId: "agent-b" }] })]), "INVALID_TOOL_ARGUMENTS"]] as const) {
    model = async () => response.clone(); const run = await settled((await (await create()).json()).id); assert.equal(run.errorCode, code);
  }
  model = async () => reply([call("get_current_note_context", {})]); assert.equal((await settled((await (await create()).json()).id)).errorCode, "REPEATED_TOOL_CALL");
});
test("restart interrupts approvals and never replays a write", async () => {
  const run = await settled((await (await create()).json()).id);
  const restarted = new (await import("../src/agent/runtime.js")).AgentRuntime(); assert.equal(restarted.get(run.id, "agent-a").status, "interrupted");
  assert.throws(() => restarted.approve(run.id, "agent-a", run.proposal!.token!, "Original text"));
});
test("empty-note drafts stay proposals until approved and saved through the editor path", async () => {
  for (const format of ["markdown", "tiptap-json"] as const) {
    db.exec("DELETE FROM agent_runs");
    const content = format === "markdown" ? "" : JSON.stringify({ type: "doc", content: [{ type: "paragraph", attrs: { blockId: "blk_11111111-1111-4111-8111-111111111111" } }] });
    db.prepare("UPDATE notes SET content=?,contentText='',contentFormat=?,version=1 WHERE id='note-a'").run(content, format);
    model = async body => body.messages.some((m: any) => m.role === "tool") ? reply([call("propose_note_edit", { edits: [{ before: "", after: "A new draft" }] })]) : reply([call("get_current_note_context", {})]);
    const run = await settled((await (await create({ content, format })).json()).id);
    assert.equal(run.status, "waiting_approval");
    assert.equal((db.prepare("SELECT content FROM notes WHERE id='note-a'").get() as any).content, content);
    assert.ok(run.proposal?.result.includes("A new draft"));
    const approved = await send(`/runs/${run.id}/approve`, { token: run.proposal!.token, snapshot: content });
    assert.equal(approved.status, 200);
    assert.equal((db.prepare("SELECT content FROM notes WHERE id='note-a'").get() as any).content, content);
    const saved = await app.request("/api/notes/note-a", { method: "PUT", headers, body: JSON.stringify({ content: run.proposal!.result, contentText: "A new draft", contentFormat: format, version: 1 }) });
    assert.equal(saved.status, 200, await saved.text());
    const receipt = await (await send(`/runs/${run.id}/receipt`)).json();
    assert.equal(receipt.status, "completed", JSON.stringify({ format, receipt, expected: run.proposal!.result, saved: db.prepare("SELECT content,version FROM notes WHERE id='note-a'").get() }));
    closeDb(); db = (await import("../src/db/schema.js")).getDb();
    assert.ok((db.prepare("SELECT content FROM notes WHERE id='note-a'").get() as any).content.includes("A new draft"));
  }
});
test("draft insertion rejects existing text, attachments, multiple blocks and mixed edits", () => {
  const draft = [{ before: "", after: "Draft" }];
  for (const content of ["Existing", "![file](attachment:keep)", " "]) assert.throws(() => applyProposal(content, "markdown", draft));
  for (const content of [[{ type: "image", attrs: { src: "attachment:keep" } }], [{ type: "paragraph" }, { type: "paragraph" }], [{ type: "paragraph", content: [{ type: "text", text: "Existing" }] }]]) {
    assert.throws(() => applyProposal(JSON.stringify({ type: "doc", content }), "tiptap-json", draft));
  }
  assert.throws(() => applyProposal("", "markdown", [...draft, ...draft]));
  assert.throws(() => applyProposal("", "markdown", [{ before: "", after: "" }]));
});
test("rich edits preserve block IDs, marks and attachments; ambiguous or destructive edits fail", () => {
  const doc = { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "keep" }, content: [{ type: "text", text: "Original text", marks: [{ type: "bold" }, { type: "link", attrs: { href: "nowen://keep" } }] }] }, { type: "image", attrs: { src: "attachment:keep" } }] };
  const next = JSON.parse(applyProposal(JSON.stringify(doc), "tiptap-json", [{ before: "Original", after: "Better" }]));
  assert.deepEqual(next.content[0].attrs, doc.content[0].attrs); assert.deepEqual(next.content[0].content[0].marks, doc.content[0].content![0].marks); assert.deepEqual(next.content[1], doc.content[1]);
  assert.throws(() => applyProposal("same same", "markdown", [{ before: "same", after: "x" }]));
  assert.throws(() => applyProposal("![file](attachment:keep)", "markdown", [{ before: "![file](attachment:keep)", after: "" }]));
});
test("streaming tool arguments keep IDs and multiple interleaved calls across byte chunks", async () => {
  const { readAgentResponse } = await import("../src/agent/model.js");
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "two", type: "function", function: { name: "second", arguments: '{"value":' } }, { index: 0, id: "one", type: "function", function: { name: "first", arguments: "{" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }, { index: 1, function: { arguments: '"中文"}' } }] } }] },
  ].map(v => `data: ${JSON.stringify(v)}\r\n\r\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(events);
  const response = new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
  const parsed = await readAgentResponse(response);
  assert.deepEqual(parsed.choices[0].message.tool_calls.map((c: any) => [c.id, JSON.parse(c.function.arguments)]), [["one", {}], ["two", { value: "中文" }]]);
  await assert.rejects(readAgentResponse(new Response('data: {"choices":[]}\n\n', { headers: { "Content-Type": "text/event-stream" } })));
});
test("DeepSeek required tool calls explicitly disable thinking without changing other providers", async () => {
  const { callAgentModel } = await import("../src/agent/model.js");
  const { getUserAISettings } = await import("../src/services/user-ai-settings.js");
  const { toolRegistry } = await import("../src/agent/tools.js");
  const base = getUserAISettings("agent-a");
  for (const settings of [
    { ...base, ai_provider: "deepseek" },
    { ...base, ai_provider: "openai", ai_api_url: "https://api.deepseek.com/v1" },
    { ...base, ai_provider: "openai" },
  ]) await callAgentModel(settings, [{ role: "user", content: "Improve wording" }], toolRegistry, new AbortController().signal);
  assert.deepEqual(requests.map(body => body.thinking), [{ type: "disabled" }, { type: "disabled" }, undefined]);
  assert.ok(requests.every(body => body.tool_choice === "required"));
});
test("header-only gateway credentials work for Agent without changing its tool protocol", async () => {
  const { callAgentModel, agentModelConfigured } = await import("../src/agent/model.js");
  const { getUserAISettings } = await import("../src/services/user-ai-settings.js");
  const { toolRegistry } = await import("../src/agent/tools.js");
  const settings = { ...getUserAISettings("agent-a"), ai_api_key: "", ai_custom_headers: '{"x-session":"agent-session"}' };
  assert.equal(agentModelConfigured(settings), true);
  globalThis.fetch = (async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("x-session"), "agent-session");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return reply([call("get_current_note_context", {})]);
  }) as typeof fetch;
  assert.equal((await callAgentModel(settings, [{ role: "user", content: "Improve wording" }], toolRegistry, new AbortController().signal)).calls.length, 1);
});
test("native Anthropic text support does not advertise or send unsupported Agent tool calls", async () => {
  const { callAgentModel, agentModelCapabilities } = await import("../src/agent/model.js");
  const { getUserAISettings } = await import("../src/services/user-ai-settings.js");
  const { toolRegistry } = await import("../src/agent/tools.js");
  const settings = { ...getUserAISettings("agent-a"), ai_provider: "anthropic" };
  assert.equal(agentModelCapabilities(settings).toolCalling, false);
  await assert.rejects(callAgentModel(settings, [{ role: "user", content: "Improve wording" }], toolRegistry, new AbortController().signal), /TOOL_CALLING_UNSUPPORTED/);
  assert.equal(requests.length, 0);
});
test("password folders and workspace viewers cannot send content to the model", async () => {
  db.prepare("INSERT INTO notebook_passwords(notebookId,passwordHash) VALUES ('book-a','hash')").run();
  assert.equal((await create()).status, 403); db.prepare("DELETE FROM notebook_passwords WHERE notebookId='book-a'").run();
  db.prepare("INSERT INTO workspaces(id,name,ownerId) VALUES ('agent-workspace','Workspace','agent-b')").run();
  db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES ('agent-workspace','agent-a','viewer')").run();
  db.prepare("UPDATE notes SET workspaceId='agent-workspace' WHERE id='note-a'").run();
  assert.equal((await create()).status, 403); assert.equal(requests.length, 0);
  db.prepare("UPDATE notes SET workspaceId=NULL WHERE id='note-a'").run();
});
test("revoking login authority while the model runs prevents the next tool", async () => {
  let release!: (response: Response) => void;
  model = async () => new Promise(resolve => { release = resolve; });
  const id = (await (await create()).json()).id;
  db.prepare("UPDATE users SET tokenVersion=tokenVersion+1 WHERE id='agent-a'").run();
  release(reply([call("get_current_note_context", {})]));
  const run = await settled(id); assert.equal(run.status, "failed"); assert.equal(run.errorCode, "NOTE_ACCESS_DENIED");
  assert.equal(requests.length, 1); assert.equal(run.proposal, undefined);
});
test("lost approval response never makes a resumed run execute twice", async () => {
  const run = await settled((await (await create()).json()).id);
  const token = run.proposal!.token!;
  assert.equal((await send(`/runs/${run.id}/approve`, { token, snapshot: "Original text" })).status, 200);
  const latest = await (await app.request('/api/agent/runs?noteId=note-a', { headers })).json();
  assert.equal(latest.status, "applying"); assert.equal(latest.proposal, undefined);
  assert.equal((await send(`/runs/${run.id}/approve`, { token, snapshot: "Original text" })).status, 409);
});
test("approved editor save captures Outbox intent and keeps it after reopening (DCC-002)", async () => {
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile.js");
  const { ensureDevice } = await import("../src/sync/device.js");
  const profile = createProfile(db, { name: "Agent test sync", serverUrl: "http://sync.test" }); switchActiveProfile(db, profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus='ready' WHERE id=?").run(profile.id); ensureDevice(db, { profileId: profile.id, platform: "win32" });
  const run = await settled((await (await create()).json()).id);
  assert.equal((await send(`/runs/${run.id}/approve`, { token: run.proposal!.token, snapshot: "Original text" })).status, 200);
  const saved = await app.request("/api/notes/note-a", { method: "PUT", headers, body: JSON.stringify({ content: "Improved text", contentText: "Improved text", contentFormat: "markdown", version: 1 }) }); assert.equal(saved.status, 200);
  const pending = db.prepare("SELECT * FROM sync_outbox WHERE entityId='note-a'").all(); assert.ok(pending.length > 0);
  closeDb(); db = (await import("../src/db/schema.js")).getDb();
  assert.deepEqual(db.prepare("SELECT * FROM sync_outbox WHERE entityId='note-a'").all(), pending);
  assert.ok((db.prepare("SELECT content FROM notes WHERE id='note-a'").get() as any).content.includes("Improved text"));
});
test("same-version collaborative changes invalidate approval; exact durable results can confirm coalesced Yjs saves", async () => {
  const first = await settled((await (await create()).json()).id);
  db.prepare("UPDATE notes SET content='Concurrent Yjs content' WHERE id='note-a'").run();
  assert.equal((await send(`/runs/${first.id}/approve`, { token: first.proposal!.token, snapshot: "Original text" })).status, 409);
  runtime.cancel(first.id, "agent-a");
  db.prepare("UPDATE notes SET content='Original text' WHERE id='note-a'").run();
  const next = await settled((await (await create()).json()).id);
  assert.equal((await send(`/runs/${next.id}/approve`, { token: next.proposal!.token, snapshot: "Original text" })).status, 200);
  db.prepare("UPDATE notes SET content='Improved text' WHERE id='note-a'").run();
  assert.equal((await (await send(`/runs/${next.id}/receipt`)).json()).status, "completed");
});
