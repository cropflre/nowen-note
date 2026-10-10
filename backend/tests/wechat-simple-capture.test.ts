import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { getDb, closeDb } from "../src/db/schema.js";
import { getPluginService } from "../src/plugins/pluginService.js";
import { parsePluginManifest } from "../src/plugins/manifest.js";
import { WorkflowRunner } from "../src/automation/workflowRunner.js";
import { initAuditTables } from "../src/services/audit.js";
import { createWechatCaptureRouter } from "../src/routes/wechat-capture.js";
const directory = path.resolve("../examples/plugins/wechat-capture");
const manifest = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")));
const app = createWechatCaptureRouter();
const request = (url: string, method = "GET", body?: unknown, user = "simple-alice") => app.request(url, { method, headers: { "X-User-Id": user, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("parameter-free WeChat capture", async (t) => {
  const db = getDb(); initAuditTables(); const service = getPluginService();
  for (const id of ["simple-alice", "simple-bob"]) db.prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,?,'user')").run(id, id, "unused");
  service.registry.upsert({ manifest, source: "package", trustLevel: "community", status: "enabled", checksum: "simple-fixture", installedPath: directory, installedBy: "simple-alice" });
  db.prepare("UPDATE plugin_registry SET lifecycleState='stable' WHERE id=?").run(manifest.id);
  service.permissions.initialize(manifest); db.prepare("UPDATE plugin_permissions SET granted=1 WHERE pluginId=?").run(manifest.id);
  try {
    await t.test("sandbox plugin needs no Node runtime or connection secrets", async () => {
      assert.equal(manifest.runtime, "sandbox-js"); assert.equal(manifest.connections?.length || 0, 0);
      assert.equal(manifest.actions.length, 1); assert.ok(!manifest.permissions.includes("secrets:use"));
      const status = await (await request("/")).json(); assert.equal(status.pluginReady, true); assert.equal(status.clipboardPrompt, true);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wechat_assistant_profiles").get().n, 0);
    });
    await t.test("clipboard opt-out is per-user and API tokens cannot capture", async () => {
      assert.equal((await request("/preferences", "PUT", { clipboardPrompt: false })).status, 200);
      assert.equal((await (await request("/")).json()).clipboardPrompt, false);
      assert.equal((await (await request("/", "GET", undefined, "simple-bob")).json()).clipboardPrompt, true);
      assert.equal((await app.request("/collect", { method: "POST", headers: { "X-User-Id": "simple-alice", "X-Auth-Mode": "api-token" }, body: JSON.stringify({ text: "https://mp.weixin.qq.com/s/article" }) })).status, 403);
      assert.equal((await app.request("/")).status, 401);
    });
    await t.test("rejects unsupported inputs without creating a destination or jobs", async () => {
      for (const text of ["公众号名称", "https://example.com/article", "https://mp.weixin.qq.com/mp/profile_ext?key=secret"]) assert.equal((await request("/collect", "POST", { text })).status, 400);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wechat_assistant_profiles").get().n, 0);
    });
    await t.test("canonical links queue once and sandbox imports notes without account credentials", async () => {
      test.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }] as any);
      test.mock.method(https, "request", ((_url: URL, _options: any, callback: any) => {
        const outgoing = new EventEmitter() as any;
        outgoing.end = () => queueMicrotask(() => {
          const incoming = Readable.from(['<h1 id="activity-name">测试文章</h1><div id="js_content"><p>微信正文</p></div>']) as any;
          incoming.statusCode = 200; incoming.headers = { "content-type": "text/html" }; callback(incoming);
        }); outgoing.destroy = (error: Error) => outgoing.emit("error", error); return outgoing;
      }) as any);
      const response = await request("/collect", "POST", { text: "https://mp.weixin.qq.com/s/article?key=secret&scene=1" });
      assert.equal(response.status, 200); const batch = await response.json(); assert.equal(batch.accepted, 1);
      assert.equal((await (await request("/collect", "POST", { text: "https://mp.weixin.qq.com/s/article?scene=2" })).json()).duplicates, 1);
      const item = db.prepare("SELECT * FROM wechat_assistant_items WHERE id=?").get(batch.items[0].id) as any;
      assert.equal(item.url, "https://mp.weixin.qq.com/s/article");
      await new WorkflowRunner().run(item.runId);
      const run = db.prepare("SELECT status,errorMessage FROM automation_workflow_runs WHERE id=?").get(item.runId) as any;
      assert.equal(run.status, "completed", run.errorMessage);
      const status = await (await request("/")).json(); assert.ok(status.items[0].note, JSON.stringify(db.prepare("SELECT outputPreview FROM automation_workflow_steps WHERE runId=?").all(item.runId))); assert.equal(status.items[0].note.title, "测试文章");
      assert.equal((await (await request("/collect", "POST", { text: "https://mp.weixin.qq.com/s/article" })).json()).duplicates, 1);
      assert.equal((await (await request("/", "GET", undefined, "simple-bob")).json()).items.length, 0);
      test.mock.restoreAll();
    });
    await t.test("disable and permission revocation stop clipboard readiness and capture", async () => {
      db.prepare("UPDATE plugin_registry SET status='disabled' WHERE id=?").run(manifest.id);
      assert.equal((await (await request("/")).json()).pluginReady, false);
      assert.equal((await request("/collect", "POST", { text: "https://mp.weixin.qq.com/s/other" })).status, 409);
      db.prepare("UPDATE plugin_registry SET status='enabled' WHERE id=?").run(manifest.id);
      db.prepare("UPDATE plugin_permissions SET granted=0 WHERE pluginId=? AND permission='capture:write'").run(manifest.id);
      assert.equal((await (await request("/")).json()).pluginReady, false);
      assert.notEqual((await request("/collect", "POST", { text: "https://mp.weixin.qq.com/s/other" })).status, 200);
      db.prepare("UPDATE plugin_permissions SET granted=1 WHERE pluginId=? AND permission='capture:write'").run(manifest.id);
      db.prepare("UPDATE plugin_permissions SET granted=0 WHERE pluginId=? AND permission='plugin-storage:write'").run(manifest.id);
      assert.equal((await (await request("/")).json()).pluginReady, false);
    });
  } finally { test.mock.restoreAll(); await service.executions.shutdown(manifest.id); closeDb(); }
});
