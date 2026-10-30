import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-composer-"));
process.env.DB_PATH = path.join(tmp, "test.db");
let app: Hono;
let db: ReturnType<typeof import("../src/db/schema.js").getDb>;
let closeDb: () => void;
let originalFetch: typeof fetch;
let aiOutput: unknown;
let aiRequests: Array<{ body: any; headers: Headers }>;
const headers = { "Content-Type": "application/json", "X-User-Id": "composer-a" };
const task = (title = "Review report", patch = {}) => ({ clientId: "draft-1", title, description: "", priority: 2, startDate: null, dueDate: "2026-12-31", dueAt: null, projectId: null, repeatRule: "none", repeatInterval: 1, repeatEndDate: null, repeatEndCount: null, ...patch });
const preview = (patch = {}) => app.request("/api/ai/task-plan/preview", { method: "POST", headers, body: JSON.stringify({ text: "Tomorrow review the report", timezone: "Asia/Shanghai", ...patch }) });
const batch = (tasks: unknown[], patch = {}, workspace = "personal") => app.request(`/api/tasks/ai-batch-create?workspaceId=${workspace}`, { method: "POST", headers, body: JSON.stringify({ requestId: "11111111-1111-4111-8111-111111111111", previewId: "22222222-2222-4222-8222-222222222222", timezone: "Asia/Shanghai", tasks, ...patch }) });

test.before(async () => {
  const { automationEventCaptureMiddleware } = await import("../src/automation/eventCapture.js");
  const schema = await import("../src/db/schema.js");
  db = schema.getDb(); closeDb = schema.closeDb;
  for (const id of ["composer-a", "composer-b"]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,?)").run(id, id, "hash");
  db.prepare("INSERT INTO workspaces(id,name,ownerId) VALUES ('composer-w','Shared','composer-a')").run();
  db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES ('composer-w','composer-a','owner')").run();
  db.prepare("INSERT INTO task_projects(id,userId,name) VALUES ('project-a','composer-a','Project A'),('project-b','composer-b','Secret')").run();
  const settings = await import("../src/services/user-ai-settings.js");
  settings.setUserAISettings("composer-a", [{ key: "ai_api_url", value: "https://composer.example/v1" }, { key: "ai_api_key", value: "test-key" }, { key: "ai_model", value: "composer-model" }]);
  const routes = await import("../src/routes/tasks.js");
  const aiRoutes = await import("../src/routes/ai-task-plan.js");
  const { enforceApiTokenAccess } = await import("../src/middleware/api-token-resource-scope.js");
  app = new Hono();
  app.use("/api/*", enforceApiTokenAccess);
  app.use("/api/*", automationEventCaptureMiddleware);
  app.route("/api/tasks", routes.default);
  app.route("/api/ai/task-plan", aiRoutes.default);
  originalFetch = globalThis.fetch;
});
test.beforeEach(() => {
  db.exec("DELETE FROM task_composer_batches; DELETE FROM tasks; DELETE FROM automation_events;");
  aiOutput = { tasks: [{ title: "Review report", priority: 2 }] };
  aiRequests = [];
  globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
    aiRequests.push({ body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof aiOutput === "string" ? aiOutput : JSON.stringify(aiOutput) } }] }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
test.afterEach(() => { globalThis.fetch = originalFetch; });
test.after(() => { closeDb?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("preview uses only the user's AI configuration and never writes tasks or events", async () => {
  const res = await preview(); assert.equal(res.status, 200);
  const data = await res.json(); assert.equal(data.tasks.length, 1); assert.ok(data.tasks[0].clientId);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM automation_events").get().n, 0);
  assert.equal(aiRequests[0].body.model, "composer-model");
  assert.equal(aiRequests[0].headers.get("Authorization"), "Bearer test-key");
  assert.ok(!JSON.stringify(aiRequests).includes("Secret"));
});
test("preview extracts mixed tasks, removes internal duplicates but keeps different dates", async () => {
  aiOutput = { tasks: [{ title: " Read   notes ", dueDate: "2026-12-30" }, { title: "read notes", dueDate: "2026-12-30" }, { title: "Read notes", dueDate: "2026-12-31" }] };
  const data = await (await preview()).json(); assert.equal(data.tasks.length, 2); assert.ok(data.warnings.includes("DUPLICATES_REMOVED"));
});
test("existing duplicates are scoped and warned without sending tasks to the model", async () => {
  db.prepare("INSERT INTO tasks(id,userId,title,dueDate) VALUES ('existing','composer-a','Review report','2026-12-31'),('foreign','composer-b','Private task',NULL)").run();
  aiOutput = { tasks: [task()] }; delete (aiOutput as any).tasks[0].clientId;
  const data = await (await preview()).json(); assert.deepEqual(data.tasks[0].duplicateOf, ["existing"]);
  assert.ok(!JSON.stringify(aiRequests).includes("Private task"));
});
test("preview validates malformed, empty, excessive and malicious model output", async () => {
  for (const output of ["not json", { tasks: [] }, { tasks: [{ title: "Bad", dueDate: "2026-02-30" }] }, { tasks: Array.from({ length: 13 }, (_, i) => ({ title: `Task ${i}` })) }, { tasks: [{ title: "Bad", userId: "composer-b" }] }, { tasks: [{ title: "Bad", projectId: "project-b" }] }, { tasks: [{ title: "Bad", repeatRule: "custom" }] }]) {
    aiOutput = output; const res = await preview(); assert.equal(res.status, 502, JSON.stringify(output));
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get().n, 0);
});
test("preview rejects unauthenticated, unauthorized scopes and invalid input before AI", async () => {
  assert.equal((await app.request("/api/ai/task-plan/preview", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status, 401);
  assert.equal((await app.request("/api/ai/task-plan/preview?workspaceId=composer-w", { method: "POST", headers: { ...headers, "X-User-Id": "composer-b" }, body: JSON.stringify({ text: "Plan", timezone: "UTC" }) })).status, 403);
  for (const patch of [{ text: "" }, { text: "x".repeat(12001) }, { maxTasks: 31 }, { timezone: "Not/AZone" }, { projectId: "project-b" }, { contextSources: ["private-note"] }]) assert.ok((await preview(patch)).status >= 400);
  assert.equal(aiRequests.length, 0);
});
test("AI disabled, timeout and provider failures have stable errors without leaking secrets", async () => {
  const settings = await import("../src/services/user-ai-settings.js");
  settings.setUserAISetting("composer-a", "ai_manual_enabled", "false");
  assert.equal((await (await preview()).json()).code, "AI_NOT_CONFIGURED");
  settings.setUserAISetting("composer-a", "ai_manual_enabled", "true");
  globalThis.fetch = (async () => { throw new DOMException("test-key", "TimeoutError"); }) as typeof fetch;
  assert.equal((await (await preview()).json()).code, "AI_TIMEOUT");
  globalThis.fetch = (async () => { throw new Error("test-key"); }) as typeof fetch;
  const data = await (await preview()).json(); assert.equal(data.code, "AI_REQUEST_FAILED"); assert.ok(!JSON.stringify(data).includes("test-key"));
});
test("confirmation saves edited fields atomically with activity and change feed", async () => {
  const res = await batch([task("Edited", { description: "Edited description", dueAt: "2026-12-31T09:00", startDate: "2026-12-30T23:00", repeatRule: "daily", repeatEndCount: 14, projectId: "project-a" })]);
  assert.equal(res.status, 201); const data = await res.json(); assert.equal(data.tasks.length, 1);
  const saved = db.prepare("SELECT * FROM tasks").get() as any;
  assert.equal(saved.title, "Edited"); assert.equal(saved.dueAt, "2026-12-31T09:00"); assert.equal(saved.userId, "composer-a"); assert.equal(saved.projectId, "project-a"); assert.equal(saved.repeatEndCount, 14);
  assert.equal(db.prepare("SELECT count(*) AS n FROM task_activity_events WHERE taskId=?").get(saved.id).n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sync_changes_v2 WHERE entityId=?").get(saved.id).n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM automation_events WHERE resourceId=?").get(saved.id).n, 1);
});
test("request retries and repeated previews return the original batch, even after restart", async () => {
  const a = await (await batch([task()])).json();
  const b = await (await batch([task()])).json(); assert.equal(b.replayed, true); assert.equal(a.tasks[0].id, b.tasks[0].id);
  const c = await (await batch([task()], { requestId: "33333333-3333-4333-8333-333333333333" })).json(); assert.equal(c.tasks[0].id, a.tasks[0].id);
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `const routes=require('./src/routes/tasks.ts'); routes.default.request('http://test/ai-batch-create',{method:'POST',headers:${JSON.stringify(headers)},body:${JSON.stringify(JSON.stringify({ requestId: "11111111-1111-4111-8111-111111111111", previewId: "22222222-2222-4222-8222-222222222222", timezone: "Asia/Shanghai", tasks: [task()] }))}}).then(r=>r.json()).then(r=>console.log(JSON.stringify(r)))`], { cwd: path.resolve(__dirname, ".."), env: process.env, encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const restarted = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)!);
  assert.equal(restarted.tasks[0].id, a.tasks[0].id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get().n, 1);
  assert.equal((await batch([task("Changed")])).status, 409);
  assert.equal(db.prepare("SELECT count(*) AS n FROM automation_events WHERE resourceId=?").get(a.tasks[0].id).n, 1);
});
test("parallel confirmations with different IDs do not create exact duplicates", async () => {
  const results = await Promise.all([batch([task()]), batch([task()], { requestId: "44444444-4444-4444-8444-444444444444", previewId: "55555555-5555-4555-8555-555555555555" })]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get().n, 1);
});
test("replay never returns task content that has left the authorized batch scope", async () => {
  const result = await (await batch([task()])).json();
  db.prepare("UPDATE tasks SET userId='composer-b',title='Other account content' WHERE id=?").run(result.tasks[0].id);
  const replay = await (await batch([task()])).json();
  assert.equal(replay.replayed, true); assert.deepEqual(replay.tasks, []);
  assert.ok(!JSON.stringify(replay).includes("Other account content"));
});
test("duplicate overrides are explicit and distinct dates are allowed", async () => {
  await batch([task()]);
  const ids = { requestId: "66666666-6666-4666-8666-666666666666", previewId: "77777777-7777-4777-8777-777777777777" };
  assert.equal((await batch([task()], ids)).status, 409);
  assert.equal((await batch([task("Review report", { allowDuplicate: true })], ids)).status, 201);
  assert.equal((await batch([task("Review report", { dueDate: "2027-01-01" })], { requestId: "88888888-8888-4888-8888-888888888888", previewId: "99999999-9999-4999-8999-999999999999" })).status, 201);
});
test("invalid items, scope forgery, projects and database failures leave no partial writes", async () => {
  for (const patch of [{ dueDate: "2026-02-30" }, { startDate: "2027-01-01" }, { dueAt: "2026-12-31T09:00Z" }, { repeatRule: "daily", dueDate: null }, { repeatInterval: 0 }, { projectId: "project-b" }, { userId: "composer-b" }]) {
    assert.ok((await batch([task("Good"), task("Bad", { clientId: "draft-2", ...patch })])).status >= 400);
    assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get().n, 0);
  }
  assert.equal((await batch([task()], { workspaceId: "composer-w" })).status, 400);
  db.exec("CREATE TRIGGER composer_fail BEFORE INSERT ON tasks WHEN NEW.title='Bad' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  assert.equal((await batch([task("Good"), task("Bad", { clientId: "draft-2" })])).status, 500);
  db.exec("DROP TRIGGER composer_fail");
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM task_composer_batches").get().n, 0);
});

test("API tokens cannot invoke the composer or batch-create, including unrestricted tokens", async () => {
  const tokenHeaders = { ...headers, "X-Auth-Mode": "api-token", "X-Api-Token-Id": "test-token", "X-Api-Resource-Mode": "unrestricted", "X-Api-Scopes": "tasks:read,tasks:write" };
  for (const endpoint of ["/api/ai/task-plan/preview", "/api/tasks/ai-batch-create"]) {
    assert.equal((await app.request(endpoint, { method: "POST", headers: tokenHeaders, body: JSON.stringify({ text: "Plan", timezone: "UTC" }) })).status, 403);
  }
  assert.equal(aiRequests.length, 0);
});
test("workspace batches retain workspace ownership and disabled features deny both endpoints", async () => {
  assert.equal((await batch([task()], {}, "composer-w")).status, 201);
  assert.equal(db.prepare("SELECT workspaceId FROM tasks").get().workspaceId, "composer-w");
  const res = await app.request("/api/tasks/ai-batch-create?workspaceId=composer-w", { method: "POST", headers: { ...headers, "X-User-Id": "composer-b" }, body: "{}" }); assert.equal(res.status, 403);
  db.prepare("UPDATE workspaces SET enabledFeatures=? WHERE id='composer-w'").run(JSON.stringify({ tasks: false }));
  for (const endpoint of ["/api/ai/task-plan/preview", "/api/tasks/ai-batch-create"]) assert.equal((await app.request(endpoint + "?workspaceId=composer-w", { method: "POST", headers, body: "{}" })).status, 403);
  db.prepare("UPDATE workspaces SET enabledFeatures='' WHERE id='composer-w'").run();
});
test("request size limits and cancelled upstream generation are enforced", async () => {
  assert.equal((await preview({ text: "x".repeat(65000) })).status, 413);
  assert.equal((await batch([task("Long", { description: "x".repeat(260000) })])).status, 413);
  const controller = new AbortController();
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
    controller.abort();
  })) as typeof fetch;
  const response = await app.request(new Request("http://test/api/ai/task-plan/preview", { method: "POST", headers, body: JSON.stringify({ text: "Plan", timezone: "UTC" }), signal: controller.signal }));
  assert.equal((await response.json()).code, "AI_CANCELLED");
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get().n, 0);
});
