import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-mindmap-optimistic-update-"));
process.env.DB_PATH = path.join(tempDir, "mindmap-optimistic-update.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("mind map GET exposes edit capability and optimistic PUT rejects stale embedded saves", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const mindmaps = (await import("../src/routes/mindmaps.js")).default;

  closeDatabase = closeDb;
  const db = getDb();
  const ownerId = "mindmap-owner";
  const mapId = "11111111-1111-4111-8111-111111111111";

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(ownerId, ownerId, "hash");
  db.prepare(
    `INSERT INTO mindmaps (id, userId, workspaceId, title, data, updatedAt)
     VALUES (?, ?, NULL, ?, ?, ?)`,
  ).run(
    mapId,
    ownerId,
    "Embedded map",
    JSON.stringify({ root: { id: "root", text: "v1", children: [] } }),
    "2026-09-24 10:00:00",
  );

  const app = new Hono();
  app.route("/api/mindmaps", mindmaps);

  const headers = { "X-User-Id": ownerId, "Content-Type": "application/json" };
  const getResponse = await app.request(`http://localhost/api/mindmaps/${mapId}`, { headers });
  assert.equal(getResponse.status, 200);
  const initial = await getResponse.json() as any;
  assert.equal(initial.canEdit, true);
  assert.equal(initial.updatedAt, "2026-09-24 10:00:00");

  const firstSave = await app.request(`http://localhost/api/mindmaps/${mapId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      data: JSON.stringify({ root: { id: "root", text: "v2", children: [] } }),
      expectedUpdatedAt: initial.updatedAt,
    }),
  });
  assert.equal(firstSave.status, 200);
  const updated = await firstSave.json() as any;
  assert.equal(updated.canEdit, true);
  assert.notEqual(updated.updatedAt, initial.updatedAt);
  assert.match(updated.updatedAt, /\.\d{3}$/);

  const staleSave = await app.request(`http://localhost/api/mindmaps/${mapId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      data: JSON.stringify({ root: { id: "root", text: "stale overwrite", children: [] } }),
      expectedUpdatedAt: initial.updatedAt,
    }),
  });
  assert.equal(staleSave.status, 409);
  const conflict = await staleSave.json() as any;
  assert.equal(conflict.code, "MINDMAP_CONFLICT");
  assert.equal(conflict.currentUpdatedAt, updated.updatedAt);

  const stored = db.prepare("SELECT data, updatedAt FROM mindmaps WHERE id = ?").get(mapId) as any;
  assert.equal(JSON.parse(stored.data).root.text, "v2");
  assert.equal(stored.updatedAt, updated.updatedAt);
});

test("workspace viewers can read embedded maps but cannot enter the editor", async () => {
  const { Hono } = await import("hono");
  const { getDb } = await import("../src/db/schema.js");
  const mindmaps = (await import("../src/routes/mindmaps.js")).default;

  const db = getDb();
  const ownerId = "workspace-map-owner";
  const viewerId = "workspace-map-viewer";
  const workspaceId = "workspace-map-scope";
  const mapId = "22222222-2222-4222-8222-222222222222";

  for (const userId of [ownerId, viewerId]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
      .run(userId, userId, "hash");
  }
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run(workspaceId, "Mindmap workspace", ownerId);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run(workspaceId, ownerId, "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run(workspaceId, viewerId, "viewer");
  db.prepare(
    `INSERT INTO mindmaps (id, userId, workspaceId, title, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    mapId,
    ownerId,
    workspaceId,
    "Team map",
    JSON.stringify({ root: { id: "root", text: "team", children: [] } }),
  );

  const app = new Hono();
  app.route("/api/mindmaps", mindmaps);

  const response = await app.request(`http://localhost/api/mindmaps/${mapId}`, {
    headers: { "X-User-Id": viewerId },
  });
  assert.equal(response.status, 200);
  const map = await response.json() as any;
  assert.equal(map.canEdit, false);

  const save = await app.request(`http://localhost/api/mindmaps/${mapId}`, {
    method: "PUT",
    headers: { "X-User-Id": viewerId, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "viewer overwrite",
      expectedUpdatedAt: map.updatedAt,
    }),
  });
  assert.equal(save.status, 403);
});
