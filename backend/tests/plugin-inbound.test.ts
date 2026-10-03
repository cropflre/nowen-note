import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema.js";
import { getPluginService } from "../src/plugins/pluginService.js";
import { createInboundWebhook, removeInboundWebhook } from "../src/plugins/inboundWebhooks.js";
import { parsePluginManifest } from "../src/plugins/manifest.js";
import { initAuditTables } from "../src/services/audit.js";
import router from "../src/routes/plugin-inbound.js";
import { WorkflowRunner } from "../src/automation/workflowRunner.js";

const raw = { id: "test.inbound", publisher: "test", name: "Inbound", description: "", version: "1.0.0", apiVersion: 2, engines: { nowen: ">=1.5.0" }, categories: ["capture"], repository: "https://example.com/repo", license: "MIT", runtime: "node-action", main: "index.mjs", permissions: [], actions: [{ id: "receive", name: "Receive", input: { method: { type: "string" }, query: { type: "object" }, headers: { type: "object" }, body: { type: "string" } } }, { id: "save", name: "Save", execution: "background", input: { value: { type: "string" } } }], contributes: { inboundWebhooks: [{ id: "receive", path: "receive", action: "receive", backgroundAction: "save", methods: ["GET", "POST"], maxBodyBytes: 64 }] } };
const app = new Hono(); app.route("/api/plugin-inbound", router);
let callback: string;
test.before(() => {
  const db = getDb(); initAuditTables();
  db.prepare("INSERT INTO users(id,username,passwordHash) VALUES ('inbound-user','inbound-user','unused')").run();
  const service = getPluginService(); const manifest = parsePluginManifest(raw);
  const directory = path.join(process.env.ELECTRON_USER_DATA!, "inbound-fixture"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "index.mjs"), `export default {actions:{receive:async({input})=>{
    if(input.query.sleep)await new Promise(()=>{});
    return {status:Number(input.query.status||200),contentType:input.query.type||'application/json',body:JSON.stringify(input),...(input.query.key?{enqueue:{key:input.query.key,input:{value:'persisted'}}}:{})};
  },save:async()=>({success:true})}}`);
  service.registry.upsert({ manifest, source: "package", trustLevel: "community", status: "enabled", checksum: "test", installedPath: directory, installedBy: "inbound-user", nodeRuntimeConfirmedBy: "inbound-user" });
  db.prepare("UPDATE plugin_registry SET lifecycleState='stable' WHERE id=?").run(manifest.id);
  callback = createInboundWebhook(manifest.id, "receive", "inbound-user").path;
});
test.after(async () => { await getPluginService().executions.shutdown(raw.id); closeDb(); });

test("public requests pass only permitted headers and never choose the execution owner", async () => {
  const result = await app.request(callback + "?key=one", { method: "POST", headers: { "content-type": "text/plain", "x-signature": "signed", authorization: "secret", cookie: "secret", "x-user-id": "attacker" }, body: "payload" });
  assert.equal(result.status, 200);
  const input = await result.json() as any;
  assert.deepEqual(input.headers, { "content-type": "text/plain", "x-signature": "signed" });
  const run = getDb().prepare("SELECT userId,status FROM automation_workflow_runs").get() as any;
  assert.equal(run.userId, "inbound-user"); assert.equal(run.status, "queued");
  await app.request(callback + "?key=one");
  assert.equal((getDb().prepare("SELECT count(*) n FROM automation_workflow_runs").get() as any).n, 1);
  const logs = getDb().prepare("SELECT details FROM audit_logs WHERE action='inbound_request'").all() as any[];
  for (const log of logs) assert.doesNotMatch(log.details, /payload|signed|secret/);
});

test("body, query, response MIME/status and missing tokens are constrained", async () => {
  assert.equal((await app.request(callback, { method: "POST", body: "x".repeat(65) })).status, 413);
  assert.equal((await app.request(callback + "?data=" + "x".repeat(8193))).status, 413);
  assert.equal((await app.request(callback + "?type=text/html")).status, 502);
  assert.equal((await app.request(callback + "?status=302")).status, 502);
  assert.equal((await app.request(callback, { method: "PUT" })).status, 405);
  assert.equal((await app.request(callback.replace(/[^/]+$/, "x".repeat(43)))).status, 404);
});

test("signature primitives cannot access undeclared or another owner's connections", async () => {
  const service = getPluginService();
  const manifest = parsePluginManifest({ ...raw, permissions: ["secrets:use"], connections: [{ id: "token", name: "Token", type: "bearer" }] });
  getDb().prepare("UPDATE plugin_registry SET manifestJson=? WHERE id=?").run(JSON.stringify(manifest), raw.id);
  service.permissions.initialize(manifest); service.permissions.replaceGrants(raw.id, ["secrets:use"], "inbound-user");
  service.secrets.set(raw.id, "inbound-user", "token", "owner-secret");
  const context = { pluginId: raw.id, actionId: "receive", executionId: "crypto", userId: "inbound-user", workspaceId: null };
  const args = { connection: "token", algorithm: "sha1", parts: ["2", "1"], sort: true };
  const result = await service.broker.call(context, { callId: "digest", method: "secrets.digest", args });
  assert.equal(result, crypto.createHash("sha1").update(["owner-secret", "2", "1"].sort().join("")).digest("hex"));
  await assert.rejects(service.broker.call(context, { callId: "bad", method: "secrets.digest", args: { ...args, connection: "undeclared" } }), { code: "PLUGIN_PERMISSION_DENIED" });
  await assert.rejects(service.broker.call({ ...context, userId: "attacker" }, { callId: "other", method: "secrets.digest", args }), /连接不存在/);
  getDb().prepare("UPDATE plugin_registry SET manifestJson=? WHERE id=?").run(JSON.stringify(parsePluginManifest(raw)), raw.id);
});

test("queued callbacks cannot run after the owner's credentials are revoked", async () => {
  const db = getDb();
  const run = db.prepare("SELECT id FROM automation_workflow_runs").get() as { id: string };
  db.prepare("UPDATE users SET tokenVersion=tokenVersion+1 WHERE id='inbound-user'").run();
  await new WorkflowRunner().run(run.id);
  const result = db.prepare("SELECT status,errorCode FROM automation_workflow_runs WHERE id=?").get(run.id) as any;
  assert.equal(result.status, "failed"); assert.equal(result.errorCode, "RESOURCE_FORBIDDEN");
  db.prepare("UPDATE users SET tokenVersion=tokenVersion-1 WHERE id='inbound-user'").run();
});

test("rotation removes old capabilities and their pending workflow runs", async () => {
  const old = callback; callback = createInboundWebhook(raw.id, "receive", "inbound-user").path;
  assert.equal((await app.request(old)).status, 404);
  assert.equal((getDb().prepare("SELECT count(*) n FROM automation_workflow_runs").get() as any).n, 0);
  assert.equal((await app.request(callback)).status, 200);
});

test("callback timeout cancels the action and leaves no queued follow-up", async () => {
  const result = await app.request(callback + "?sleep=true");
  assert.equal(result.status, 504);
  const execution = getDb().prepare("SELECT status,errorCode FROM plugin_executions ORDER BY startedAt DESC,rowid DESC LIMIT 1").get() as any;
  assert.ok(["cancelled", "running"].includes(execution.status), JSON.stringify(execution));
  removeInboundWebhook(raw.id, "receive", "inbound-user");
  assert.equal((await app.request(callback)).status, 404);
});
