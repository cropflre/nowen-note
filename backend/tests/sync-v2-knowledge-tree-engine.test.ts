import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-engine-"));
process.env.DB_PATH = path.join(tempDir, "tree-engine.db");
process.env.ELECTRON_USER_DATA = tempDir;

test.after(async () => {
  const { closeDb } = await import("../src/db/schema.js");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("engine upgrades one scope to negotiated tree push and pull only after baseline", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile.js");
  const { ensureDevice } = await import("../src/sync/device.js");
  const { prepareKnowledgeTreeSnapshot } = await import("../src/sync/knowledgeTreeSnapshot.js");
  const { isKnowledgeTreeSyncReady } = await import("../src/sync/knowledgeTreeReadiness.js");
  const { SyncEngine } = await import("../src/sync/engine.js");
  const { SYNC_V2_NEGOTIATED_ENTITY_TYPES } = await import("../src/sync/types.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();
  const profile = createProfile(db, { name: "引擎树同步", serverUrl: "http://tree-engine.test" });
  switchActiveProfile(db, profile.id);
  const device = ensureDevice(db, { profileId: profile.id, platform: "test" });

  // Business resources are established before Bootstrap becomes ready, so no historical Outbox replay.
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('folder', 'owner', '目录')").run();
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES ('map', 'owner', '脑图', '{}')").run();
  db.prepare("UPDATE knowledge_tree_nodes SET parentId = 'notebook:folder', sortOrder = 2 WHERE id = 'mindmap:map'").run();
  db.prepare("DELETE FROM sync_outbox").run();
  db.prepare("UPDATE sync_profiles SET bootstrapStatus = 'ready' WHERE id = ?").run(profile.id);

  let serverSequence = 10;
  let remoteTree = prepareKnowledgeTreeSnapshot(db, "owner", null)
    .map((item) => ({ entityType: "knowledge_tree_node" as const, ...item }));
  const pushCalls: Array<{ entityTypes?: readonly string[]; mutations: any[] }> = [];
  const changesQueue: any[] = [];
  const ackCalls: Array<{ sequence: number; entityTypes?: readonly string[] }> = [];

  const fakeRemote = {
    async listScopes() {
      return [{
        scopeKey: "personal",
        workspaceId: null,
        workspaceName: null,
        role: "owner",
        canWrite: true,
        accessFingerprint: "personal:owner",
      }];
    },
    async snapshot(_cursor: string | null, _sequence: number, _limit: number | undefined,
      scopeKey: string, subscription?: any) {
      if (!subscription) {
        // Initial workspace-scope replan remains legacy; tree is introduced only by Baseline.
        return {
          scopeKey,
          accessFingerprint: "personal:owner",
          snapshotSequence: serverSequence,
          hasMore: false,
          nextCursor: null,
          items: [],
        };
      }
      assert.deepEqual(subscription.entityTypes, SYNC_V2_NEGOTIATED_ENTITY_TYPES);
      assert.equal(subscription.deviceId, device.id);
      return {
        scopeKey,
        accessFingerprint: "personal:owner",
        snapshotSequence: serverSequence,
        hasMore: false,
        nextCursor: null,
        items: remoteTree.map((item) => ({ ...item, payload: { ...item.payload } })),
      };
    },
    async changes(_after: number, _limit: number | undefined, scopeKey: string, subscription?: any) {
      assert.ok(subscription, "Baseline ready 后 Pull 必须显式协商 11 类实体");
      assert.deepEqual(subscription.entityTypes, SYNC_V2_NEGOTIATED_ENTITY_TYPES);
      return changesQueue.shift() || {
        scopeKey,
        accessFingerprint: "personal:owner",
        serverSequence,
        nextSequence: serverSequence,
        hasMore: false,
        resetRequired: false,
        items: [],
      };
    },
    async push(_deviceId: string, mutations: any[], scopeKey: string, subscription?: any) {
      assert.ok(subscription, "Tree Outbox 只能通过 negotiated Push 发送");
      assert.deepEqual(subscription.entityTypes, SYNC_V2_NEGOTIATED_ENTITY_TYPES);
      pushCalls.push({ entityTypes: subscription.entityTypes, mutations });
      for (const mutation of mutations) {
        if (mutation.entityType !== "knowledge_tree_node" || mutation.operation !== "upsert") continue;
        remoteTree = remoteTree.map((item) => item.entityId === mutation.entityId
          ? { ...item, payload: { ...item.payload, ...mutation.payload } }
          : item);
      }
      serverSequence += mutations.length > 0 ? 1 : 0;
      return {
        scopeKey,
        accessFingerprint: "personal:owner",
        serverSequence,
        results: mutations.map((mutation) => ({
          mutationId: mutation.mutationId,
          status: "applied",
        })),
      };
    },
    async ack(_deviceId: string, sequence: number, _scopeKey: string, subscription?: any) {
      ackCalls.push({ sequence, entityTypes: subscription?.entityTypes });
      return { lastSequence: sequence, accessFingerprint: "personal:owner" };
    },
  };

  const engine = new SyncEngine({
    db,
    profileId: profile.id,
    deviceId: device.id,
    userId: "owner",
    client: fakeRemote as any,
    intervalMs: 0,
  });

  await engine.syncOnce();
  assert.equal(isKnowledgeTreeSyncReady(db, profile.id, "personal"), true);
  assert.ok(ackCalls.some((call) =>
    call.entityTypes?.includes("knowledge_tree_node")), "Baseline 必须用 11 类 ACK 绑定");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE entityType = 'knowledge_tree_node'")
      .get() as { count: number }).count,
    0,
  );

  db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = 7 WHERE id = 'mindmap:map'").run();
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE entityType = 'knowledge_tree_node'")
      .get() as { count: number }).count,
    1,
    "Scope ready 后结构修改必须原子进入 Outbox",
  );

  await engine.syncOnce();
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].mutations.length, 1);
  assert.equal(pushCalls[0].mutations[0].entityType, "knowledge_tree_node");
  assert.equal(pushCalls[0].mutations[0].payload.sortOrder, 7);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE entityType = 'knowledge_tree_node'")
      .get() as { count: number }).count,
    0,
  );

  remoteTree = remoteTree.map((item) => item.entityId === "mindmap:map"
    ? { ...item, payload: { ...item.payload, sortOrder: 11 } }
    : item);
  serverSequence += 1;
  changesQueue.push({
    scopeKey: "personal",
    accessFingerprint: "personal:owner",
    serverSequence,
    nextSequence: serverSequence,
    hasMore: false,
    resetRequired: false,
    items: [{
      sequence: serverSequence,
      entityType: "knowledge_tree_node",
      entityId: "mindmap:map",
      operation: "upsert",
    }],
  });

  await engine.syncOnce();
  const local = db.prepare("SELECT sortOrder FROM knowledge_tree_nodes WHERE id = 'mindmap:map'")
    .get() as { sortOrder: number };
  assert.equal(local.sortOrder, 11, "远端结构变更必须通过专用 Tree Apply 回到本机");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE entityType = 'knowledge_tree_node'")
      .get() as { count: number }).count,
    0,
    "Pull/Apply 不得回声写入 Outbox",
  );
});
