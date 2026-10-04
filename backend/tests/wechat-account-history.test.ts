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
import { accountMetadata, collectWechatHistory, forgetWechatHistory, identifyWechatAccount, nextWechatHistoryPage, parseHistoryPage, readingCredentials, verifyWechatHistory, wechatArticleUrl } from "../src/services/wechatAccountHistory.js";
import { WECHAT_PLUGIN_ID } from "../src/services/wechatAssistant.js";
import { createWechatAssistantRouter } from "../src/routes/wechat-assistant.js";
const biz = "MzAccount123==", otherBiz = "MzDifferent123==";
const article = (mid: number, owner = biz) => `https://mp.weixin.qq.com/s?${new URLSearchParams({ __biz: owner, mid: String(mid), idx: "1" })}`;
const html = `<a id="js_name">目标公众号</a><div id="js_content">公开正文</div><script>var biz="${biz}";</script>`;
const credentials = `https://mp.weixin.qq.com/mp/profile_ext?${new URLSearchParams({ action: "home", __biz: biz, uin: "reader", key: "private-key", pass_ticket: "private-ticket" })}`;
const entry = (mid: number) => ({ title: `文章 ${mid}`, content_url: article(mid), del_flag: 0 });
const page = (more: boolean, offset: number, mids = [1, 2]) => JSON.stringify({ ret: 0, can_msg_continue: more ? 1 : 0, next_offset: offset, general_msg_list: JSON.stringify({ list: [{ comm_msg_info: { datetime: 1760000000 }, app_msg_ext_info: { ...entry(mids[0]), multi_app_msg_item_list: mids.slice(1).map((mid) => entry(mid)) } }] }) });
test.before(() => {
  const db = getDb();
  for (const id of ["history-alice", "history-bob"]) db.prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,?,'user')").run(id, id, "unused");
  const directory = path.resolve("../examples/plugins/wechat-capture"), manifest = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")));
  const service = getPluginService();
  service.registry.upsert({ manifest, source: "package", trustLevel: "community", status: "enabled", checksum: "history-fixture", installedPath: directory, installedBy: "history-alice", nodeRuntimeConfirmedBy: "history-alice" });
  db.prepare("UPDATE plugin_registry SET lifecycleState='stable' WHERE id=?").run(WECHAT_PLUGIN_ID);
  service.permissions.initialize(manifest); db.prepare("UPDATE plugin_permissions SET granted=1 WHERE pluginId=?").run(WECHAT_PLUGIN_ID);
});
test.afterEach(() => test.mock.restoreAll());
test.after(async () => { await getPluginService().executions.shutdown(WECHAT_PLUGIN_ID); closeDb(); });
const identify = () => identifyWechatAccount("history-alice", article(1), async () => html);
test("article identification requires real metadata, strips credentials and refuses other hosts", () => {
  assert.deepEqual(accountMetadata(html, article(1)), { biz, name: "目标公众号" });
  assert.throws(() => accountMetadata('<title>安全验证</title>', article(1)), { code: "ACCOUNT_UNAVAILABLE" });
  assert.throws(() => wechatArticleUrl("https://localhost/s/foo"), { code: "INVALID_ARTICLE_URL" });
  assert.throws(() => wechatArticleUrl("https://mp.weixin.qq.com/mp/profile_ext"), { code: "INVALID_ARTICLE_URL" });
  assert.doesNotMatch(wechatArticleUrl(article(1) + "&uin=secret&key=secret&scene=1").href, /secret|scene/);
});
test("reader authorization is target scoped, and an ordinary share link is insufficient", () => {
  assert.equal(readingCredentials(credentials, biz).key, "private-key");
  assert.throws(() => readingCredentials(credentials, otherBiz), { code: "INVALID_READ_SESSION" });
  assert.throws(() => readingCredentials(`https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=${biz}`, biz), { code: "READ_SESSION_REQUIRED" });
  assert.throws(() => readingCredentials(credentials, biz, "poc_sid=private\r\nX-Header: injected"), { code: "INVALID_READ_SESSION" });
});
test("parses main and secondary articles; rejects rate limits, malformed successes, and stalled pagination", () => {
  assert.equal(parseHistoryPage(page(true, 10), biz, 0).articles.length, 2);
  assert.equal(parseHistoryPage(page(false, 10), biz, 0).hasMore, false);
  assert.throws(() => parseHistoryPage('{"ret":200013}', biz, 0), { code: "HISTORY_RATE_LIMITED" });
  assert.throws(() => parseHistoryPage('{"ret":0}', biz, 0), { code: "HISTORY_INVALID_RESPONSE" });
  assert.throws(() => parseHistoryPage(page(true, 0), biz, 0), { code: "HISTORY_INVALID_RESPONSE" });
  const mixed = JSON.parse(page(false, 10)); mixed.general_msg_list = { list: [{ app_msg_ext_info: { ...entry(3), content_url: article(3, otherBiz) } }] };
  assert.throws(() => parseHistoryPage(JSON.stringify(mixed), biz, 0), { code: "HISTORY_INVALID_RESPONSE" });
});
test("verification gates collection; a real accepted page enables pagination and durable per-user batches", async () => {
  let time = Date.now(); test.mock.method(Date, "now", () => time);
  const found = await identify();
  await assert.rejects(collectWechatHistory("history-alice", found.id), { code: "READ_SESSION_REQUIRED" });
  const first = await verifyWechatHistory("history-alice", found.id, credentials, async (request) => {
    const url = new URL(request.url); assert.equal(url.hostname, "mp.weixin.qq.com"); assert.equal(url.searchParams.get("__biz"), biz); assert.equal(url.searchParams.get("offset"), "0"); return page(true, 10);
  });
  assert.equal(first.verified, true); assert.equal(first.articles.length, 2); assert.doesNotMatch(JSON.stringify(first), /private-key|private-ticket|reader/);
  await assert.rejects(collectWechatHistory("history-alice", found.id), { code: "HISTORY_INCOMPLETE" });
  await assert.rejects(nextWechatHistoryPage("history-alice", found.id, async () => page(false, 10)), { code: "HISTORY_BUSY" });
  time += 1600;
  const last = await nextWechatHistoryPage("history-alice", found.id, async (request) => { assert.equal(new URL(request.url).searchParams.get("offset"), "10"); return page(false, 10, [2, 3]); });
  assert.equal(last.hasMore, false); assert.equal(last.articles.length, 3);
  const result = await collectWechatHistory("history-alice", found.id); assert.equal(result.accepted, 3);
  assert.equal((await collectWechatHistory("history-alice", found.id)).duplicates, 3);
  const rows = getDb().prepare("SELECT userId,url FROM wechat_assistant_items").all() as any[];
  assert.equal(rows.length, 3); assert.ok(rows.every((row) => row.userId === "history-alice")); assert.doesNotMatch(JSON.stringify(rows), /private-key|private-ticket/);
  const injected = await collectWechatHistory("history-alice", found.id, [article(1) + "&key=private-key"]); assert.equal(injected.duplicates, 1);
});
test("rejected authentication never fabricates a list, and raw upstream errors do not expose secrets", async () => {
  const found = await identify();
  await assert.rejects(verifyWechatHistory("history-alice", found.id, credentials, async () => '{"ret":200003,"errmsg":"private-key"}'), (error: any) => error.code === "READ_SESSION_REJECTED" && !error.message.includes("private-key"));
  await assert.rejects(collectWechatHistory("history-alice", found.id, [article(1)]), { code: "READ_SESSION_REQUIRED" });
});
test("Cookie is host-injected; queue URLs always come from the verified catalogue", async () => {
  const found = await identify();
  await verifyWechatHistory("history-alice", found.id, credentials, async (request) => {
    assert.equal(request.trustedHeaders?.Cookie, "poc_sid=private-cookie"); assert.doesNotMatch(request.url, /private-cookie|Cookie/);
    return page(false, 0, [7, 8]);
  }, "poc_sid=private-cookie");
  const result = await collectWechatHistory("history-alice", found.id, [article(7) + "&key=private-injected"]); assert.equal(result.accepted, 1);
  const row = getDb().prepare("SELECT url FROM wechat_assistant_items WHERE userId=? AND url LIKE '%mid=7%'").get("history-alice") as { url: string };
  assert.equal(row.url, article(7)); assert.doesNotMatch(JSON.stringify(row), /private/);
  await assert.rejects(collectWechatHistory("history-alice", found.id, [article(999)]), { code: "INVALID_SELECTION" });
});
test("sessions and pages cannot cross users; revocation and expiry stop access", async () => {
  let time = Date.now(); test.mock.method(Date, "now", () => time);
  const found = await identify();
  await assert.rejects(nextWechatHistoryPage("history-bob", found.id), { code: "TARGET_NOT_FOUND" });
  const router = createWechatAssistantRouter();
  const response = await router.request(`/accounts/${found.id}/next`, { method: "POST", headers: { "X-User-Id": "history-bob" } }); assert.equal(response.status, 404);
  getDb().prepare("UPDATE users SET tokenVersion=1 WHERE id='history-alice'").run();
  await assert.rejects(nextWechatHistoryPage("history-alice", found.id), { code: "READ_SESSION_EXPIRED" });
  getDb().prepare("UPDATE users SET tokenVersion=0 WHERE id='history-alice'").run();
  const fresh = await identify(); time += 600001;
  await assert.rejects(nextWechatHistoryPage("history-alice", fresh.id), { code: "READ_SESSION_EXPIRED" });
});
test("changing targets deletes old reader sessions, and explicit disconnect forgets the new one", async () => {
  const old = await identify(), fresh = await identify();
  await assert.rejects(nextWechatHistoryPage("history-alice", old.id), { code: "TARGET_NOT_FOUND" });
  forgetWechatHistory("history-alice", fresh.id);
  forgetWechatHistory("history-alice", fresh.id);
  await assert.rejects(nextWechatHistoryPage("history-alice", fresh.id), { code: "TARGET_NOT_FOUND" });
});
test("public article redirects stay on the pinned host; authenticated history redirects are refused", async () => {
  const requests: string[] = [];
  test.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }] as any);
  test.mock.method(https, "request", ((url: URL, _options: any, callback: any) => {
    requests.push(url.pathname);
    const outgoing = new EventEmitter() as any;
    outgoing.end = () => queueMicrotask(() => {
      const redirected = url.pathname === "/s/short" || url.pathname === "/mp/profile_ext";
      const incoming = Readable.from([redirected ? "" : html]) as any;
      incoming.statusCode = redirected ? 302 : 200;
      incoming.headers = { "content-type": "text/html", ...(redirected ? { location: "/s/real" } : {}) };
      callback(incoming);
    });
    outgoing.destroy = (error: Error) => outgoing.emit("error", error); return outgoing;
  }) as any);
  const found = await identifyWechatAccount("history-alice", "https://mp.weixin.qq.com/s/short");
  assert.equal(found.name, "目标公众号"); assert.deepEqual(requests, ["/s/short", "/s/real"]);
  await assert.rejects(verifyWechatHistory("history-alice", found.id, credentials), { code: "HISTORY_UNAVAILABLE" });
  assert.deepEqual(requests, ["/s/short", "/s/real", "/mp/profile_ext"]);
});
