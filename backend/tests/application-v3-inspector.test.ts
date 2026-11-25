import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema.js";
import { parsePluginManifest } from "../src/plugins/manifest.js";
import { getApplicationV3FeatureFlags } from "../src/plugins/applicationV3.js";
import { getPluginService } from "../src/plugins/pluginService.js";
import router from "../src/routes/plugins.js";
import { exampleDirectory } from "./application-v3-fixture.js";
import { requireHostMethod } from "../src/plugins/hostApiContract.js";

function manifest() {
  const value = JSON.parse(fs.readFileSync(path.join(exampleDirectory, "manifest.json"), "utf8"));
  value.permissions.push("notes:read", "tasks:read", "attachments:read");
  value.contributes.inspectors = [{ id: "resource", title: "Resource inspector", pageId: "home", resourceTypes: ["note", "task", "attachment"] }];
  return value;
}

test("V3 inspectors validate page references, resource permissions and duplicate declarations", () => {
  const value = manifest();
  assert.equal((parsePluginManifest(value) as any).contributes.inspectors[0].id, "resource");
  for (const method of ["notes.inspect", "tasks.inspect", "attachments.inspect"]) {
    assert.throws(() => requireHostMethod(method, 1, "node-action"));
    assert.throws(() => requireHostMethod(method, 2, "sandbox-js"));
    assert.equal(requireHostMethod(method, 3, "sandbox-js").sinceApiVersion, 3);
  }
  for (const change of [
    (v: any) => { v.contributes.inspectors[0].pageId = "missing"; },
    (v: any) => { v.contributes.inspectors[0].resourceTypes = ["note", "note"]; },
    (v: any) => { v.contributes.inspectors[0].resourceTypes = ["database"]; },
    (v: any) => { v.permissions = v.permissions.filter((p: string) => p !== "notes:read"); },
    (v: any) => { v.contributes.inspectors.push(v.contributes.inspectors[0]); },
  ]) {
    const invalid = structuredClone(value); change(invalid); assert.throws(() => parsePluginManifest(invalid));
  }
});

test("V3 inspector sessions bind one ACL-checked resource and revoke on resource or feature changes", async () => {
  const previous = process.env.NOWEN_EXTENSION_V3_INSPECTORS;
  delete process.env.NOWEN_EXTENSION_V3_INSPECTORS;
  assert.equal(getApplicationV3FeatureFlags().inspectors, false);
  process.env.NOWEN_EXTENSION_V3_INSPECTORS = "1";
  const db = getDb(), service = getPluginService(), value = manifest(), id = value.id;
  try {
    for (const actor of ["inspector-owner", "inspector-other"]) db.prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,?,'admin')").run(actor, actor, "hash");
    db.prepare("INSERT INTO notebooks(id,name,userId) VALUES ('inspect-book','Inspector','inspector-owner')").run();
    db.prepare("INSERT INTO notes(id,notebookId,userId,title,content,contentText,contentFormat) VALUES ('inspect-note','inspect-book','inspector-owner','Selected note','secret body','secret body','markdown')").run();
    db.prepare("INSERT INTO tasks(id,userId,title,description) VALUES ('inspect-task','inspector-owner','Selected task','private details')").run();
    db.prepare("INSERT INTO attachments(id,noteId,userId,filename,path,mimeType,size) VALUES ('inspect-file','inspect-note','inspector-owner','test.txt','private/path','text/plain',12)").run();
    const zip = new JSZip(); zip.file("manifest.json", JSON.stringify(value));
    for (const file of Object.keys(value.contributes.uiAssets)) zip.file(file, fs.readFileSync(path.join(exampleDirectory, file)));
    await service.install(await zip.generateAsync({ type: "nodebuffer" }), "inspector-owner");
    service.grantPermissions(id, value.permissions, "inspector-owner"); await service.enable(id);
    const app = new Hono(); app.route("/plugins", router);
    const headers = (user = "inspector-owner") => ({ "X-User-Id": user, Authorization: `Bearer ${user}`, "Content-Type": "application/json" });
    const create = (type = "note", resourceId = "inspect-note", user = "inspector-owner", extra = {}) => app.request(`/plugins/apps/${id}/home/session`, { method: "POST", headers: headers(user), body: JSON.stringify({ platform: "web", inspector: { id: "resource", resource: { type, id: resourceId } }, ...extra }) });
    let sequence = 0;
    const call = (session: any, method = "inspector.getResource", params = {}, user = "inspector-owner") => app.request(`/plugins/app-sessions/${session.instanceId}/call`, { method: "POST", headers: headers(user), body: JSON.stringify({ protocol: "nowen.plugin-ui.v3", kind: "request", pluginId: id, instanceId: session.instanceId, nonce: session.nonce, requestId: `inspect-${++sequence}`, method, params }) });
    const list: any = await (await app.request("/plugins/inspectors?platform=web&resourceType=note", { headers: headers() })).json();
    assert.equal(list.length, 1); assert.equal(list[0].inspectorId, "resource");
    for (const [type, resourceId, title] of [["note", "inspect-note", "Selected note"], ["task", "inspect-task", "Selected task"], ["attachment", "inspect-file", "test.txt"]]) {
      const response = await create(type, resourceId); assert.equal(response.status, 201, await response.clone().text());
      const session: any = await response.json();
      const result: any = await (await call(session)).json();
      assert.equal(result.data.title, title); assert.equal(result.data.id, resourceId);
      assert.ok(!JSON.stringify(result).includes("secret body")); assert.ok(!JSON.stringify(result).includes("private"));
      for (const key of ["content", "contentText", "description", "path", "userId"]) assert.equal(key in result.data, false);
      assert.notEqual((await call(session, "notes.list")).status, 200);
      assert.notEqual((await call(session, "storage.set", { key: "x", value: 1 })).status, 200);
      assert.notEqual((await call(session, "inspector.getResource", { id: "other" })).status, 200);
      const context: any = await (await call(session, "context.get")).json();
      assert.deepEqual(context.data.selection, { type, id: resourceId });
    }
    assert.notEqual((await create("note", "inspect-note", "inspector-other")).status, 201);
    assert.notEqual((await create("task", "inspect-task", "inspector-other")).status, 201);
    assert.notEqual((await create("attachment", "inspect-file", "inspector-other")).status, 201);
    assert.notEqual((await create("note", "missing")).status, 201);
    assert.notEqual((await create("note", "inspect-note", "inspector-owner", { inspector: { id: "foreign", resource: { type: "note", id: "inspect-note" } } })).status, 201);
    db.prepare("INSERT INTO workspaces(id,name,ownerId) VALUES ('inspect-space','Inspector','inspector-owner')").run();
    db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES ('inspect-space','inspector-owner','owner')").run();
    assert.notEqual((await create("note", "inspect-note", "inspector-owner", { workspaceId: "inspect-space" })).status, 201);
    db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES ('inspect-space','inspector-other','viewer')").run();
    db.prepare("INSERT INTO notebooks(id,name,userId,workspaceId) VALUES ('inspect-shared-book','Shared','inspector-owner','inspect-space')").run();
    db.prepare("INSERT INTO notes(id,notebookId,userId,workspaceId,title) VALUES ('inspect-shared-note','inspect-shared-book','inspector-owner','inspect-space','Shared note')").run();
    db.prepare("INSERT INTO tasks(id,userId,workspaceId,title) VALUES ('inspect-shared-task','inspector-owner','inspect-space','Shared task')").run();
    db.prepare("INSERT INTO attachments(id,noteId,userId,workspaceId,filename,path,mimeType,size) VALUES ('inspect-shared-file','inspect-shared-note','inspector-owner','inspect-space','shared.txt','private/path','text/plain',12)").run();
    for (const [type, resourceId] of [["note", "inspect-shared-note"], ["task", "inspect-shared-task"], ["attachment", "inspect-shared-file"]]) {
      const shared = await create(type, resourceId, "inspector-other", { workspaceId: "inspect-space" }); assert.equal(shared.status, 201);
      const session: any = await shared.json();
      assert.equal((await call(session, "inspector.getResource", {}, "inspector-other")).status, 200);
      assert.notEqual((await call(session)).status, 200);
      db.prepare("DELETE FROM workspace_members WHERE workspaceId='inspect-space' AND userId='inspector-other'").run();
      assert.notEqual((await call(session, "context.get", {}, "inspector-other")).status, 200);
      db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES ('inspect-space','inspector-other','viewer')").run();
    }
    const normal: any = await (await app.request(`/plugins/apps/${id}/home/session`, { method: "POST", headers: headers(), body: "{}" })).json();
    assert.notEqual((await call(normal)).status, 200);
    const revoked: any = await (await create()).json();
    db.prepare("UPDATE notes SET isTrashed=1 WHERE id='inspect-note'").run();
    assert.notEqual((await call(revoked)).status, 200);
    db.prepare("UPDATE notes SET isTrashed=0 WHERE id='inspect-note'").run();
    const encrypted = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));
    db.prepare("INSERT INTO notes(id,notebookId,userId,title,content,contentText,contentFormat) VALUES ('inspect-encrypted','inspect-book','inspector-owner','Encrypted',?,'','encrypted-note-v1')").run(JSON.stringify(encrypted.envelope));
    assert.notEqual((await create("note", "inspect-encrypted")).status, 201);
    const grants: any = await (await create()).json();
    service.grantPermissions(id, value.permissions.filter((permission: string) => permission !== "notes:read"), "inspector-owner");
    assert.notEqual((await call(grants)).status, 200);
    service.grantPermissions(id, value.permissions, "inspector-owner");
    const shutdown: any = await (await create()).json();
    process.env.NOWEN_EXTENSION_V3_INSPECTORS = "0";
    assert.notEqual((await call(shutdown, "context.get")).status, 200);
    assert.deepEqual(await (await app.request("/plugins/inspectors?resourceType=note", { headers: headers() })).json(), []);
  } finally {
    if (previous === undefined) delete process.env.NOWEN_EXTENSION_V3_INSPECTORS; else process.env.NOWEN_EXTENSION_V3_INSPECTORS = previous;
    closeDb();
  }
});
