import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-baseline-"));
process.env.DB_PATH = path.join(tempDir, "tree-baseline.db");
process.env.ELECTRON_USER_DATA = tempDir;

test.after(async () => {
  const { closeDb } = await import("../src/db/schema.js");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("tree baseline binds only after structures converge and accepts a prepared CAS override", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile.js");
  const { ensureDevice } = await import("../src/sync/device.js");
  const { prepareKnowledgeTreeSnapshot } = await import("../src/sync/knowledgeTreeSnapshot.js");
  const { runKnowledgeTreeBaseline } = await import("../src/sync/knowledgeTreeBaseline.js");
  const { isKnowledgeTreeSyncReady } = await import("../src/sync/knowledgeTreeReadiness.js");
  const { listUnresolvedConflicts } = await import("../src/sync/conflict.js");
  const { applyConflictResolution } = await import("../src/sync/resolve.js");
  const { SYNC_V2_NEGOTIATED_ENTITY_TYPES } = await import("../src/sync/types.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();
  const profile = createProfile(db, { name: "树基线", serverUrl: "http://tree-baseline.test" });
  switchActiveProfile(db, profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus = 'ready' WHERE id = ?").run(profile.id);
  const device = ensureDevice(db, { profileId: profile.id, platform: "test" });

  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('left', 'owner', '左目录')").run();
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('right', 'owner', '右目录')").run();
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES ('map', 'owner', '脑图', '{}')").run();
  db.prepare("UPDATE knowledge_tree_nodes SET parentId = 'notebook:right', sortOrder = 9 WHERE id = 'mindmap:map'").run();
  db.prepare("DELETE FROM sync_outbox").run();

  const local = prepareKnowledgeTreeSnapshot(db, "owner", null);
  const remoteTree = local.map((item) => item.entityId === "mindmap:map"
    ? { ...item, payload: { ...item.payload, parentId: "notebook:left", sortOrder: 2 } }
    : item);
  const ackCalls: Array<{ sequence: number; scopeKey: string; entityTypes: readonly string[] }> = [];
  const fakeClient = {
    async snapshot(_cursor: string | null, _sequence: number, _limit: number, scopeKey: string, subscription: any) {
      assert.deepEqual(subscription.entityTypes, SYNC_V2_NEGOTIATED_ENTITY_TYPES);
      assert.equal(subscription.deviceId, device.id);
      return {
        scopeKey,
        accessFingerprint: "personal:owner",
        snapshotSequence: 41,
        hasMore: false,
        nextCursor: null,
        items: remoteTree.map((item) => ({ entityType: "knowledge_tree_node", ...item })),
      };
    },
    async ack(_deviceId: string, sequence: number, scopeKey: string, subscription: any) {
      ackCalls.push({ sequence, scopeKey, entityTypes: subscription.entityTypes });
      return { lastSequence: sequence, accessFingerprint: "personal:owner" };
    },
  };

  const options = {
    db,
    profileId: profile.id,
    deviceId: device.id,
    userId: "owner",
    scopeKey: "personal",
    workspaceId: null,
    client: fakeClient as any,
  };

  const first = await runKnowledgeTreeBaseline(options);
  assert.equal(first.status, "conflict");
  assert.equal(first.conflictCount, 1);
  assert.equal(ackCalls.length, 0);
  assert.equal(isKnowledgeTreeSyncReady(db, profile.id), false);

  const conflict = listUnresolvedConflicts(db, profile.id)
    .find((row) => row.entityType === "knowledge_tree_node" && row.entityId === "mindmap:map");
  assert.ok(conflict);
  applyConflictResolution(db, {
    conflictId: conflict!.id,
    resolution: "keep-local",
    deviceId: device.id,
    userId: "owner",
  });
  assert.equal(listUnresolvedConflicts(db, profile.id).length, 0);
  const queued = db.prepare(`
    SELECT payload FROM sync_outbox
    WHERE profileId = ? AND entityType = 'knowledge_tree_node' AND entityId = 'mindmap:map'
    ORDER BY rowid DESC LIMIT 1
  `).get(profile.id) as { payload: string };
  const payload = JSON.parse(queued.payload);
  assert.equal(payload.baseParentId, "notebook:left");
  assert.equal(payload.baseSortOrder, 2);

  const second = await runKnowledgeTreeBaseline(options);
  assert.equal(second.status, "ready");
  assert.equal(second.snapshotSequence, 41);
  assert.equal(ackCalls.length, 1);
  assert.deepEqual(ackCalls[0].entityTypes, SYNC_V2_NEGOTIATED_ENTITY_TYPES);
  assert.equal(isKnowledgeTreeSyncReady(db, profile.id), true);
});
