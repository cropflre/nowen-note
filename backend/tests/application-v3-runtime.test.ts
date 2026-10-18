import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema.js";
import { getPluginService } from "../src/plugins/pluginService.js";
import router, { pluginAppDocumentResponse } from "../src/routes/plugins.js";
import { examplePackage, futureCompatibleFixture, V3_GATES } from "./application-v3-fixture.js";
import { buildAppDocumentV3 } from "../src/plugins/appDocumentV3.js";
import type { PluginManifestV3 } from "../src/plugins/types.js";

test("V3 future-host HTTP lifecycle isolates users, plugins, workspace scopes and revoked credentials", async () => {
  V3_GATES.forEach(key => { process.env[key] = "1"; });
  const db = getDb(), service = getPluginService();
  for (const [id, role] of [["v3-admin", "admin"], ["v3-user", "user"]]) db.prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,?,?)").run(id, id, "hash", role);
  db.prepare("INSERT INTO workspaces(id,name,ownerId) VALUES ('v3-workspace','V3','v3-admin')").run();
  db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES ('v3-workspace','v3-admin','owner'),('v3-workspace','v3-user','viewer')").run();
  // The production installation gate must still reject the real 1.5.x runtime.
  const bytes = await examplePackage();
  await assert.rejects(() => service.install(bytes, "v3-admin"), /当前版本为 1.5.0/);
  futureCompatibleFixture(service);
  const app = new Hono(); app.route("/plugins", router); app.get("/api/plugin-ui-v3/:ticket", pluginAppDocumentResponse);
  const headers = (user = "v3-admin", token = "test-session") => ({ "X-User-Id": user, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  async function request(route: string, body: unknown, user = "v3-admin", token = "test-session") { return app.request(`/plugins/${route}`, { method: "POST", headers: headers(user, token), body: JSON.stringify(body) }); }
  for (const id of ["nowenlab.hello-app", "nowenlab.other-app"]) {
    await service.install(await examplePackage(id), "v3-admin");
    service.grantPermissions(id, ["plugin-storage:read", "plugin-storage:write"], "v3-admin");
    await service.enable(id);
  }
  const create = async (id = "nowenlab.hello-app", workspaceId: string | null = null, user = "v3-admin") => {
    const response = await request(`apps/${id}/home/session`, { platform: "web", workspaceId }, user);
    assert.equal(response.status, 201, await response.clone().text()); return response.json() as Promise<any>;
  };
  let sequence = 0;
  const message = (session: any, method: string, params = {}) => ({ protocol: "nowen.plugin-ui.v3", kind: "request", pluginId: session.pluginId, instanceId: session.instanceId, nonce: session.nonce, requestId: "request-" + ++sequence, method, params });
  const call = (session: any, method: string, params = {}, user = "v3-admin") => request(`app-sessions/${session.instanceId}/call`, message(session, method, params), user);
  const a = await create(), otherUser = await create("nowenlab.hello-app", null, "v3-user"), otherPlugin = await create("nowenlab.other-app");
  assert.equal((await app.request("/api" + a.documentPath)).status, 403);
  const documentResponse = await app.request("/api" + a.documentPath, { headers: { "Sec-Fetch-Dest": "iframe" } });
  assert.equal(documentResponse.status, 200); assert.ok(documentResponse.headers.get("Content-Security-Policy")!.includes("sandbox allow-scripts"));
  const document = await documentResponse.text();
  assert.ok(document.includes("Content-Security-Policy")); assert.ok(document.includes("data:text/javascript;base64,")); assert.ok(!document.includes("test-session"));
  assert.equal((await app.request("/api" + a.documentPath, { headers: { "Sec-Fetch-Dest": "iframe" } })).status, 404);
  assert.equal((await call(a, "storage.set", { key: "message", value: "persisted" })).status, 200);
  assert.equal((await (await call(a, "storage.get", { key: "message" })).json() as any).data, "persisted");
  assert.equal((await (await call(otherUser, "storage.get", { key: "message" }, "v3-user")).json() as any).data, null);
  assert.equal((await (await call(otherPlugin, "storage.get", { key: "message" })).json() as any).data, null);
  assert.notEqual((await call(a, "storage.get", { key: "message", scopeId: "v3-user" })).status, 200);
  assert.notEqual((await call(a, "storage.get", { key: "message" }, "v3-user")).status, 200);
  assert.notEqual((await request(`app-sessions/${a.instanceId}/call`, message(a, "context.get"), "v3-admin", "other-token")).status, 200);
  assert.notEqual((await request(`apps/nowenlab.hello-app/home/session`, { platform: "android" })).status, 201);
  assert.notEqual((await request(`apps/nowenlab.hello-app/home/session`, { workspaceId: "foreign-workspace" })).status, 201);
  assert.notEqual((await call(a, "navigation.open", { target: "https://evil.invalid" })).status, 200);
  assert.notEqual((await call(a, "action.execute", {})).status, 200);
  const shared = await create("nowenlab.hello-app", "v3-workspace"), viewer = await create("nowenlab.hello-app", "v3-workspace", "v3-user");
  await call(shared, "storage.set", { key: "message", value: "workspace only" });
  assert.equal((await (await call(viewer, "storage.get", { key: "message" }, "v3-user")).json() as any).data, "workspace only");
  assert.notEqual((await call(viewer, "storage.set", { key: "message", value: "forbidden" }, "v3-user")).status, 200);
  const replay = message(a, "storage.set", { key: "message", value: "once" });
  assert.equal((await request(`app-sessions/${a.instanceId}/call`, replay)).status, 200);
  assert.equal((await (await request(`app-sessions/${a.instanceId}/call`, replay)).json() as any).code, "PLUGIN_UI_DUPLICATE_REQUEST");
  const controller = new AbortController();
  const events = await app.request(`/plugins/app-sessions/${a.instanceId}/events`, { method: "POST", headers: headers(), body: JSON.stringify({ nonce: a.nonce }), signal: controller.signal });
  const reader = events.body!.getReader(); await reader.read();
  service.grantPermissions(a.pluginId, ["plugin-storage:read"], "v3-admin");
  assert.ok(new TextDecoder().decode((await reader.read()).value).includes("revoked")); await reader.cancel(); controller.abort();
  assert.notEqual((await call(a, "context.get")).status, 200);
  service.grantPermissions(a.pluginId, ["plugin-storage:read", "plugin-storage:write"], "v3-admin");
  const fresh = await create(); await service.disable(a.pluginId);
  assert.notEqual((await call(fresh, "storage.get", { key: "message" })).status, 200);
  await service.enable(a.pluginId); const resumed = await create();
  assert.equal((await (await call(resumed, "storage.get", { key: "message" })).json() as any).data, "once");
  const installed = service.registry.get(a.pluginId)!;
  const asset = path.join(installed.installedPath, "ui/app.js"); const original = fs.readFileSync(asset);
  fs.writeFileSync(asset, "tampered");
  assert.notEqual((await request(`apps/${a.pluginId}/home/session`, {})).status, 201);
  fs.writeFileSync(asset, original);
  const htmlFile = path.join(installed.installedPath, "ui/index.html"), originalHtml = fs.readFileSync(htmlFile);
  for (const source of ["https://evil.invalid/app.js", "//evil.invalid/app.js", "../other.js", "app.js?x=1", "app%2ejs"]) {
    const html = `<script src="${source}"></script>`;
    fs.writeFileSync(htmlFile, html);
    const manifest = JSON.parse(installed.manifestJson) as PluginManifestV3;
    manifest.contributes.uiAssets["ui/index.html"] = "sha256:" + crypto.createHash("sha256").update(html).digest("hex");
    assert.throws(() => buildAppDocumentV3(installed.installedPath, manifest, "ui/index.html", resumed), /资源/);
  }
  fs.writeFileSync(htmlFile, originalHtml);
  await assert.rejects(() => service.uninstall(a.pluginId), (error: any) => error.code === "PLUGIN_DATA_DELETE_CONFIRMATION_REQUIRED");
  assert.ok(db.prepare("SELECT 1 FROM plugin_storage WHERE pluginId=?").get(a.pluginId));
  await service.uninstall(a.pluginId, true);
  assert.equal(db.prepare("SELECT 1 FROM plugin_storage WHERE pluginId=?").get(a.pluginId), undefined);
  assert.notEqual((await call(resumed, "context.get")).status, 200);
  assert.equal((await app.request("/plugins/apps?platform=web").then(response => response.json()) as any[]).some(page => page.pluginId === a.pluginId), false);
  V3_GATES.forEach(key => delete process.env[key]); closeDb();
});
