import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import JSZip from "jszip";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-plugin-routes-test-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "plugin-routes.test.db");
process.env.ELECTRON_USER_DATA = path.join(root, "data");

const ADMIN = "plugin-admin";
const USER = "plugin-user";

async function createPackage(): Promise<File> {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({
    id: "com.example.route-test", name: "Route Test", description: "route e2e", version: "1.0.0",
    apiVersion: 1, engines: { nowen: ">=1.5.0 <2.0.0" }, runtime: "node-action", main: "dist/index.mjs",
    permissions: ["notes:write"], actions: [
      { id: "hello", name: "Hello", input: { name: { type: "string", required: true } } },
      { id: "create-note", name: "Create Note", input: { notebookId: { type: "string", required: true }, title: { type: "string", required: true } } },
    ],
  }));
  zip.file("dist/index.mjs", "export default {actions:{hello:async({input})=>({text:`Hello ${input.name}`}),'create-note':async({input,nowen})=>nowen.notes.create(input)}};");
  return new File([await zip.generateAsync({ type: "uint8array" })], "route-test.nowen-plugin", { type: "application/zip" });
}

test("admin lifecycle and ordinary-user boundaries work end to end", async () => {
  const [{ Hono }, { getDb, closeDb }, { default: router }] = await Promise.all([
    import("hono"), import("../src/db/schema"), import("../src/routes/plugins"),
  ]);
  const db = getDb();
  const passwordHash = "not-used";
  db.prepare("INSERT INTO users(id,username,passwordHash,role,createdAt,updatedAt) VALUES (?,?,?,?,?,?)")
    .run(ADMIN, "plugin-admin", passwordHash, "admin", new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO users(id,username,passwordHash,role,createdAt,updatedAt) VALUES (?,?,?,?,?,?)")
    .run(USER, "plugin-user", passwordHash, "user", new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO workspaces(id,name,ownerId) VALUES ('plugin-ws','Plugin Workspace',?)").run(ADMIN);
  db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES ('plugin-ws',?,'owner')").run(ADMIN);
  db.prepare("INSERT INTO workspace_members(workspaceId,userId,role) VALUES ('plugin-ws',?,'viewer')").run(USER);
  db.prepare("INSERT INTO notebooks(id,userId,name,workspaceId) VALUES ('plugin-notebook',?,'Plugin Notebook','plugin-ws')").run(ADMIN);
  const app = new Hono();
  app.route("/plugins", router);

  const forbiddenInstall = await app.request("/plugins/install", { method: "POST", headers: { "X-User-Id": USER } });
  assert.equal(forbiddenInstall.status, 403);
  const forbiddenDelete = await app.request("/plugins/com.example.route-test", { method: "DELETE", headers: { "X-User-Id": USER } });
  assert.equal(forbiddenDelete.status, 403);

  const form = new FormData();
  form.append("file", await createPackage());
  const installedResponse = await app.request("/plugins/install", { method: "POST", headers: { "X-User-Id": ADMIN }, body: form });
  if (installedResponse.status !== 201) assert.fail(await installedResponse.text());
  const installed = await installedResponse.json() as any;
  assert.equal(installed.plugin.status, "quarantined");

  const grant = await app.request("/plugins/com.example.route-test/permissions", { method: "PUT", headers: { "X-User-Id": ADMIN, "Content-Type": "application/json" }, body: JSON.stringify({ granted: ["notes:write"] }) });
  assert.equal(grant.status, 200);
  const enable = await app.request("/plugins/com.example.route-test/enable", { method: "POST", headers: { "X-User-Id": ADMIN } });
  if (enable.status !== 200) assert.fail(await enable.text());

  const actions = await app.request("/plugins/actions", { headers: { "X-User-Id": USER } });
  assert.deepEqual((await actions.json() as any[]).map((item) => `${item.pluginId}/${item.actionId}`), ["com.example.route-test/hello", "com.example.route-test/create-note"]);
  const execute = await app.request("/plugins/com.example.route-test/actions/hello/execute", { method: "POST", headers: { "X-User-Id": USER, "Content-Type": "application/json" }, body: JSON.stringify({ input: { name: "Nowen" } }) });
  if (execute.status !== 200) assert.fail(await execute.text());
  const result = await execute.json() as any;
  assert.equal(result.data.text, "Hello Nowen");
  assert.ok(result.executionId);

  const viewerWrite = await app.request("/plugins/com.example.route-test/actions/create-note/execute", { method: "POST", headers: { "X-User-Id": USER, "Content-Type": "application/json" }, body: JSON.stringify({ input: { notebookId: "plugin-notebook", title: "Denied" } }) });
  assert.equal(viewerWrite.status, 403);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notes WHERE title='Denied'").get() as { count: number }).count, 0);

  db.prepare("UPDATE workspace_members SET role='editor' WHERE workspaceId='plugin-ws' AND userId=?").run(USER);
  const editorWrite = await app.request("/plugins/com.example.route-test/actions/create-note/execute", { method: "POST", headers: { "X-User-Id": USER, "Content-Type": "application/json" }, body: JSON.stringify({ input: { notebookId: "plugin-notebook", title: "Created by Plugin" } }) });
  if (editorWrite.status !== 200) assert.fail(await editorWrite.text());
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notes WHERE title='Created by Plugin' AND userId=?").get(USER) as { count: number }).count, 1);

  await app.request("/plugins/com.example.route-test/disable", { method: "POST", headers: { "X-User-Id": ADMIN } });
  closeDb();
});

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may still release a worker handle */ }
});
