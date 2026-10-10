import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-conflict-"));
process.env.DB_PATH = path.join(tempDir, "tree-conflict.db");
process.env.ELECTRON_USER_DATA = tempDir;

test.after(async () => {
  const { closeDb } = await import("../src/db/schema.js");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("tree conflicts preserve both structures and reuse the normal conflict center", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile.js");
  const { ensureDevice } = await import("../src/sync/device.js");
  const { markKnowledgeTreeSyncReady } = await import("../src/sync/knowledgeTreeReadiness.js");
  const { recordConflict, getConflict } = await import("../src/sync/conflict.js");
  const { applyConflictResolution, toConflictDetail } = await import("../src/sync/resolve.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();
  const profile = createProfile(db, { name: "树冲突服务", serverUrl: "http://tree-conflict.test" });
  switchActiveProfile(db, profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus = 'ready' WHERE id = ?").run(profile.id);
  const device = ensureDevice(db, { profileId: profile.id, platform: "test" });
  markKnowledgeTreeSyncReady(db, profile.id);

  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('left', 'owner', '左目录')").run();
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('right', 'owner', '右目录')").run();
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES ('map', 'owner', '脑图', '{}')").run();
  db.prepare("DELETE FROM sync_outbox").run();

  const row = () => db.prepare(`
    SELECT id, userId, workspaceId, parentId, nodeType, resourceType, resourceId,
           sortOrder, isDeleted, deletedAt, createdAt, updatedAt
    FROM knowledge_tree_nodes WHERE id = 'mindmap:map'
  `).get() as Record<string, unknown>;

  const remote = { ...row(), parentId: "notebook:left", sortOrder: 2 };
  const local = { ...row(), parentId: "notebook:right", sortOrder: 8 };

  const keepRemoteId = recordConflict(db, {
    profileId: profile.id,
    entityType: "knowledge_tree_node",
    entityId: "mindmap:map",
    localPayload: local,
    remotePayload: remote,
  });
  const detail = toConflictDetail(getConflict(db, keepRemoteId)!);
  assert.equal(detail.entityType, "knowledge_tree_node");
  assert.ok(detail.diffFields.includes("parentId"));
  assert.ok(detail.diffFields.includes("sortOrder"));

  applyConflictResolution(db, {
    conflictId: keepRemoteId,
    resolution: "keep-remote",
    deviceId: device.id,
    userId: "owner",
  });
  let current = row();
  assert.equal(current.parentId, "notebook:left");
  assert.equal(current.sortOrder, 2);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE entityType = 'knowledge_tree_node'")
      .get() as { count: number }).count,
    0,
    "采用服务器结构不应回推",
  );

  const keepLocal = { ...row(), parentId: "notebook:right", sortOrder: 11 };
  const keepLocalId = recordConflict(db, {
    profileId: profile.id,
    entityType: "knowledge_tree_node",
    entityId: "mindmap:map",
    localPayload: keepLocal,
    remotePayload: remote,
  });
  applyConflictResolution(db, {
    conflictId: keepLocalId,
    resolution: "keep-local",
    deviceId: device.id,
    userId: "owner",
  });

  current = row();
  assert.equal(current.parentId, "notebook:right");
  assert.equal(current.sortOrder, 11);
  const queued = db.prepare(`
    SELECT profileId, entityType, entityId, payload FROM sync_outbox
    WHERE entityType = 'knowledge_tree_node' ORDER BY rowid DESC LIMIT 1
  `).get() as { profileId: string; entityType: string; entityId: string; payload: string };
  assert.equal(queued.profileId, profile.id);
  assert.equal(queued.entityId, "mindmap:map");
  const payload = JSON.parse(queued.payload);
  assert.equal(payload.parentId, "notebook:right");
  assert.equal(payload.sortOrder, 11);
  assert.equal(payload.baseParentId, "notebook:left");
  assert.equal(payload.baseSortOrder, 2);
  assert.equal(payload.baseIsDeleted, remote.isDeleted);
});
