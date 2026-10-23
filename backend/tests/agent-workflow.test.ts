import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AgentWorkflowRuntime } from "../src/agent/workflowRuntime.js";
let WorkflowRuntime: typeof import("../src/agent/workflowRuntime.js").AgentWorkflowRuntime;

let db: ReturnType<typeof import("../src/db/schema.js").getDb>;
let closeDb: () => void;
let runtime: AgentWorkflowRuntime;
let app: Hono;
let originalFetch: typeof fetch;
let requests: any[];
let plan: any;
let respond: (body: any, signal: AbortSignal) => Promise<Response>;
const userId = "workflow-a";
const headers = { "Content-Type": "application/json", "X-User-Id": userId };
const input = (patch = {}) => ({ notebookId: "workflow-book", includeChildren: true, instruction: "Summarize alpha, create a summary note and tasks", timezone: "Asia/Shanghai", lang: "en" as const, ...patch });
const tool = (name: string, args: unknown) => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }), { headers: { "Content-Type": "application/json" } });
async function settled(id: string) {
  for (let i = 0; i < 150; i++) { const run = runtime.get(id, userId); if (!["queued", "running"].includes(run.status)) return run; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Workflow did not settle");
}
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
test.before(async () => {
  const schema = await import("../src/db/schema.js"); db = schema.getDb(); closeDb = schema.closeDb;
  WorkflowRuntime = (await import("../src/agent/workflowRuntime.js")).AgentWorkflowRuntime;
  for (const id of [userId, "workflow-b"]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,?)").run(id, id, "hash");
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES ('workflow-book',?,'Project'),('workflow-other','workflow-b','Private')").run(userId);
  db.prepare("INSERT INTO notebooks(id,userId,name,parentId) VALUES ('workflow-child',?,'Child','workflow-book')").run(userId);
  db.prepare("INSERT INTO notes(id,userId,notebookId,title,content,contentText,contentFormat) VALUES ('workflow-source',?,'workflow-book','Alpha report','Alpha evidence: review the report','Alpha evidence: review the report','markdown'),('workflow-child-source',?,'workflow-child','Alpha child','Alpha child evidence','Alpha child evidence','markdown'),('workflow-secret','workflow-b','workflow-other','Alpha private','PRIVATE_WORKFLOW_SENTINEL','PRIVATE_WORKFLOW_SENTINEL','markdown')").run(userId, userId);
  const settings = await import("../src/services/user-ai-settings.js");
  settings.setUserAISettings(userId, [{ key: "ai_api_url", value: "https://workflow.example/v1" }, { key: "ai_api_key", value: "test-key" }, { key: "ai_model", value: "workflow-model" }]);
  app = new Hono().route("/api/agent", (await import("../src/routes/agent.js")).default);
  originalFetch = globalThis.fetch;
});
test.beforeEach(() => {
  db.exec("DELETE FROM agent_workflows; DELETE FROM agent_runs; DELETE FROM tasks; DELETE FROM task_composer_batches; DELETE FROM notes WHERE id NOT IN ('workflow-source','workflow-child-source','workflow-secret'); DELETE FROM notebook_passwords; UPDATE notes SET isLocked=0,isTrashed=0,content='Alpha evidence: review the report',contentText='Alpha evidence: review the report',version=1 WHERE id='workflow-source';");
  runtime = new WorkflowRuntime(); runtime.initialize(); requests = [];
  plan = { summary: "Alpha summary", sourceNoteIds: ["workflow-source"], note: { title: "Alpha summary", content: "# Alpha summary\n\nReview the report." }, taskRequest: "Review the report" };
  respond = async body => body.tools
    ? body.messages.some((message: any) => message.role === "tool") ? tool("propose_workflow", plan) : tool("search_notebook", { query: "alpha" })
    : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [{ title: "Review alpha", priority: 2 }] }) } }] }), { headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests.push(body); return respond(body, init.signal as AbortSignal);
  }) as typeof fetch;
});
test.afterEach(() => {
  for (const row of db.prepare("SELECT id FROM agent_workflows").all() as { id: string }[]) { try { runtime.cancel(row.id, userId); } catch {} }
  db.exec("DROP TRIGGER IF EXISTS workflow_task_failure; DROP TRIGGER IF EXISTS workflow_action_failure; DROP TRIGGER IF EXISTS workflow_outbox_failure;");
  globalThis.fetch = originalFetch;
});
test.after(() => closeDb());

test("real RAG and task composer produce previews without writes; approval creates linked results once", async () => {
  const originalNotes = count("notes");
  const run = await settled(runtime.create(userId, null, input()).id);
  assert.equal(run.status, "waiting_approval"); assert.equal(count("notes"), originalNotes); assert.equal(count("tasks"), 0);
  assert.equal(run.preview!.tasks!.tasks.length, 1);
  assert.ok(JSON.stringify(requests).includes("Alpha evidence"));
  assert.ok(!JSON.stringify(requests).includes("PRIVATE_WORKFLOW_SENTINEL"));
  assert.ok(requests.some(body => !body.tools && body.messages[0].content.includes("You compose task DRAFTS")));
  const result = await runtime.approve(run.id, userId, run.preview!.token!);
  assert.equal(result.status, "completed");
  const note = result.actions.find(action => action.kind === "note")!.resourceIds[0];
  const task = db.prepare("SELECT * FROM tasks").get() as { id: string; noteId: string; dueAt: string | null };
  assert.equal(task.noteId, note); assert.equal(task.dueAt, null);
  assert.equal((db.prepare("SELECT content FROM notes WHERE id=?").get(note) as { content: string }).content.includes("Review the report."), true);
  await assert.rejects(runtime.approve(run.id, userId, run.preview!.token!), /APPROVAL_INVALID/);
  assert.equal(count("notes"), originalNotes + 1); assert.equal(count("tasks"), 1);
});

test("explicit scope excludes child notebooks when requested and never reads foreign notes", async () => {
  plan = { summary: "Alpha summary", sourceNoteIds: ["workflow-source"] };
  const run = await settled(runtime.create(userId, null, input({ includeChildren: false })).id);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.preview!.sources.map(source => source.id), ["workflow-source"]);
  assert.ok(!JSON.stringify(requests).includes("Alpha child evidence"));
  assert.throws(() => runtime.create(userId, null, input({ notebookId: "workflow-other" })), /NOTE_ACCESS_DENIED/);
  assert.throws(() => runtime.get(run.id, "workflow-b"), /RUN_NOT_FOUND/);
});

test("locked notes and password folders are excluded before model context", async () => {
  db.prepare("UPDATE notes SET isLocked=1 WHERE id='workflow-source'").run();
  plan = { summary: "Child summary", sourceNoteIds: ["workflow-child-source"] };
  const run = await settled(runtime.create(userId, null, input()).id);
  assert.equal(run.status, "completed"); assert.ok(!JSON.stringify(requests).includes("review the report"));
  db.prepare("INSERT INTO notebook_passwords(notebookId,passwordHash) VALUES ('workflow-book','test-hash')").run();
  assert.throws(() => runtime.create(userId, null, input()), /PROTECTED_DOCUMENT/);
});

test("forged model citations and arbitrary tools cannot write", async () => {
  plan.sourceNoteIds = ["workflow-secret"];
  const run = await settled(runtime.create(userId, null, input()).id);
  assert.equal(run.errorCode, "NOTE_ACCESS_DENIED"); assert.equal(count("tasks"), 0);
  respond = async () => tool("run_shell", { command: "echo forbidden" });
  const second = await settled(runtime.create(userId, null, input()).id);
  assert.equal(second.errorCode, "TOOL_NOT_ALLOWED");
});

test("approval rechecks source body digest even when version did not advance", async () => {
  const run = await settled(runtime.create(userId, null, input()).id);
  db.prepare("UPDATE notes SET content='Changed without a version bump' WHERE id='workflow-source'").run();
  await assert.rejects(runtime.approve(run.id, userId, run.preview!.token!), /VERSION_CONFLICT/);
  assert.equal(count("tasks"), 0); assert.equal(count("notes"), 3);
});

test("partial failure keeps the note; retry requires new approval and creates only missing tasks", async () => {
  const run = await settled(runtime.create(userId, null, input()).id);
  db.exec("CREATE TRIGGER workflow_task_failure BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  const partial = await runtime.approve(run.id, userId, run.preview!.token!);
  assert.equal(partial.status, "partial"); assert.equal(count("notes"), 4); assert.equal(count("tasks"), 0);
  assert.equal(partial.actions.find(action => action.kind === "note")!.status, "completed");
  db.exec("DROP TRIGGER workflow_task_failure");
  const retry = runtime.retry(run.id, userId);
  assert.equal(retry.status, "waiting_approval"); assert.notEqual(retry.preview!.token, run.preview!.token);
  await assert.rejects(runtime.approve(run.id, userId, run.preview!.token!), /APPROVAL_INVALID/);
  const result = await runtime.approve(run.id, userId, retry.preview!.token!);
  assert.equal(result.status, "completed"); assert.equal(count("notes"), 4); assert.equal(count("tasks"), 1);
});

test("business write rolls back when durable action identity cannot commit", async () => {
  const run = await settled(runtime.create(userId, null, input()).id);
  db.exec("CREATE TRIGGER workflow_action_failure BEFORE UPDATE ON agent_workflow_actions WHEN NEW.kind='note' AND NEW.status='completed' BEGIN SELECT RAISE(ABORT,'result persistence failed'); END;");
  const failed = await runtime.approve(run.id, userId, run.preview!.token!);
  assert.equal(failed.status, "failed"); assert.equal(count("notes"), 3); assert.equal(count("tasks"), 0);
});

test("restart expires approval, retains completed result identity and never repeats writes", async () => {
  const run = await settled(runtime.create(userId, null, input()).id);
  db.exec("CREATE TRIGGER workflow_task_failure BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  await runtime.approve(run.id, userId, run.preview!.token!);
  const restarted = new WorkflowRuntime(); restarted.initialize();
  const saved = restarted.get(run.id, userId);
  assert.equal(saved.status, "partial"); assert.equal(saved.preview, undefined);
  assert.equal(saved.actions.find(action => action.kind === "note")!.resourceIds.length, 1);
  assert.ok(saved.sources.some(source => source.id === "workflow-source" && source.version === 1));
  assert.ok(!JSON.stringify(saved).includes("digest"));
  db.prepare("UPDATE notes SET isLocked=1 WHERE id='workflow-source'").run();
  assert.ok(!restarted.get(run.id, userId).sources.some(source => source.id === "workflow-source"));
  assert.throws(() => restarted.retry(run.id, userId), /APPROVAL_EXPIRED/);
  assert.equal(count("notes"), 4);
});

test("cancellation stops pending model and forbids later proposal or writes", async () => {
  respond = (_body, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }));
  const { id } = runtime.create(userId, null, input());
  runtime.cancel(id, userId);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runtime.get(id, userId).status, "cancelled"); assert.equal(count("tasks"), 0); assert.equal(count("notes"), 3);
});

test("interactive API denies PATs, foreign users, forged workspace and approval fields", async () => {
  const send = (path: string, body: unknown, patch = {}) => app.request(`/api/agent${path}`, { method: "POST", headers: { ...headers, ...patch }, body: JSON.stringify(body) });
  assert.equal((await send("/workflows", input(), { "X-Auth-Mode": "api-token" })).status, 403);
  assert.equal((await send("/workflows?workspaceId=forged", input())).status, 403);
  assert.equal((await send("/workflows", { ...input(), execute: true })).status, 400);
});

test("DCC-002: Outbox failure preserves the completed note, retries only tasks and survives reopening", async () => {
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile.js");
  const { ensureDevice } = await import("../src/sync/device.js");
  const profile = createProfile(db, { name: "Workflow sync", serverUrl: "http://workflow-sync.test" });
  switchActiveProfile(db, profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus='ready' WHERE id=?").run(profile.id);
  ensureDevice(db, { profileId: profile.id, platform: "darwin" });
  const run = await settled(runtime.create(userId, null, input()).id);
  db.exec("CREATE TRIGGER workflow_outbox_failure BEFORE INSERT ON sync_outbox WHEN NEW.entityType='task' BEGIN SELECT RAISE(ABORT,'Outbox unavailable'); END;");
  const partial = await runtime.approve(run.id, userId, run.preview!.token!);
  assert.equal(partial.status, "partial"); assert.equal(count("tasks"), 0); assert.equal(count("task_composer_batches"), 0);
  const noteId = partial.actions.find(action => action.kind === "note")!.resourceIds[0];
  assert.ok(db.prepare("SELECT 1 FROM sync_outbox WHERE entityType='note' AND entityId=? AND profileId=?").get(noteId, profile.id));
  db.exec("DROP TRIGGER workflow_outbox_failure");
  const retry = runtime.retry(run.id, userId);
  const saved = await runtime.approve(run.id, userId, retry.preview!.token!);
  assert.equal(saved.status, "completed"); assert.equal(count("tasks"), 1);
  const ids = saved.actions.flatMap(action => action.resourceIds);
  closeDb(); db = (await import("../src/db/schema.js")).getDb();
  for (const id of ids) assert.ok(db.prepare("SELECT 1 FROM sync_outbox WHERE entityId=? AND profileId=?").get(id, profile.id));
  assert.equal((db.prepare("SELECT noteId FROM tasks").get() as { noteId: string }).noteId, noteId);
});

test("source permission revocation and account token revocation block approval", async () => {
  const run = await settled(runtime.create(userId, null, input()).id);
  db.prepare("UPDATE notes SET isLocked=1 WHERE id='workflow-source'").run();
  await assert.rejects(runtime.approve(run.id, userId, run.preview!.token!), /PROTECTED_DOCUMENT/);
  db.prepare("UPDATE notes SET isLocked=0 WHERE id='workflow-source'").run();
  db.prepare("UPDATE users SET tokenVersion=tokenVersion+1 WHERE id=?").run(userId);
  await assert.rejects(runtime.approve(run.id, userId, run.preview!.token!), /NOTE_ACCESS_DENIED/);
  assert.equal(count("notes"), 3); assert.equal(count("tasks"), 0);
});

test("cancel between committed actions keeps real results and prevents the next action", async () => {
  const run = await settled(runtime.create(userId, null, input()).id);
  const applying = runtime.approve(run.id, userId, run.preview!.token!);
  // The first write is synchronous and committed before approve yields.
  const stopped = runtime.cancel(run.id, userId);
  await applying;
  assert.equal(stopped.status, "partial"); assert.equal(stopped.errorCode, "CHECK_CREATED_RESULTS");
  assert.equal(count("notes"), 4); assert.equal(count("tasks"), 0);
});

test("restart interrupts pending approval and old tokens cannot create anything", async () => {
  const run = await settled(runtime.create(userId, null, input()).id);
  const restarted = new WorkflowRuntime(); restarted.initialize();
  assert.equal(restarted.get(run.id, userId).status, "interrupted");
  await assert.rejects(restarted.approve(run.id, userId, run.preview!.token!), /APPROVAL_EXPIRED/);
  assert.equal(count("notes"), 3); assert.equal(count("tasks"), 0);
});

test("workspace owner can create scoped results; a viewer cannot approve new notes", async () => {
  db.prepare("INSERT INTO workspaces(id,name,ownerId) VALUES ('workflow-w','Team',?)").run(userId);
  db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES ('workflow-w',?,'owner'),('workflow-w','workflow-b','viewer')").run(userId);
  db.prepare("INSERT INTO notebooks(id,userId,workspaceId,name) VALUES ('workflow-team-book',?,'workflow-w','Team book')").run(userId);
  db.prepare("INSERT INTO notes(id,userId,workspaceId,notebookId,title,content,contentText,contentFormat) VALUES ('workflow-team-source',?,'workflow-w','workflow-team-book','Alpha team','Alpha team evidence','Alpha team evidence','markdown')").run(userId);
  plan.sourceNoteIds = ["workflow-team-source"];
  const teamInput = input({ notebookId: "workflow-team-book" });
  const run = await settled(runtime.create(userId, "workflow-w", teamInput).id);
  const result = await runtime.approve(run.id, userId, run.preview!.token!);
  assert.equal(result.status, "completed");
  assert.equal((db.prepare("SELECT workspaceId FROM tasks").get() as { workspaceId: string }).workspaceId, "workflow-w");
  const settings = await import("../src/services/user-ai-settings.js");
  settings.setUserAISettings("workflow-b", [{ key: "ai_api_url", value: "https://workflow.example/v1" }, { key: "ai_api_key", value: "test-key" }]);
  const viewer = runtime.create("workflow-b", "workflow-w", teamInput);
  let failed;
  for (let i = 0; i < 100; i++) { failed = runtime.get(viewer.id, "workflow-b"); if (failed.status === "failed") break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(failed!.errorCode, "NOTE_ACCESS_DENIED"); assert.equal(count("tasks"), 1);
});
