import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sheet-route-"));
process.env.DB_PATH = path.join(dir, "sheet-route.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("sheet route enforces capabilities and optimistic concurrency", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const sheets = (await import("../src/routes/sheets.js")).default;

  closeDatabase = closeDb;
  const db = getDb();
  for (const userId of ["sheet-owner", "sheet-other"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')")
      .run(userId, userId);
  }

  const folder = createKnowledgeChild({
    actorUserId: "sheet-owner",
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "表格目录",
    db,
  });
  const node = createKnowledgeChild({
    actorUserId: "sheet-owner",
    workspaceId: null,
    parentId: folder.id,
    nodeType: "sheet",
    title: "预算清单",
    db,
  });

  const app = new Hono();
  app.route("/api/sheets", sheets);
  const ownerHeaders = { "X-User-Id": "sheet-owner", "Content-Type": "application/json" };

  const first = await app.request(`http://localhost/api/sheets/${node.resourceId}`, {
    headers: ownerHeaders,
  });
  assert.equal(first.status, 200);
  const initial = await first.json() as any;
  assert.equal(initial.title, "预算清单");
  assert.equal(initial.canEdit, true);
  assert.equal(initial.data.rows.length, 20);
  assert.equal(initial.data.columns.length, 8);

  const nextData = {
    ...initial.data,
    cells: { ...initial.data.cells, "r1:c1": "1200", "r2:c1": "350" },
  };
  const save = await app.request(`http://localhost/api/sheets/${node.resourceId}`, {
    method: "PUT",
    headers: ownerHeaders,
    body: JSON.stringify({ data: nextData, expectedUpdatedAt: initial.updatedAt }),
  });
  assert.equal(save.status, 200);
  const saved = await save.json() as any;
  assert.equal(saved.data.cells["r1:c1"], "1200");
  assert.notEqual(saved.updatedAt, initial.updatedAt);

  const stale = await app.request(`http://localhost/api/sheets/${node.resourceId}`, {
    method: "PUT",
    headers: ownerHeaders,
    body: JSON.stringify({
      data: { ...nextData, cells: { "r1:c1": "stale" } },
      expectedUpdatedAt: initial.updatedAt,
    }),
  });
  assert.equal(stale.status, 409);
  const conflict = await stale.json() as any;
  assert.equal(conflict.code, "SHEET_CONFLICT");
  assert.equal(conflict.currentUpdatedAt, saved.updatedAt);

  const forbiddenRead = await app.request(`http://localhost/api/sheets/${node.resourceId}`, {
    headers: { "X-User-Id": "sheet-other" },
  });
  assert.equal(forbiddenRead.status, 403);

  const invalid = await app.request(`http://localhost/api/sheets/${node.resourceId}`, {
    method: "PUT",
    headers: ownerHeaders,
    body: JSON.stringify({
      data: { version: 1, rows: [], columns: [], cells: Array.from({ length: 2 }) },
      expectedUpdatedAt: saved.updatedAt,
    }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as any).code, "INVALID_PAYLOAD");
});
