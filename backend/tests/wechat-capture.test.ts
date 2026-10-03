import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema.js";
import { getPluginService } from "../src/plugins/pluginService.js";
import { parsePluginManifest } from "../src/plugins/manifest.js";
import { createInboundWebhook } from "../src/plugins/inboundWebhooks.js";
import inboundRouter from "../src/routes/plugin-inbound.js";
import managementRouter from "../src/routes/plugins.js";
import { WorkflowRunner } from "../src/automation/workflowRunner.js";
import { initAuditTables } from "../src/services/audit.js";

const directory = path.resolve("../examples/plugins/wechat-capture");
const raw = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
const manifest = parsePluginManifest(raw);
const userId = "inbound-owner";
const token = "test-wechat-token";
const aesKey = crypto.randomBytes(32);
const appId = "wx-inbound-test";
let callback = "";
const app = new Hono(); app.route("/api/plugin-inbound", inboundRouter); app.route("/api/plugins", managementRouter);

test.before(() => {
  const db = getDb();
  initAuditTables();
  db.prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,?,'admin')").run(userId, userId, "unused");
  db.prepare("INSERT INTO users(id,username,passwordHash) VALUES ('other-inbound','other-inbound','unused')").run();
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES ('inbound-book',?,'Inbox')").run(userId);
  const service = getPluginService();
  service.registry.upsert({ manifest, source: "package", trustLevel: "community", status: "enabled", checksum: "inbound-fixture", installedPath: directory, installedBy: userId, nodeRuntimeConfirmedBy: userId });
  db.prepare("UPDATE plugin_registry SET lifecycleState='stable' WHERE id=?").run(manifest.id);
  service.permissions.initialize(manifest);
  db.prepare("UPDATE plugin_permissions SET granted=1 WHERE pluginId=?").run(manifest.id);
  service.secrets.set(manifest.id, userId, "callback-token", token);
  service.secrets.set(manifest.id, userId, "encoding-key", aesKey.toString("base64").replace(/=$/, ""));
  service.setSettings(manifest.id, userId, { "notebook-id": "inbound-book", tags: "微信", "app-id": appId, mode: "plain" });
  callback = createInboundWebhook(manifest.id, "wechat", userId).path;
});
test.after(async () => { await getPluginService().executions.shutdown(manifest.id); closeDb(); });

function query(encrypted?: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "test-nonce";
  const digest = crypto.createHash("sha1").update([token, timestamp, nonce, ...(encrypted ? [encrypted] : [])].sort().join("")).digest("hex");
  return new URLSearchParams({ timestamp, nonce, [encrypted ? "msg_signature" : "signature"]: digest });
}
function xml(text: string, id = "10001", sender = "openid-test") {
  return `<xml><ToUserName><![CDATA[gh-test]]></ToUserName><FromUserName><![CDATA[${sender}]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${text}]]></Content><MsgId>${id}</MsgId></xml>`;
}
function post(body: string, encrypted?: string) {
  return app.request(callback + "?" + query(encrypted), { method: "POST", headers: { "Content-Type": "text/xml", "X-User-Id": "other-inbound", "Authorization": "untrusted", "Cookie": "untrusted" }, body });
}
function encrypt(text: string, target = appId) {
  const bytes = Buffer.from(text); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const frame = Buffer.concat([crypto.randomBytes(16), length, bytes, Buffer.from(target)]);
  const padding = 32 - frame.length % 32;
  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([frame, Buffer.alloc(padding, padding)])), cipher.final()]).toString("base64");
}

test("inbound manifest validates routes, action references and duplicate methods", () => {
  for (const hook of [{ ...raw.contributes.inboundWebhooks[0], path: "../escape" }, { ...raw.contributes.inboundWebhooks[0], action: "missing" }, { ...raw.contributes.inboundWebhooks[0], methods: ["GET", "GET"] }, { ...raw.contributes.inboundWebhooks[0], maxBodyBytes: 262145 }]) assert.throws(() => parsePluginManifest({ ...raw, contributes: { inboundWebhooks: [hook] } }));
  assert.throws(() => parsePluginManifest({ ...raw, contributes: { inboundWebhooks: [raw.contributes.inboundWebhooks[0], raw.contributes.inboundWebhooks[0]] } }));
});

test("public callback validates signatures and echoes challenges through the real runner", async () => {
  const verified = await app.request(callback + "?" + query() + "&echostr=challenge");
  assert.equal(verified.status, 200); assert.equal(await verified.text(), "challenge");
  assert.equal(verified.headers.get("cache-control"), "no-store");
  const invalid = query(); invalid.set("signature", "wrong");
  assert.equal((await app.request(callback + "?" + invalid)).status, 401);
  assert.equal((await app.request(callback.replace(/[^/]+$/, "x".repeat(43)))).status, 404);
  assert.equal((await app.request(callback, { method: "PUT" })).status, 405);
  assert.equal((await post("x".repeat(131073))).status, 413);
});

test("OpenID must bind with a one-time owner code before capture", async () => {
  assert.match(await (await post(xml("hello"))).text(), /绑定码/);
  assert.equal((getDb().prepare("SELECT count(*) n FROM automation_workflow_runs").get() as any).n, 0);
  const service = getPluginService();
  const codeResult = await service.execute(manifest.id, "bind-code", userId, null, {});
  const code = (codeResult.result as any).text.match(/绑定 ([a-f0-9]+)/)[1];
  assert.match(await (await post(xml("绑定 " + code))).text(), /绑定成功/);
  assert.match(await (await post(xml("绑定 " + code, "10002", "attacker"))).text(), /无效/);
});

test("valid message is durably queued once, then creates a tagged note as URL owner", async () => {
  const before = Date.now();
  const accepted = await post(xml("通过微信公众号保存这条笔记", "20001"));
  assert.equal(accepted.status, 200); assert.equal(await accepted.text(), "success"); assert.ok(Date.now() - before < 3500);
  assert.equal((await post(xml("通过微信公众号保存这条笔记", "20001"))).status, 200);
  const runs = getDb().prepare("SELECT id FROM automation_workflow_runs").all() as Array<{ id: string }>;
  assert.equal(runs.length, 1);
  await new WorkflowRunner().run(runs[0].id);
  const run = getDb().prepare("SELECT status,errorMessage FROM automation_workflow_runs WHERE id=?").get(runs[0].id) as any;
  assert.equal(run.status, "completed", run.errorMessage);
  const notes = getDb().prepare("SELECT id,userId,title FROM notes").all() as any[];
  assert.equal(notes.length, 1); assert.equal(notes[0].userId, userId);
  assert.equal((getDb().prepare("SELECT count(*) n FROM note_tags WHERE noteId=?").get(notes[0].id) as any).n, 1);
  assert.equal((await post(xml("通过微信公众号保存这条笔记", "20001"))).status, 200);
  assert.equal((getDb().prepare("SELECT count(*) n FROM automation_workflow_runs").get() as any).n, 1);
});

test("AES challenges/messages work, enforce AppID and reject plaintext downgrade", async () => {
  getPluginService().setSettings(manifest.id, userId, { mode: "encrypted" });
  const challenge = encrypt("encrypted-challenge");
  const verified = await app.request(callback + "?" + query(challenge) + "&encrypt_type=aes&echostr=" + encodeURIComponent(challenge));
  assert.equal(verified.status, 200); assert.equal(await verified.text(), "encrypted-challenge");
  const ciphertext = encrypt(xml("encrypted message", "30001"));
  const encrypted = await post(`<xml><Encrypt><![CDATA[${ciphertext}]]></Encrypt></xml>`, ciphertext);
  assert.equal(encrypted.status, 200); assert.equal(await encrypted.text(), "success");
  assert.equal((await post(xml("plaintext", "30002"))).status, 401);
  const wrongApp = encrypt(xml("wrong app", "30003"), "wx-other");
  assert.equal((await post(`<xml><Encrypt>${wrongApp}</Encrypt></xml>`, wrongApp)).status, 502);
  const invalidCode = encrypt(xml("绑定 invalid", "30004"));
  const reply = await post(`<xml><Encrypt>${invalidCode}</Encrypt></xml>`, invalidCode);
  assert.equal(reply.status, 200); assert.match(await reply.text(), /<MsgSignature>/);
  getPluginService().setSettings(manifest.id, userId, { mode: "plain" });
});

test("rate limiting, declaration changes, disable and tokenVersion revoke callbacks", async () => {
  const db = getDb();
  db.prepare("UPDATE plugin_inbound_webhooks SET requestsInWindow=60,windowStartedAt=?").run(Date.now());
  assert.equal((await app.request(callback)).status, 429);
  db.prepare("UPDATE plugin_inbound_webhooks SET requestsInWindow=0").run();
  db.prepare("UPDATE users SET tokenVersion=1 WHERE id=?").run(userId);
  assert.equal((await app.request(callback)).status, 404);
  db.prepare("UPDATE users SET tokenVersion=0 WHERE id=?").run(userId);
  db.prepare("UPDATE plugin_registry SET status='disabled' WHERE id=?").run(manifest.id);
  assert.equal((await app.request(callback)).status, 404);
  db.prepare("UPDATE plugin_registry SET status='enabled',manifestJson=? WHERE id=?").run(JSON.stringify({ ...manifest, contributes: { ...manifest.contributes, inboundWebhooks: [] } }), manifest.id);
  assert.equal((await app.request(callback)).status, 404);
  db.prepare("UPDATE plugin_registry SET manifestJson=? WHERE id=?").run(JSON.stringify(manifest), manifest.id);
});

test("management separates owners; rotation and deletion revoke old URLs", async () => {
  const base = `/api/plugins/${manifest.id}/inbound-webhooks`;
  const other = await app.request(base, { headers: { "X-User-Id": "other-inbound" } });
  assert.deepEqual(await other.json(), []);
  await app.request(base + "/wechat", { method: "DELETE", headers: { "X-User-Id": "other-inbound" } });
  assert.equal((await app.request(callback + "?" + query() + "&echostr=ok")).status, 200);
  const rotated = await app.request(base + "/wechat", { method: "POST", headers: { "X-User-Id": userId } });
  assert.equal(rotated.status, 201);
  assert.equal((await app.request(callback)).status, 404);
  callback = (await rotated.json() as any).path;
  assert.equal((await app.request(callback + "?" + query() + "&echostr=ok")).status, 200);
  assert.equal((await app.request(base + "/wechat", { method: "DELETE", headers: { "X-User-Id": userId } })).status, 200);
  assert.equal((await app.request(callback)).status, 404);
});
