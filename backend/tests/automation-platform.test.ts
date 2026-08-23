import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveTemplates } from "../src/automation/templateResolver";
import { evaluateCondition } from "../src/automation/conditionEvaluator";
import { validateWorkflowDefinition } from "../src/automation/workflowValidator";

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-automation-platform-test-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(databaseDirectory, "automation.test.db");
process.env.ELECTRON_USER_DATA = databaseDirectory;

test("controlled templates and conditions cannot execute JavaScript", () => {
  const variables: any = { event: { data: { title: "日报 2026" }, resource: { id: "n1" } }, steps: {}, workflow: { id: "w", name: "W" }, user: { id: "u" }, workspace: { id: null } };
  assert.equal(resolveTemplates("Note {{event.resource.id}}", variables), "Note n1");
  assert.equal(evaluateCondition("日报 2026", "contains", "日报"), true);
  assert.throws(() => validateWorkflowDefinition({ version: 1, trigger: { type: "manual" }, steps: [{ id: "x", type: "transform", output: "{{process.env.JWT_SECRET}}" }] }), /不允许的模板变量/);
});

test("event ledger, dispatch, workflow steps, delay and recovery are durable", async () => {
  const { getDb, closeDb, getDbSchemaVersion } = await import("../src/db/schema");
  const { eventPublisher } = await import("../src/automation/eventPublisher");
  const { WorkflowRepository } = await import("../src/automation/workflowRepository");
  const { automationRuntime } = await import("../src/automation/runtime");
  const db = getDb();
  assert.equal(getDbSchemaVersion(), 96);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'automation_%' ORDER BY name").all() as Array<{ name: string }>;
  assert.deepEqual(tables.map((row) => row.name), ["automation_events", "automation_idempotency", "automation_schedules", "automation_webhooks", "automation_workflow_runs", "automation_workflow_steps", "automation_workflows"]);

  const publisherEventId = crypto.randomUUID();
  eventPublisher.publish({ id: publisherEventId, type: "note.created", userId: "u1", resourceType: "note", resourceId: "n1", data: { title: "日报" } });
  eventPublisher.publish({ id: publisherEventId, type: "note.created", userId: "u1", resourceType: "note", resourceId: "n1", data: { title: "日报" } });
  assert.equal((db.prepare("SELECT COUNT(*) count FROM automation_events WHERE id=?").get(publisherEventId) as any).count, 1);
  assert.throws(() => eventPublisher.publish({ type: "note.updated", userId: "u1", resourceType: "note", resourceId: "n1", depth: 11 }), /递归深度/);

  const repository = new WorkflowRepository();
  const definition = validateWorkflowDefinition({
    version: 1, trigger: { type: "event", event: "note.created" },
    steps: [
      { id: "map", type: "transform", output: { title: "{{event.data.title}}" } },
      { id: "check", type: "condition", if: { left: "{{steps.map.output.title}}", operator: "contains", right: "日报" } },
      { id: "wait", type: "delay", seconds: 1 },
      { id: "finish", type: "stop", reason: "done" },
    ],
  });
  const workflow = repository.create("u1", { name: "Event flow", definition }).workflow;
  repository.setEnabled(workflow.id, true);
  await automationRuntime.tick();
  await automationRuntime.tick();
  await new Promise((resolve) => setTimeout(resolve, 80));
  let run = repository.listRuns(workflow.id)[0];
  assert.equal(run.status, "waiting");
  assert.equal(repository.listSteps(run.id).length, 3);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  await automationRuntime.tick();
  await new Promise((resolve) => setTimeout(resolve, 80));
  run = repository.getRun(run.id)!;
  assert.equal(run.status, "completed");

  const syncEvent = eventPublisher.publish({ type: "note.created", userId: "u1", resourceType: "note", resourceId: "sync-note", source: "sync" });
  await automationRuntime.tick();
  assert.equal(db.prepare("SELECT 1 FROM automation_workflow_runs WHERE workflowId=? AND eventId=?").get(workflow.id, syncEvent.id), undefined);

  db.prepare("UPDATE automation_workflow_runs SET status='running' WHERE id=?").run(run.id);
  const { WorkflowService } = await import("../src/automation/workflowService");
  new WorkflowService(repository);
  assert.equal(repository.getRun(run.id)?.status, "interrupted");
  closeDb();
  fs.rmSync(databaseDirectory, { recursive: true, force: true });
});

test("signed webhook rejects invalid, accepts one request, and blocks replay", async () => {
  const { getDb, closeDb } = await import("../src/db/schema");
  const { WorkflowRepository } = await import("../src/automation/workflowRepository");
  const webhookRouter = (await import("../src/automation/webhookTrigger")).default;
  const repository = new WorkflowRepository();
  const definition = validateWorkflowDefinition({ version: 1, trigger: { type: "webhook", requireSignature: true }, steps: [{ id: "stop", type: "stop" }] });
  const created = repository.create("u-webhook", { name: "Webhook", definition });
  assert.ok(created.webhook?.token && created.webhook.secret);
  repository.setEnabled(created.workflow.id, true);
  const body = JSON.stringify({ hello: "world" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", created.webhook!.secret!).update(`${timestamp}.`).update(body).digest("hex");
  const url = `http://nowen/${created.webhook!.token}`;
  const invalid = await webhookRouter.request(url, { method: "POST", headers: { "content-type": "application/json", "X-Nowen-Timestamp": timestamp, "X-Nowen-Signature": "sha256=00" }, body });
  assert.equal(invalid.status, 401);
  const accepted = await webhookRouter.request(url, { method: "POST", headers: { "content-type": "application/json", "X-Nowen-Timestamp": timestamp, "X-Nowen-Signature": `sha256=${signature}` }, body });
  assert.equal(accepted.status, 202);
  const replay = await webhookRouter.request(url, { method: "POST", headers: { "content-type": "application/json", "X-Nowen-Timestamp": timestamp, "X-Nowen-Signature": `sha256=${signature}` }, body });
  assert.equal(replay.status, 409);
  assert.equal((getDb().prepare("SELECT COUNT(*) count FROM automation_workflow_runs WHERE workflowId=?").get(created.workflow.id) as any).count, 1);
  closeDb();
});
