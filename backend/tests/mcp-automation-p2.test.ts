import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-p2-automation-"));
process.env.DB_PATH = path.join(dir, "automation.db");
test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.DB_PATH; });

test("automation PAT requires scopes and personal ownership, previews and exact revisions", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { initApiTokensTable } = await import("../src/lib/api-tokens.js");
  const { enforceApiTokenAccess } = await import("../src/middleware/api-token-resource-scope.js");
  const { default: router } = await import("../src/routes/automations.js");
  const db = getDb();
  try {
    initApiTokensTable(db);
    db.exec(`
      INSERT INTO users (id,username,passwordHash) VALUES
        ('p2-owner','p2-owner','x'),('p2-other','p2-other','x');
      INSERT INTO api_tokens(id,userId,name,tokenHash,scopes,resourceMode)
        VALUES ('p2-token','p2-owner','Automations','fakehash',
          '["automations:read","automations:write"]','restricted');
    `);
    const app = new Hono();
    app.use("/api/*", async (c, next) => {
      c.req.raw.headers.set("X-Auth-Mode", "api-token");
      c.req.raw.headers.set("X-Api-Token-Id", "p2-token");
      c.req.raw.headers.set("X-Api-Resource-Mode", "restricted");
      c.req.raw.headers.set("X-Api-Scopes", "automations:read,automations:write");
      c.req.raw.headers.set("X-User-Id", "p2-owner");
      await next();
    });
    app.use("/api/*", enforceApiTokenAccess);
    app.route("/api/automations", router);
    const req = (url: string, method = "GET", body: unknown = undefined) =>
      app.request(url, {
        method, headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const definition = { version: 1, trigger: { type: "manual" }, steps: [{ id: "finish", type: "stop", reason: "OK" }] };
    let r = await req("/api/automations", "POST", { name: "Private", workspaceId: "team", definition });
    assert.equal(r.status, 403);
    r = await req("/api/automations", "POST", { name: "Morning", workspaceId: null, definition });
    assert.equal(r.status, 201, await r.clone().text());
    const created: any = await r.json();
    assert.match(created.revision, /^[0-9a-f]{64}$/);
    const id = created.id;
    r = await req(`/api/automations/${id}`, "GET");
    assert.equal(r.status, 200);

    r = await req(`/api/automations/${id}/enable`, "POST", {});
    assert.equal(r.status, 409);
    r = await req(`/api/automations/${id}/enable`, "POST", { expectedRevision: created.revision });
    assert.equal(r.status, 200, await r.clone().text());
    const updated: any = await r.json();
    assert.equal(updated.enabled, true);
    assert.notEqual(updated.revision, created.revision);

    r = await req(`/api/automations/${id}`, "PUT", {
      name: "Stale", workspaceId: null, definition, expectedRevision: created.revision,
    });
    assert.equal(r.status, 409, "stale version must fail");
    r = await req(`/api/automations/${id}/disable`, "POST", { expectedRevision: updated.revision });
    assert.equal(r.status, 200, await r.clone().text());
    const disabled: any = await r.json();

    r = await req(`/api/automations/${id}`, "PUT", {
      name: "Edited", workspaceId: null, definition, expectedRevision: disabled.revision,
    });
    assert.equal(r.status, 200, await r.clone().text());
    const edited: any = await r.json();
    assert.equal(edited.name, "Edited");

    r = await req(`/api/automations/${id}/run`, "POST");
    assert.equal(r.status, 403, "PAT may not directly run workflows");
    r = await req("/api/automations/status");
    assert.equal(r.status, 403);

    r = await req(`/api/automations/${id}`, "DELETE", { expectedRevision: edited.revision });
    assert.equal(r.status, 409, "deleting requires explicit confirmation");
    r = await req(`/api/automations/${id}`, "DELETE", {
      expectedRevision: edited.revision, confirmation: "DELETE_WORKFLOW",
    });
    assert.equal(r.status, 200, await r.clone().text());

    const forbiddenRecord = db.prepare(`INSERT INTO automation_workflows
      (id,name,description,userId,workspaceId,enabled,triggerType,triggerConfigJson,definitionJson,
      ignoreSync,ignoreBulk,createdAt,updatedAt)
      VALUES(?,?,?,?,?,0,'manual',?,?,1,1,?,?)`);
    forbiddenRecord.run("p2-foreign", "Foreign", "", "p2-other", null,
      JSON.stringify(definition.trigger), JSON.stringify(definition), new Date().toISOString(), new Date().toISOString());
    assert.equal((await req("/api/automations/p2-foreign")).status, 403);
    r = await req("/api/automations");
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json() as any[]), [], "personal PAT list must hide other users' automation definitions");
  } finally { closeDb(); }
});
