import Database from "better-sqlite3";
import { wechatAssistantQueueColumnsMigration } from "../src/db/wechatAssistantQueueColumnsMigration.js";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema.js";
import { getPluginService } from "../src/plugins/pluginService.js";
import { PluginPackageInstaller } from "../src/plugins/packageInstaller.js";
import { parsePluginManifest } from "../src/plugins/manifest.js";
import { WorkflowRunner } from "../src/automation/workflowRunner.js";
import { initAuditTables } from "../src/services/audit.js";
import { createWechatAssistantCallbackRouter, createWechatAssistantRouter } from "../src/routes/wechat-assistant.js";
import { articleKey, articleLinks, assistantStatus, bindConnection, collectArticles, configureAssistant, createConnection, disconnectAssistant, retryArticle, WECHAT_PLUGIN_ID } from "../src/services/wechatAssistant.js";
const directory = path.resolve("../examples/plugins/wechat-capture");
const manifest = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")));
const token = "assistantToken", appId = "wx-assistant-test", key = crypto.randomBytes(32);
const app = new Hono(); app.route("/api/wechat-assistant", createWechatAssistantCallbackRouter()); app.route("/api/wechat-assistant", createWechatAssistantRouter());
const config = { appId, publicUrl: "https://notes.example.com", token, appSecret: "test-secret", encodingKey: key.toString("base64").replace(/=$/, ""), mode: "encrypted" };
test.before(() => {
  const db = getDb(); initAuditTables();
  for (const id of ["assistant-admin", "alice", "bob"]) db.prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,?,?)").run(id, id, "unused", id === "assistant-admin" ? "admin" : "user");
  const service = getPluginService();
  service.registry.upsert({ manifest, source: "package", trustLevel: "community", status: "enabled", checksum: "assistant-fixture", installedPath: directory, installedBy: "assistant-admin", nodeRuntimeConfirmedBy: "assistant-admin" });
  db.prepare("UPDATE plugin_registry SET lifecycleState='stable' WHERE id=?").run(WECHAT_PLUGIN_ID);
  service.permissions.initialize(manifest); db.prepare("UPDATE plugin_permissions SET granted=1 WHERE pluginId=?").run(WECHAT_PLUGIN_ID);
});
test.afterEach(() => test.mock.restoreAll());
test.after(async () => { await getPluginService().executions.shutdown(WECHAT_PLUGIN_ID); closeDb(); });
function mockArticle(body = '<h1 id="activity-name">文章标题</h1><div id="js_content"><p>文章正文</p></div>') {
  test.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }] as any);
  test.mock.method(https, "request", ((_url: URL, _options: any, callback: any) => {
    const outgoing = new EventEmitter() as any;
    outgoing.end = () => queueMicrotask(() => { const incoming = Readable.from([Buffer.from(body)]) as any; incoming.statusCode = 200; incoming.headers = { "content-type": "text/html" }; callback(incoming); });
    outgoing.destroy = (error: Error) => outgoing.emit("error", error); return outgoing;
  }) as any);
}
async function runItem(id: string) {
  const item = getDb().prepare("SELECT runId FROM wechat_assistant_items WHERE id=?").get(id) as { runId: string };
  await new WorkflowRunner().run(item.runId);
  return getDb().prepare("SELECT status,errorMessage FROM automation_workflow_runs WHERE id=?").get(item.runId) as any;
}
async function qr(userId: string) {
  let scene = "";
  const result = await createConnection(userId, async (url, body) => {
    if (url.includes("/token?")) return { access_token: "test-access-token", expires_in: 7200 };
    assert.ok(url.startsWith("https://api.weixin.qq.com/cgi-bin/qrcode/create?")); scene = (body as any).action_info.scene.scene_str;
    return { ticket: "test-ticket", expire_seconds: 600 };
  }); return { ...result, scene };
}
function encrypt(text: string) {
  const bytes = Buffer.from(text), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const frame = Buffer.concat([crypto.randomBytes(16), length, bytes, Buffer.from(appId)]), padding = 32 - frame.length % 32;
  const cipher = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([frame, Buffer.alloc(padding, padding)])), cipher.final()]).toString("base64");
}
async function callback(xml: string) {
  const value = encrypt(xml), timestamp = String(Math.floor(Date.now() / 1000)), nonce = "test";
  const signature = crypto.createHash("sha1").update([token, timestamp, nonce, value].sort().join("")).digest("hex");
  return app.request(`/api/wechat-assistant/callback?${new URLSearchParams({ timestamp, nonce, msg_signature: signature })}`, { method: "POST", headers: { "X-User-Id": "bob" }, body: `<xml><Encrypt><![CDATA[${value}]]></Encrypt></xml>` });
}
const message = (sender: string, text: string, id: string) => `<xml><FromUserName>${sender}</FromUserName><ToUserName>gh-test</ToUserName><MsgType>text</MsgType><Content><![CDATA[${text}]]></Content><MsgId>${id}</MsgId></xml>`;
const article = (n: number) => `https://mp.weixin.qq.com/s?__biz=publisher&mid=${n}&idx=1`;
test("upgrades an already applied early queue schema without authorizing old jobs", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE wechat_assistant_items (id TEXT PRIMARY KEY); INSERT INTO wechat_assistant_items(id) VALUES ('old')");
    wechatAssistantQueueColumnsMigration.up(db); wechatAssistantQueueColumnsMigration.up(db);
    const row = db.prepare("SELECT openId,tokenVersion FROM wechat_assistant_items WHERE id='old'").get() as any;
    assert.equal(row.openId, null); assert.equal(row.tokenVersion, -1);
  } finally { db.close(); }
});
test("unconfigured service shows honest readiness and prohibits non-admin setup", () => {
  assert.equal(assistantStatus("alice").ready, false); assert.equal(assistantStatus("alice").pluginReady, true);
  assert.throws(() => configureAssistant("alice", config), /仅管理员/);
  assert.throws(() => configureAssistant("assistant-admin", { ...config, publicUrl: "http://localhost:5173" }), /HTTPS/);
  const result = configureAssistant("assistant-admin", config); assert.equal(result.callbackUrl, "https://notes.example.com/api/wechat-assistant/callback");
  assert.doesNotMatch(JSON.stringify(result), /test-secret|assistantToken/);
});
test("QR API contract, one-time expiry and owner isolation", async () => {
  const alice = await qr("alice"); assert.equal(alice.qrUrl, "https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=test-ticket");
  assert.equal(bindConnection(alice.scene, "alice-openid"), true); assert.equal(bindConnection(alice.scene, "bob-openid"), false);
  const bob = await qr("bob"); assert.equal(bindConnection(bob.scene, "alice-openid"), false);
  getDb().prepare("UPDATE wechat_assistant_sessions SET expiresAt=0 WHERE userId='bob'").run(); assert.equal(bindConnection(bob.scene, "bob-openid"), false);
  assert.equal(assistantStatus("alice").connected, true); assert.equal(assistantStatus("bob").connected, false);
});
test("extracts multiple links, ignores tracking variations and rejects over-limit/name inputs", async () => {
  assert.equal(articleKey(article(1) + "&scene=1"), articleKey(article(1) + "&scene=99#fragment"));
  assert.equal(articleLinks(`文章：${article(1)}，另一个 ${article(2)}。`).length, 2);
  assert.throws(() => articleLinks(Array.from({ length: 21 }, (_, n) => article(n)).join("\n")), /20/);
  await assert.rejects(collectArticles("alice", "公众号名字"), /文章目录/);
});
test("local full flow creates a personal inbox, queues a batch once, then saves real notes", async () => {
  mockArticle(); const batch = await collectArticles("alice", `${article(1)}\n${article(2)}`);
  assert.equal(batch.accepted, 2); assert.equal((await collectArticles("alice", article(1) + "&scene=5")).duplicates, 1);
  const book = getDb().prepare("SELECT * FROM notebooks WHERE id=?").get(assistantStatus("alice").notebookId) as any;
  assert.equal(book.name, "微信收件箱"); assert.equal(book.workspaceId, null); assert.equal(book.userId, "alice");
  for (const item of batch.items) { const run = await runItem(item.id); assert.equal(run.status, "completed", run.errorMessage); }
  const notes = assistantStatus("alice").items.filter((item) => item.note); assert.equal(notes.length, 2); assert.equal(notes[0].note?.title, "文章标题");
  assert.ok(getDb().prepare("SELECT id FROM knowledge_tree_nodes WHERE resourceId=?").get(notes[0].note!.id));
  assert.equal(assistantStatus("bob").items.length, 0); assert.equal((await collectArticles("alice", article(1))).duplicates, 1);
});
test("callback verification does not wait behind two occupied capture slots", async () => {
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetching = new Promise<void>((resolve) => { started = resolve; });
  test.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }] as any);
  test.mock.method(https, "request", ((_url: URL, _options: any, callback: any) => {
    const outgoing = new EventEmitter() as any;
    outgoing.end = () => { started(); void gate.then(() => { const incoming = Readable.from(['<h1 id="activity-name">并发文章</h1><div id="js_content"><p>正文</p></div>']) as any; incoming.statusCode = 200; incoming.headers = { "content-type": "text/html" }; callback(incoming); }); };
    outgoing.destroy = (error: Error) => outgoing.emit("error", error); return outgoing;
  }) as any);
  const service = getPluginService(), notebookId = assistantStatus("alice").notebookId!;
  const captures = ["lane-1", "lane-2"].map((itemId) => service.execute(WECHAT_PLUGIN_ID, "capture-article", "alice", null, { url: article(99), notebookId, itemId }));
  await fetching; await new Promise((resolve) => setImmediate(resolve));
  const before = Date.now();
  try { const result = await callback(message("unbound-openid", article(99), "9999")); assert.equal(result.status, 200); assert.ok(Date.now() - before < 3000); }
  finally { release(); await Promise.all(captures); }
});
test("deleted notes can be captured again and private queue inputs are never broadcast", async () => {
  const first = assistantStatus("alice").items.find((item) => item.url === article(1))!;
  getDb().prepare("UPDATE notes SET isTrashed=1 WHERE id=?").run(first.note!.id);
  const fresh = await collectArticles("alice", article(1)); assert.equal(fresh.accepted, 1); assert.notEqual(fresh.items[0].id, first.id);
  assert.equal(getDb().prepare("SELECT id FROM automation_events WHERE sourceId='wechat-assistant' AND dispatchState='pending'").get(), undefined);
});
test("expected capture failures do not roll back a probationary plugin", async () => {
  const db = getDb();
  db.prepare("UPDATE plugin_registry SET lifecycleState='probation',probationVersion=version,probationRemaining=5 WHERE id=?").run(WECHAT_PLUGIN_ID);
  test.mock.method(dns, "lookup", async () => [{ address: "198.18.0.87", family: 4 }] as any);
  try {
    await assert.rejects(getPluginService().execute(WECHAT_PLUGIN_ID, "capture-article", "alice", null, { url: "https://github.com/cropflre/nowen-note", itemId: "probation-fetch", notebookId: assistantStatus("alice").notebookId }), { code: "CAPTURE_URL_DENIED" });
    const record = getPluginService().registry.get(WECHAT_PLUGIN_ID)!;
    assert.equal(record.version, "1.1.0"); assert.equal(record.status, "enabled"); assert.equal(record.lifecycleState, "probation");
  } finally { db.prepare("UPDATE plugin_registry SET lifecycleState='stable',probationVersion=NULL,probationRemaining=0 WHERE id=?").run(WECHAT_PLUGIN_ID); }
});
test("explicit re-enable after rollback requires grants and re-enters probation through preflight", async () => {
  const db = getDb(), service = getPluginService();
  // Keep the source fixture in place; the worker still performs real preflight.
  test.mock.method(PluginPackageInstaller.prototype, "moveToInstalled", (record) => record);
  db.prepare("UPDATE plugin_registry SET lifecycleState='disabled',status='disabled',activeOperationId=NULL,probationVersion=NULL,probationRemaining=0 WHERE id=?").run(WECHAT_PLUGIN_ID);
  db.prepare("UPDATE plugin_permissions SET granted=0 WHERE pluginId=?").run(WECHAT_PLUGIN_ID);
  try {
    await assert.rejects(service.enable(WECHAT_PLUGIN_ID), /必须先确认/);
    assert.equal(service.registry.get(WECHAT_PLUGIN_ID)!.lifecycleState, "disabled");
    db.prepare("UPDATE plugin_permissions SET granted=1 WHERE pluginId=?").run(WECHAT_PLUGIN_ID);
    await service.enable(WECHAT_PLUGIN_ID);
    const record = service.registry.get(WECHAT_PLUGIN_ID)!;
    assert.equal(record.status, "enabled"); assert.equal(record.lifecycleState, "probation"); assert.equal(record.probationRemaining, 5);
  } finally {
    db.prepare("UPDATE plugin_permissions SET granted=1 WHERE pluginId=?").run(WECHAT_PLUGIN_ID);
    db.prepare("UPDATE plugin_registry SET lifecycleState='stable',status='enabled',probationVersion=NULL,probationRemaining=0 WHERE id=?").run(WECHAT_PLUGIN_ID);
  }
});
test("WeChat verification failures stay visible without creating a note or disabling the plugin", async () => {
  const db = getDb(), before = (db.prepare("SELECT count(*) n FROM notes").get() as { n: number }).n;
  mockArticle('<html><body><div id="tips">环境异常</div><a id="js_verify">去验证</a></body></html>');
  const result = await collectArticles("alice", article(404)), id = result.items[0].id;
  assert.equal((await runItem(id)).status, "failed");
  const item = assistantStatus("alice").items.find((entry) => entry.id === id)!;
  assert.equal(item.note, null); assert.match(item.error!, /完成访问验证/);
  assert.equal((db.prepare("SELECT count(*) n FROM notes").get() as { n: number }).n, before);
  assert.equal(getPluginService().registry.get(WECHAT_PLUGIN_ID)!.status, "enabled");
});

test("failed extraction is visible; only owner can retry, retaining one item", async () => {
  mockArticle("<html><body></body></html>"); const result = await collectArticles("alice", article(3)), id = result.items[0].id;
  assert.equal((await runItem(id)).status, "failed"); assert.match(assistantStatus("alice").items.find((item) => item.id === id)!.error!, /正文/);
  await assert.rejects(retryArticle("bob", id), /不存在/); test.mock.restoreAll(); mockArticle();
  await retryArticle("alice", id); assert.equal((await runItem(id)).status, "completed");
  assert.equal(assistantStatus("alice").items.filter((item) => item.id === id).length, 1); await assert.rejects(retryArticle("alice", id), /只能重试/);
});
test("signed AES callback binds and queues each URL to sender owner despite spoofed headers", async () => {
  const bob = await qr("bob");
  const bound = await callback(`<xml><FromUserName>bob-openid</FromUserName><ToUserName>gh-test</ToUserName><MsgType>event</MsgType><Event>subscribe</Event><EventKey>qrscene_${bob.scene}</EventKey></xml>`);
  assert.equal(bound.status, 200); assert.match(await bound.text(), /MsgSignature/); assert.equal(assistantStatus("bob").connected, true);
  const xml = message("alice-openid", `${article(4)}\n${article(5)}`, "1001");
  assert.equal((await callback(xml)).status, 200); assert.equal((await callback(xml)).status, 200);
  assert.equal(assistantStatus("alice").items.filter((item) => item.url === article(4) || item.url === article(5)).length, 2); assert.equal(assistantStatus("bob").items.length, 0);
  assert.equal((await callback(message("unbound", article(10), "1002"))).status, 200); assert.equal(assistantStatus("bob").items.length, 0);
  assert.equal((await app.request("/api/wechat-assistant/callback?timestamp=1234567890&nonce=x&signature=wrong")).status, 401);
});
test("disconnect cancels queued captures; old token versions cannot be revived by new submissions", async () => {
  const wechat = await collectArticles("bob", article(6), "bob-openid", "2000"); disconnectAssistant("bob"); assert.equal((await runItem(wechat.items[0].id)).status, "cancelled");
  const old = await collectArticles("bob", article(7)); getDb().prepare("UPDATE users SET tokenVersion=1 WHERE id='bob'").run(); await collectArticles("bob", article(8));
  assert.equal((await runItem(old.items[0].id)).status, "failed"); assert.equal(getDb().prepare("SELECT id FROM notes WHERE userId='bob'").get(), undefined);
});
test("owner scoped HTTP results and configuration protect private data", async () => {
  const bob = await app.request("/api/wechat-assistant", { headers: { "X-User-Id": "bob" } }); assert.equal(bob.status, 200); assert.doesNotMatch(await bob.text(), /alice-openid|assistantToken|test-secret/);
  assert.equal((await app.request("/api/wechat-assistant/configuration", { headers: { "X-User-Id": "bob" } })).status, 403);
});
test("disabled plugin and revoked administrator stop callbacks", async () => {
  getDb().prepare("UPDATE users SET tokenVersion=1 WHERE id='assistant-admin'").run(); assert.equal(assistantStatus("alice").ready, false); assert.equal((await callback(message("alice-openid", article(9), "3000"))).status, 503);
  getDb().prepare("UPDATE users SET tokenVersion=0 WHERE id='assistant-admin'").run(); getDb().prepare("UPDATE plugin_registry SET status='disabled' WHERE id=?").run(WECHAT_PLUGIN_ID);
  assert.equal(assistantStatus("alice").pluginReady, false); assert.equal((await callback(message("alice-openid", article(9), "3001"))).status, 409);
  getDb().prepare("UPDATE plugin_registry SET status='enabled' WHERE id=?").run(WECHAT_PLUGIN_ID);
});
