import assert from "node:assert/strict";
import test from "node:test";
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { extractArticle, importArticleUrl } from "../src/services/article-import.js";
import { securePublicFetch } from "../src/plugins/secureRegistryFetch.js";
import { getDb, closeDb } from "../src/db/schema.js";
import { HostApiBroker } from "../src/plugins/hostApiBroker.js";
import { PluginRegistry } from "../src/plugins/registry.js";
import { PluginPermissions } from "../src/plugins/permissions.js";
import { parsePluginManifest } from "../src/plugins/manifest.js";

test.after(() => closeDb());
test.afterEach(() => test.mock.restoreAll());
const html = `<html><head><title>Public article</title></head><body><article><h1>Public article</h1><p>${"Readable article text. ".repeat(50)}</p><img src="/photo.png" onerror="alert(1)"><script>evil()</script><a href="javascript:evil()">link</a></article></body></html>`;

function transport(responses: Array<{ status?: number; body?: string | Buffer; headers?: Record<string, string> }>) {
  test.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }] as any);
  const requests: Array<{ url: string; options: any }> = [];
  test.mock.method(https, "request", ((url: URL, options: any, callback: any) => {
    requests.push({ url: url.href, options });
    const fixture = responses.shift()!;
    const outgoing = new EventEmitter() as any;
    outgoing.end = () => queueMicrotask(() => {
      const incoming = Readable.from([Buffer.from(fixture.body ?? "")]) as any;
      incoming.statusCode = fixture.status ?? 200;
      incoming.headers = fixture.headers ?? { "content-type": "text/html" };
      callback(incoming);
    });
    outgoing.destroy = (error: Error) => outgoing.emit("error", error);
    return outgoing;
  }) as any);
  return requests;
}

test("generic Readability and WeChat extraction remove executable markup and resolve images", () => {
  const result = extractArticle(html, "https://example.com/path");
  assert.equal(result.title, "Public article");
  assert.match(result.content, /https:\/\/example.com\/photo.png/);
  assert.doesNotMatch(result.content, /evil|onerror|javascript:/);
  const wechat = extractArticle('<h1 id="activity-name">微信标题</h1><div id="js_content"><div><p>微信正文</p></div><img data-src="https://mmbiz.qpic.cn/a.png"></div>', "https://mp.weixin.qq.com/s/123");
  assert.equal(wechat.title, "微信标题");
  assert.match(wechat.content, /微信正文/);
  assert.match(wechat.content, /src="https:\/\/mmbiz/);
});

test("WeChat verification and unavailable pages never fall back to generic article extraction", () => {
  const verification = '<html><body><h1>环境异常</h1><a id="js_verify">去验证</a></body></html>';
  for (const url of ["https://mp.weixin.qq.com/s/public", "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha"]) {
    assert.throws(() => extractArticle(verification, url), (error: any) => error.code === "CAPTURE_EXTRACTION_FAILED" && error.message.includes("完成访问验证"));
  }
  assert.throws(() => extractArticle(html, "https://mp.weixin.qq.com/s/deleted"), { code: "CAPTURE_EXTRACTION_FAILED" });
  assert.throws(() => extractArticle('<script>var selector="js_content";</script>', "https://mp.weixin.qq.com/s/unavailable"), { code: "CAPTURE_EXTRACTION_FAILED" });
});

test("capture transport rejects private addresses and credential/non-HTTPS URLs", async () => {
  for (const url of ["http://example.com", "https://127.0.0.1", "https://[::1]", "https://169.254.169.254", "https://u:p@example.com", "file:///tmp/a"]) await assert.rejects(securePublicFetch(url, 1024), { code: "REGISTRY_URL_DENIED" });
  test.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.2", family: 4 }] as any);
  await assert.rejects(securePublicFetch("https://public.example", 1024), { code: "REGISTRY_URL_DENIED" });
});

test("transport pins DNS to the socket and rechecks every redirect", async () => {
  const requests = transport([{ status: 302, headers: { location: "https://127.0.0.1/private" } }]);
  await assert.rejects(securePublicFetch("https://example.com/article", 1024), { code: "REGISTRY_URL_DENIED" });
  assert.equal(requests.length, 1);
  let pinned: any;
  requests[0].options.lookup("changed.example", {}, (_error: any, address: string) => { pinned = address; });
  assert.equal(pinned, "93.184.216.34");
  assert.equal(requests[0].options.rejectUnauthorized, true);
});

test("transport rejects streamed responses over budget", async () => {
  transport([{ body: "x".repeat(1025) }]);
  await assert.rejects(securePublicFetch("https://example.com/article", 1024), { code: "REGISTRY_PAYLOAD_TOO_LARGE" });
});

test("capture requires permission and destination ACL before any network access", async () => {
  const db = getDb();
  db.prepare("INSERT INTO users(id,username,passwordHash) VALUES ('capture-user','capture-user','unused')").run();
  db.prepare("INSERT INTO users(id,username,passwordHash) VALUES ('other-user','other-user','unused')").run();
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES ('private-book','other-user','Private')").run();
  const context = { executionId: "test", pluginId: "test.capture", actionId: "capture", userId: "capture-user", workspaceId: null };
  await assert.rejects(importArticleUrl(context, { url: "https://example.com", notebookId: "private-book" }), { code: "RESOURCE_FORBIDDEN" });
  const manifest = parsePluginManifest({ id: "test.capture", publisher: "test", name: "Capture", description: "", version: "1.0.0", apiVersion: 2, engines: { nowen: ">=1.5.0" }, categories: ["capture"], repository: "https://example.com/repo", license: "MIT", runtime: "sandbox-js", main: "index.js", permissions: ["capture:write"], actions: [{ id: "capture", name: "Capture" }] });
  new PluginRegistry().upsert({ manifest, source: "package", trustLevel: "community", status: "enabled", checksum: "test", installedPath: "/tmp", installedBy: "capture-user" });
  const permissions = new PluginPermissions(); permissions.initialize(manifest);
  await assert.rejects(new HostApiBroker().call(context, { callId: "test", method: "capture.importUrl", args: { url: "https://example.com", notebookId: "private-book" } }), { code: "PLUGIN_PERMISSION_DENIED" });
});

test("capture uses canonical note/tag writes and stores local images without remote media", async () => {
  const db = getDb();
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES ('capture-book','capture-user','Capture')").run();
  const image = Buffer.from("89504e470d0a1a0a00000000", "hex");
  transport([{ body: html }, { body: image, headers: { "content-type": "image/png" } }]);
  const note = await importArticleUrl({ executionId: "capture", pluginId: "test.capture", actionId: "capture", userId: "capture-user", workspaceId: null }, { url: "https://example.com/article", notebookId: "capture-book", tags: ["微信"], comment: "<script>comment</script>" });
  assert.equal(note.imagesImported, 1);
  const stored = db.prepare("SELECT content,version FROM notes WHERE id=?").get(note.id) as any;
  assert.match(stored.content, /src="\/api\/attachments\//);
  assert.doesNotMatch(stored.content, /src="https:|<script>/);
  assert.match(stored.content, /&lt;script&gt;comment/);
  assert.ok(db.prepare("SELECT id FROM knowledge_tree_nodes WHERE resourceId=?").get(note.id));
  assert.equal((db.prepare("SELECT count(*) n FROM note_tags WHERE noteId=?").get(note.id) as any).n, 1);
});

test("a redirected WeChat verification page writes no note, tree node, tag, or attachment", async () => {
  const db = getDb(), count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  const tables = ["notes", "knowledge_tree_nodes", "tags", "attachments"];
  const before = tables.map(count);
  transport([
    { status: 302, headers: { location: "/mp/wappoc_appmsgcaptcha?challenge=private-challenge" } },
    { body: '<html><body><div id="tips">环境异常</div><a id="js_verify">去验证</a></body></html>' },
  ]);
  await assert.rejects(importArticleUrl({ executionId: "capture-verification", pluginId: "test.capture", actionId: "capture", userId: "capture-user", workspaceId: null }, { url: "https://mp.weixin.qq.com/s/public", notebookId: "capture-book", tags: ["verification-not-imported"] }), (error: any) => error.code === "CAPTURE_EXTRACTION_FAILED" && error.message.includes("完成访问验证") && !error.message.includes("private-challenge"));
  assert.deepEqual(tables.map(count), before);
});
