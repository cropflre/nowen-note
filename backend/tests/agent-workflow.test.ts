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
  db.exec("DELETE FROM agent_templates; DELETE FROM agent_mcp_connections; DELETE FROM agent_workflows; DELETE FROM agent_runs; DELETE FROM tasks; DELETE FROM task_composer_batches; DELETE FROM notes WHERE id NOT IN ('workflow-source','workflow-child-source','workflow-secret'); DELETE FROM notebook_passwords; UPDATE notes SET isLocked=0,isTrashed=0,content='Alpha evidence: review the report',contentText='Alpha evidence: review the report',version=1 WHERE id='workflow-source';");
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

function reviewInput(run: ReturnType<AgentWorkflowRuntime["get"]>, patches: Record<string, unknown>[] = []) {
  return { token: run.preview!.token!, tasks: run.preview!.tasks!.tasks.map(({ reason: _reason, warnings: _warnings, duplicateOf: _duplicates, projectId: _project, ...task }, index) => ({ ...task, selected: true, ...patches[index] })) };
}

test("reviewed task edits rotate approval, exclude drafts and persist only the selected fields once (DCC-002)", async () => {
  const baseRespond = respond;
  respond = async (body, signal) => body.tools ? baseRespond(body, signal) : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [{ title: "Review alpha" }, { title: "Excluded alpha" }] }) } }] }));
  const run = await settled(runtime.create(userId, null, input()).id);
  const edited = runtime.reviseTasks(run.id, userId, reviewInput(run, [{ title: "Reviewed title", description: "User-approved details", priority: 3, dueDate: "2026-11-02" }, { selected: false }]));
  assert.equal(count("tasks"), 0); assert.equal(count("notes"), 3);
  assert.notEqual(edited.preview!.token, run.preview!.token);
  await assert.rejects(runtime.approve(run.id, userId, run.preview!.token!), /APPROVAL_INVALID/);
  const completed = await runtime.approve(run.id, userId, edited.preview!.token!);
  assert.equal(completed.status, "completed"); assert.equal(count("tasks"), 1);
  const stored = db.prepare("SELECT title,description,priority,dueDate,noteId FROM tasks").get() as Record<string, unknown>;
  assert.deepEqual(stored, { title: "Reviewed title", description: "User-approved details", priority: 3, dueDate: "2026-11-02", noteId: completed.actions.find(a => a.kind === "note")!.resourceIds[0] });
  await assert.rejects(runtime.approve(run.id, userId, edited.preview!.token!), /APPROVAL_INVALID/);
  assert.throws(() => runtime.reviseTasks(run.id, userId, reviewInput(edited)), /APPROVAL_INVALID/);
  closeDb(); db = (await import("../src/db/schema.js")).getDb();
  assert.deepEqual(db.prepare("SELECT title,description,priority,dueDate,noteId FROM tasks").get(), stored);
});

test("task review rejects forged identities, fields, dates, duplicates and stale approvals without changing drafts", async () => {
  const run = await settled(runtime.create(userId, null, input()).id);
  for (const patch of [{ clientId: "forged" }, { title: "" }, { userId: "workflow-b" }, { projectId: "foreign-project" }, { allowDuplicate: true }, { startDate: "2026-11-03", dueDate: "2026-11-01" }, { repeatRule: "daily" }]) {
    assert.throws(() => runtime.reviseTasks(run.id, userId, reviewInput(run, [patch])));
    assert.equal(runtime.get(run.id, userId).preview!.token, run.preview!.token);
  }
  const valid = reviewInput(run);
  assert.throws(() => runtime.reviseTasks(run.id, "workflow-b", valid), /RUN_NOT_FOUND/);
  assert.throws(() => runtime.reviseTasks(run.id, userId, { ...valid, tasks: [] }));
  assert.throws(() => runtime.reviseTasks(run.id, userId, { ...valid, tasks: [...valid.tasks, ...valid.tasks] }));
  const revised = runtime.reviseTasks(run.id, userId, reviewInput(run, [{ title: "New title" }]));
  assert.throws(() => runtime.reviseTasks(run.id, userId, valid), /APPROVAL_INVALID/);
  db.prepare("UPDATE notes SET content='Changed source' WHERE id='workflow-source'").run();
  assert.throws(() => runtime.reviseTasks(run.id, userId, reviewInput(revised)), /VERSION_CONFLICT/);
  assert.equal(count("tasks"), 0); assert.equal(count("notes"), 3);
});

test("all tasks may be excluded without calling batch creation; note approval remains explicit", async () => {
  const run = await settled(runtime.create(userId, null, input()).id);
  const revised = runtime.reviseTasks(run.id, userId, reviewInput(run, [{ selected: false, title: "" }]));
  assert.equal(count("notes"), 3);
  const completed = await runtime.approve(run.id, userId, revised.preview!.token!);
  assert.equal(completed.status, "completed"); assert.equal(count("tasks"), 0); assert.equal(count("task_composer_batches"), 0);
  assert.equal(count("notes"), 4); assert.deepEqual(completed.actions.find(a => a.kind === "tasks")!.resourceIds, []);
});

test("review cannot alter completed task actions or expired and cancelled previews", async () => {
  const run = await settled(runtime.create(userId, null, input()).id);
  const original = reviewInput(run);
  runtime.cancel(run.id, userId);
  assert.throws(() => runtime.reviseTasks(run.id, userId, original), /APPROVAL_EXPIRED|AbortError/);
  const next = await settled(runtime.create(userId, null, input()).id);
  const restarted = new WorkflowRuntime(); restarted.initialize();
  assert.throws(() => restarted.reviseTasks(next.id, userId, reviewInput(next)), /APPROVAL_EXPIRED/);
  assert.equal(count("tasks"), 0);
});

test("task review detects duplicates before approval and permits excluding the conflicting candidate", async () => {
  const baseRespond = respond;
  respond = async (body, signal) => body.tools ? baseRespond(body, signal) : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [{ title: "First alpha" }, { title: "Second alpha" }] }) } }] }));
  const run = await settled(runtime.create(userId, null, input()).id);
  assert.throws(() => runtime.reviseTasks(run.id, userId, reviewInput(run, [{ title: "Same" }, { title: "Same" }])), /DUPLICATE_CANDIDATE/);
  db.prepare("INSERT INTO tasks(id,userId,title) VALUES ('existing-alpha',?,'Existing alpha')").run(userId);
  assert.throws(() => runtime.reviseTasks(run.id, userId, reviewInput(run, [{ title: "Existing alpha" }])), /TASK_DUPLICATE/);
  const reviewed = runtime.reviseTasks(run.id, userId, reviewInput(run, [{ title: "Same" }, { title: "Same", selected: false }]));
  assert.equal(reviewed.status, "waiting_approval"); assert.equal(count("tasks"), 1);
});

test("task review API enforces session, workspace, owner and strict input before changing approval (DCC-006)", async () => {
  const send = (path: string, body: unknown, patch = {}) => app.request(`/api/agent${path}`, { method: "POST", headers: { ...headers, ...patch }, body: JSON.stringify(body) });
  const start = await send("/workflows", input());
  assert.equal(start.status, 202); const { id } = await start.json();
  let run: ReturnType<AgentWorkflowRuntime["get"]>;
  for (let i = 0; i < 150; i++) {
    run = await (await app.request(`/api/agent/workflows/${id}`, { headers })).json();
    if (run!.status === "waiting_approval") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(run!.status, "waiting_approval");
  const draft = reviewInput(run!);
  assert.equal((await send(`/workflows/${id}/tasks`, draft, { "X-Auth-Mode": "api-token" })).status, 403);
  assert.equal((await send(`/workflows/${id}/tasks?workspaceId=forged`, draft)).status, 403);
  assert.equal((await send(`/workflows/${id}/tasks`, draft, { "X-User-Id": "workflow-b" })).status, 404);
  assert.equal((await send(`/workflows/${id}/tasks`, { ...draft, execute: true })).status, 400);
  const revised = await send(`/workflows/${id}/tasks`, draft);
  assert.equal(revised.status, 200); assert.notEqual((await revised.json()).preview.token, draft.token);
  const oldApproval = await send(`/workflows/${id}/approve`, { token: draft.token });
  assert.equal((await oldApproval.json()).code, "APPROVAL_INVALID");
  assert.equal(count("tasks"), 0); assert.equal(count("notes"), 3);
  await send(`/workflows/${id}/cancel`, {});
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
  const revised = runtime.reviseTasks(run.id, userId, reviewInput(retry, [{ title: "Reviewed after Outbox recovery" }]));
  const saved = await runtime.approve(run.id, userId, revised.preview!.token!);
  assert.equal(saved.status, "completed"); assert.equal(count("tasks"), 1);
  const ids = saved.actions.flatMap(action => action.resourceIds);
  closeDb(); db = (await import("../src/db/schema.js")).getDb();
  for (const id of ids) assert.ok(db.prepare("SELECT 1 FROM sync_outbox WHERE entityId=? AND profileId=?").get(id, profile.id));
  assert.equal((db.prepare("SELECT noteId FROM tasks").get() as { noteId: string }).noteId, noteId);
  assert.equal((db.prepare("SELECT title FROM tasks").get() as { title: string }).title, "Reviewed after Outbox recovery");
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


test("P2 templates copy owned prompts without granting actions; scope and owner stay server authoritative", async () => {
  const { saveAgentTemplate, getAgentTemplate, promptForAgent } = await import("../src/agent/templates.js");
  db.prepare("INSERT INTO ai_custom_prompts(id,userId,name,prompt) VALUES ('workflow-prompt',?,'Prompt','Summarize alpha')").run(userId);
  assert.equal(promptForAgent("workflow-prompt", userId).instruction, "Summarize alpha");
  assert.throws(() => promptForAgent("workflow-prompt", "workflow-b"), /TEMPLATE_NOT_FOUND/);
  const template = saveAgentTemplate(userId, null, { name: "Read only", input: input(), allowNote: false, allowTasks: false });
  assert.throws(() => getAgentTemplate(template.id, "workflow-b", null), /TEMPLATE_NOT_FOUND/);
  assert.throws(() => getAgentTemplate(template.id, userId, "foreign"), /TEMPLATE_NOT_FOUND/);
  const denied = await settled(runtime.create(userId, null, input({ templateId: template.id, templateRevision: template.revision })).id);
  assert.equal(denied.errorCode, "TOOL_GRANT_REVOKED"); assert.equal(count("notes"), 3);
  plan = { summary: "Read only", sourceNoteIds: ["workflow-source"] };
  const run = await settled(runtime.create(userId, null, input({ templateId: template.id, templateRevision: template.revision, notebookId: "workflow-other", instruction: "FORGED_INSTRUCTION" })).id);
  assert.equal(run.status, "completed"); assert.equal(run.notebookId, "workflow-book");
  assert.ok(!JSON.stringify(requests).includes("FORGED_INSTRUCTION"));
});

test("P2 changed template invalidates old approval and still permits cancellation", async () => {
  const { saveAgentTemplate } = await import("../src/agent/templates.js");
  const config = { name: "Writer", input: input(), allowNote: true, allowTasks: true };
  const template = saveAgentTemplate(userId, null, config);
  const run = await settled(runtime.create(userId, null, input({ templateId: template.id, templateRevision: template.revision })).id);
  saveAgentTemplate(userId, null, { ...config, allowNote: false }, template.id, template.revision);
  assert.throws(() => runtime.create(userId, null, input({templateId:template.id,templateRevision:template.revision})), /TEMPLATE_CHANGED/);
  await assert.rejects(runtime.approve(run.id, userId, run.preview!.token!), /TEMPLATE_CHANGED/);
  assert.equal(runtime.get(run.id, userId).preview, undefined);
  assert.equal(runtime.cancel(run.id, userId).status, "interrupted"); assert.equal(count("notes"), 3);
});

test("P2 extension allowlist rejects forged calls without making a remote request", async () => {
  const { saveAgentTemplate } = await import("../src/agent/templates.js");
  const template = saveAgentTemplate(userId, null, { name: "No tools", input: input(), allowNote: true, allowTasks: true });
  plan.extensionCalls = [{ toolId: "mcp:forged:delete", input: {} }];
  const run = await settled(runtime.create(userId, null, input({ templateId: template.id, templateRevision: template.revision })).id);
  assert.equal(run.errorCode, "TOOL_GRANT_REVOKED"); assert.equal(count("tasks"), 0);
  const ordinary = await settled(runtime.create(userId, null, input()).id);
  assert.equal(ordinary.errorCode, "TOOL_GRANT_REVOKED");
});

test("P2 trigger identity commits with proposal; event payload cannot replace instructions or scope", async () => {
  const { saveAgentTemplate } = await import("../src/agent/templates.js");
  const { WorkflowRepository } = await import("../src/automation/workflowRepository.js");
  const { triggerAgentTemplate } = await import("../src/agent/triggerTemplate.js");
  const { eventPublisher } = await import("../src/automation/eventPublisher.js");
  const template = saveAgentTemplate(userId, null, { name: "Daily", input: input(), allowNote: true, allowTasks: true });
  const repository = new WorkflowRepository();
  const workflow = repository.create(userId, { name: "Daily", definition: { version: 1, trigger: { type: "event", event: "note.created" }, steps: [{ id: "agent", type: "agent", templateId: template.id, templateRevision: template.revision }] } }).workflow;
  const enabled = repository.setEnabled(workflow.id, true);
  const event = eventPublisher.publish({ type: "note.created", userId, resourceType: "note", resourceId: "workflow-source", data: { instruction: "PAYLOAD_INJECTION", notebookId: "workflow-other" } });
  const job = repository.createRun(enabled, event.id);
  const created = triggerAgentTemplate(job, enabled, template.id, template.revision);
  assert.deepEqual(triggerAgentTemplate(job, enabled, template.id, template.revision), created);
  const run = await settled(created.agentRunId);
  assert.equal(run.status, "waiting_approval"); assert.equal(count("notes"), 3); assert.equal(count("tasks"), 0);
  assert.ok(!JSON.stringify(requests).includes("PAYLOAD_INJECTION"));
  const foreign = eventPublisher.publish({ type: "note.created", userId: "workflow-b", resourceType: "note", resourceId: "workflow-secret" });
  const foreignJob = repository.createRun(enabled, foreign.id);
  assert.throws(() => triggerAgentTemplate(foreignJob, enabled, template.id, template.revision), /AGENT_TRIGGER_DENIED/);
});

test("P2 uncertain extension receipts survive restart and block retry", async () => {
  const run = await settled(runtime.create(userId, null, input()).id);
  db.prepare("INSERT INTO agent_extension_receipts(runId,callIndex,toolId,status,argumentDigest,createdAt) VALUES (?,0,'mcp:fixture:write','attempted','hash',?)").run(run.id, new Date().toISOString());
  const restarted = new WorkflowRuntime(); restarted.initialize();
  assert.equal((restarted.get(run.id, userId).extensionReceipts[0] as { status: string }).status, "uncertain");
  await assert.rejects(restarted.approve(run.id, userId, run.preview!.token!), /APPROVAL_EXPIRED/);
  assert.equal(count("notes"), 3);
});


test("P2 connection credentials stay encrypted and revoked connections invalidate grants", async () => {
  const { createConnection, discoverConnection, listConnections, grantedExtensions, assertExtensionRevisions } = await import("../src/agent/extensions.js");
  const { AgentMcpClient } = await import("../src/agent/mcpClient.js");
  const linked = createConnection(userId, { name: "Search", url: "https://mcp.example.com/mcp", token: "PRIVATE_MCP_CREDENTIAL", allowedTools: ["search"] });
  const row = db.prepare("SELECT * FROM agent_mcp_connections WHERE id=?").get(linked.id);
  assert.ok(!JSON.stringify(row).includes("PRIVATE_MCP_CREDENTIAL"));
  assert.ok(!JSON.stringify(listConnections(userId)).includes("secretJson"));
  assert.deepEqual(listConnections("workflow-b"), []);
  const client = new AgentMcpClient(async request => ({ ok: true, status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: (request.body as { id: string }).id, result: { tools: [{ name: "search", inputSchema: { type: "object" } }, { name: "delete", inputSchema: { type: "object" } }] } }) }));
  const tools = await discoverConnection(linked.id, userId, client); assert.equal(tools.length, 1);
  const grants = grantedExtensions(userId, [`mcp:${linked.id}:search`]);
  assert.throws(() => grantedExtensions("workflow-b", [grants[0].id]), /TOOL_GRANT_REVOKED/);
  db.prepare("DELETE FROM agent_mcp_connections WHERE id=?").run(linked.id);
  assert.throws(() => assertExtensionRevisions(userId, grants), /TOOL_GRANT_REVOKED/);
});


test("P2 the existing scheduler creates exactly one pending Agent proposal without business writes", async () => {
  const { saveAgentTemplate } = await import("../src/agent/templates.js");
  const { WorkflowRepository } = await import("../src/automation/workflowRepository.js");
  const { automationRuntime } = await import("../src/automation/runtime.js");
  const template = saveAgentTemplate(userId, null, { name: "Scheduled", input: input(), allowNote: true, allowTasks: true });
  const repository = new WorkflowRepository();
  const workflow = repository.create(userId, { name: "Scheduled", definition: { version: 1, trigger: { type: "schedule", cron: "0 9 * * *", timezone: "Asia/Shanghai" }, steps: [{ id: "agent", type: "agent", templateId: template.id, templateRevision: template.revision }] } }).workflow;
  repository.setEnabled(workflow.id, true);
  db.prepare("UPDATE automation_schedules SET nextRunAt=? WHERE workflowId=?").run(new Date(Date.now()-1000).toISOString(), workflow.id);
  await automationRuntime.tick();
  for (let i=0;i<100;i++) { if (repository.listRuns(workflow.id)[0]?.status === "completed") break; await new Promise(resolve => setTimeout(resolve,10)); }
  await automationRuntime.tick();
  assert.equal(repository.listRuns(workflow.id).length, 1);
  const mapping = db.prepare("SELECT agentRunId FROM agent_trigger_runs WHERE automationRunId=?").get(repository.listRuns(workflow.id)[0].id) as { agentRunId: string };
  // The trigger uses the singleton runtime, which owns this proposal's memory.
  const { agentWorkflowRuntime } = await import("../src/agent/workflowRuntime.js");
  let proposal;
  for (let i=0;i<100;i++) { proposal = agentWorkflowRuntime.get(mapping.agentRunId,userId); if(proposal.status === "waiting_approval") break; await new Promise(resolve=>setTimeout(resolve,10)); }
  assert.equal(proposal!.status,"waiting_approval"); assert.equal(count("notes"),3); assert.equal(count("tasks"),0);
  agentWorkflowRuntime.cancel(mapping.agentRunId,userId);
  repository.setEnabled(workflow.id,false);
});


test("P2 approved plugin Action executes in QuickJS once; Node and community tools never enter the catalog", async () => {
  const fs = await import("node:fs"); const path = await import("node:path");
  const { getPluginService } = await import("../src/plugins/pluginService.js");
  const { extensionCatalog } = await import("../src/agent/extensions.js");
  const { saveAgentTemplate } = await import("../src/agent/templates.js");
  const directory = path.join(process.env.ELECTRON_USER_DATA!, "agent-plugin"); fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,"index.js"),'globalThis.__nowenPluginModule={actions:{format:async({input})=>({success:true,data:{text:input.text.toUpperCase()}})}}');
  const service = getPluginService();
  service.registry.upsert({ manifest: { id: "nowen.agentfixture", publisher: "nowen", name: "Format", description: "test", version: "1.0.0", apiVersion: 2, engines: { nowen: ">=1.5.0 <2.0.0" }, runtime: "sandbox-js", main: "index.js", categories: ["productivity"], repository: "https://example.com/source", license: "MIT", permissions: [], actions: [{ id: "format", name: "Format text", input: { text: { type: "string", required: true } } }] }, source: "official", trustLevel: "official", status: "enabled", signatureState: "verified", checksum: "p2-fixture", installedPath: directory, installedBy: userId });
  db.prepare("UPDATE plugin_registry SET lifecycleState='stable' WHERE id='nowen.agentfixture'").run();
  const toolId = "plugin:nowen.agentfixture:format";
  assert.ok(extensionCatalog(userId).some(t=>t.id===toolId));
  const template = saveAgentTemplate(userId,null,{name:"Format",input:input(),toolIds:[toolId]});
  plan = { summary:"Format text after approval",sourceNoteIds:["workflow-source"],extensionCalls:[{toolId,input:{text:"alpha"}}] };
  try {
    const run = await settled(runtime.create(userId,null,input({templateId:template.id,templateRevision:template.revision})).id);
    assert.equal(run.status,"waiting_approval"); assert.equal(count("plugin_executions"),0);
    const saved = await runtime.approve(run.id,userId,run.preview!.token!);
    assert.equal(saved.status,"completed"); assert.equal(count("plugin_executions"),1);
    assert.deepEqual(saved.preview!.extensionResults,[{success:true,data:{text:"ALPHA"}}]);
    await assert.rejects(runtime.approve(run.id,userId,run.preview!.token!),/APPROVAL_INVALID/);
    db.prepare("UPDATE plugin_registry SET trustLevel='community' WHERE id='nowen.agentfixture'").run();
    assert.ok(!extensionCatalog(userId).some(t=>t.id===toolId));
    db.prepare("UPDATE plugin_registry SET trustLevel='official',runtime='node-action',manifestJson=replace(manifestJson,'sandbox-js','node-action') WHERE id='nowen.agentfixture'").run();
    assert.ok(!extensionCatalog(userId).some(t=>t.id===toolId));
  } finally { await service.executions.shutdown("nowen.agentfixture"); db.prepare("DELETE FROM plugin_executions WHERE pluginId='nowen.agentfixture'").run(); db.prepare("DELETE FROM plugin_versions WHERE pluginId='nowen.agentfixture'").run(); db.prepare("DELETE FROM plugin_registry WHERE id='nowen.agentfixture'").run(); fs.rmSync(directory,{recursive:true,force:true}); }
});


test("P2 an unknown remote outcome cannot replay the call or repeat committed notes", async () => {
  const { createConnection, discoverConnection } = await import("../src/agent/extensions.js");
  const { saveAgentTemplate } = await import("../src/agent/templates.js");
  const { AgentMcpClient } = await import("../src/agent/mcpClient.js");
  const connection = createConnection(userId,{name:"Remote",url:"https://mcp.example.com/mcp",allowedTools:["write"]});
  await discoverConnection(connection.id,userId,new AgentMcpClient(async request=>({ok:true,status:200,headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:(request.body as {id:string}).id,result:{tools:[{name:"write",inputSchema:{type:"object"}}]}})})));
  const toolId = `mcp:${connection.id}:write`;
  const template = saveAgentTemplate(userId,null,{name:"Remote",input:input(),allowNote:true,toolIds:[toolId]});
  let calls=0;
  runtime = new WorkflowRuntime(async()=>{calls++; throw new Error("lost after send");}); runtime.initialize();
  plan = {summary:"Create then call",sourceNoteIds:["workflow-source"],note:{title:"Saved first",content:"Saved"},extensionCalls:[{toolId,input:{value:"approved"}}]};
  const run = await settled(runtime.create(userId,null,input({templateId:template.id,templateRevision:template.revision})).id);
  assert.equal(calls,0);
  const partial = await runtime.approve(run.id,userId,run.preview!.token!);
  assert.equal(partial.status,"partial"); assert.equal(partial.errorCode,"EXTENSION_RESULT_UNCERTAIN");
  assert.equal(calls,1); assert.equal(count("notes"),4);
  assert.throws(()=>runtime.retry(run.id,userId),/EXTENSION_RESULT_UNCERTAIN/);
  await assert.rejects(runtime.approve(run.id,userId,run.preview!.token!),/APPROVAL_INVALID/);
  assert.equal(calls,1); assert.equal(partial.extensionReceipts[0].status,"uncertain");
});


test("P2 management routes reject PATs, foreign templates and forged schema properties", async () => {
  const config = { name:"API template",input:input(),allowNote:true,allowTasks:true,toolIds:[] };
  const created = await app.request("http://test/api/agent/library/templates",{method:"POST",headers,body:JSON.stringify(config)});
  assert.equal(created.status,201); const template = await created.json() as {id:string;revision:string};
  const foreign = await app.request("http://test/api/agent/library/templates",{headers:{...headers,"X-User-Id":"workflow-b"}});
  assert.deepEqual(await foreign.json(),[]);
  const changed = await app.request(`http://test/api/agent/library/templates/${template.id}`,{method:"PUT",headers:{...headers,"X-User-Id":"workflow-b"},body:JSON.stringify({revision:template.revision,config})});
  assert.equal(changed.status,404);
  const pat = await app.request("http://test/api/agent/library/templates",{headers:{...headers,"X-Auth-Mode":"api-token"}}); assert.equal(pat.status,403);
  const forged = await app.request("http://test/api/agent/library/templates",{method:"POST",headers,body:JSON.stringify({...config,execute:true})}); assert.equal(forged.status,400);
  const unsigned = await app.request(`http://test/api/agent/library/templates/${template.id}/automations`,{method:"POST",headers,body:JSON.stringify({revision:template.revision,trigger:{type:"webhook",requireSignature:false}})}); assert.equal(unsigned.status,400);
});


test("P2 backup restoration revokes connection credentials and discovered tool grants", async () => {
  const { createConnection } = await import("../src/agent/extensions.js");
  const { quarantineRestoredAutomations } = await import("../src/automation/recovery.js");
  const connection = createConnection(userId,{name:"Restore fixture",url:"https://mcp.example.com/mcp",token:"restore-fixture-secret",allowedTools:["search"]});
  db.prepare("UPDATE agent_mcp_connections SET toolsJson=? WHERE id=?").run(JSON.stringify([{name:"search",inputSchema:{type:"object"}}]),connection.id);
  quarantineRestoredAutomations();
  const row = db.prepare("SELECT secretJson,toolsJson,revision FROM agent_mcp_connections WHERE id=?").get(connection.id) as {secretJson:string|null;toolsJson:string;revision:string};
  assert.equal(row.secretJson,null);assert.equal(row.toolsJson,"[]");assert.equal(row.revision,"RESTORE_REVOKED");
});


test("P2 the existing event dispatcher creates a scoped Agent proposal exactly once", async () => {
  const { saveAgentTemplate } = await import("../src/agent/templates.js");
  const { WorkflowRepository } = await import("../src/automation/workflowRepository.js");
  const { eventPublisher } = await import("../src/automation/eventPublisher.js");
  const { automationRuntime } = await import("../src/automation/runtime.js");
  const { agentWorkflowRuntime } = await import("../src/agent/workflowRuntime.js");
  const template = saveAgentTemplate(userId,null,{name:"Event",input:input(),allowNote:true,allowTasks:true});
  const repository = new WorkflowRepository();
  const workflow = repository.create(userId,{name:"Event",definition:{version:1,trigger:{type:"event",event:"note.updated"},steps:[{id:"agent",type:"agent",templateId:template.id,templateRevision:template.revision}]}}).workflow;
  repository.setEnabled(workflow.id,true);
  const event = eventPublisher.publish({type:"note.updated",userId,resourceType:"note",resourceId:"workflow-source",data:{instruction:"DISPATCH_INJECTION"}});
  await automationRuntime.tick();
  for(let i=0;i<100;i++){if(repository.listRuns(workflow.id).some(r=>r.eventId===event.id&&r.status==="completed"))break;await new Promise(resolve=>setTimeout(resolve,10));}
  await automationRuntime.tick();
  const runs=repository.listRuns(workflow.id).filter(r=>r.eventId===event.id);assert.equal(runs.length,1);
  const mapping=db.prepare("SELECT agentRunId FROM agent_trigger_runs WHERE automationRunId=?").get(runs[0].id) as {agentRunId:string};
  let proposal;
  for(let i=0;i<100;i++){proposal=agentWorkflowRuntime.get(mapping.agentRunId,userId);if(proposal.status==="waiting_approval")break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(proposal!.status,"waiting_approval");assert.equal(count("notes"),3);assert.ok(!JSON.stringify(requests).includes("DISPATCH_INJECTION"));
  agentWorkflowRuntime.cancel(mapping.agentRunId,userId);repository.setEnabled(workflow.id,false);
});

test("unconfigured users cannot dispatch editor or notebook context to default model settings", async () => {
  const id = "workflow-no-model";
  db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,?)").run(id,id,"hash");
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES ('workflow-no-model-book',?,'No model')").run(id);
  db.prepare("INSERT INTO notes(id,userId,notebookId,title,content,contentText,contentFormat) VALUES ('workflow-no-model-note',?,'workflow-no-model-book','Synthetic','SYNTHETIC_NOT_CONFIGURED','SYNTHETIC_NOT_CONFIGURED','markdown')").run(id);
  const ownHeaders = { ...headers, "X-User-Id": id };
  const editor = await app.request("http://test/api/agent/runs", { method:"POST",headers:ownHeaders,body:JSON.stringify({noteId:"workflow-no-model-note",instruction:"Improve wording",content:"SYNTHETIC_NOT_CONFIGURED",format:"markdown",version:1}) });
  assert.equal(editor.status,400,`Unconfigured editor must reject before model dispatch; observed ${requests.length} model requests`);
  assert.equal((await editor.json() as {code:string}).code,"AI_NOT_CONFIGURED");
  const notebook = await app.request("http://test/api/agent/workflows",{method:"POST",headers:ownHeaders,body:JSON.stringify(input({notebookId:"workflow-no-model-book"}))});
  assert.equal(notebook.status,400);assert.equal((await notebook.json() as {code:string}).code,"AI_NOT_CONFIGURED");
  assert.equal(requests.length,0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM agent_runs WHERE userId=?").get(id) as {n:number}).n,0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM agent_workflows WHERE userId=?").get(id) as {n:number}).n,0);
  const { setUserAISettings } = await import("../src/services/user-ai-settings.js");
  const { agentWorkflowRuntime } = await import("../src/agent/workflowRuntime.js");
  for (const provider of ["ollama","lmstudio"]) {
    setUserAISettings(id,[{key:"ai_provider",value:provider},{key:"ai_api_url",value:"http://127.0.0.1:11434/v1"},{key:"ai_model",value:"local-fixture"}]);
    const local = await app.request("http://test/api/agent/workflows",{method:"POST",headers:ownHeaders,body:JSON.stringify(input({notebookId:"workflow-no-model-book"}))});
    assert.equal(local.status,202,`${provider} must remain usable without an API key`);
    agentWorkflowRuntime.cancel((await local.json() as {id:string}).id,id);
  }
});

test("clearing model credentials during a run blocks the next context-bearing request", async () => {
  const { setUserAISetting } = await import("../src/services/user-ai-settings.js");
  const previous = respond;
  respond = async (body, signal) => {
    const result = await previous(body, signal);
    setUserAISetting(userId,"ai_api_key","");
    return result;
  };
  try {
    const run = await settled(runtime.create(userId,null,input()).id);
    assert.equal(run.status,"failed");assert.equal(run.errorCode,"AI_NOT_CONFIGURED");
    assert.equal(requests.length,1);
    assert.equal(count("notes"),3);assert.equal(count("tasks"),0);
  } finally { setUserAISetting(userId,"ai_api_key","test-key"); }
});
