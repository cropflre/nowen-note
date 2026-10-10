import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-readiness-"));
process.env.DB_PATH = path.join(tempDir, "tree-readiness.db");
process.env.ELECTRON_USER_DATA = tempDir;

test.after(async () => {
  const { closeDb } = await import("../src/db/schema.js");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("tree Outbox readiness follows the active Profile and is re-locked by reconciliation", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile.js");
  const { ensureDevice } = await import("../src/sync/device.js");
  const {
    isKnowledgeTreeSyncReady,
    markKnowledgeTreeSyncReady,
  } = await import("../src/sync/knowledgeTreeReadiness.js");
  const { resetBootstrap, markSyncNeedsReconcile } = await import("../src/sync/bootstrap.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();

  const first = createProfile(db, { name: "服务 A", serverUrl: "http://tree-a.test" });
  const second = createProfile(db, { name: "服务 B", serverUrl: "http://tree-b.test" });

  const prepareProfile = (profileId: string) => {
    switchActiveProfile(db, profileId);
    db.prepare("UPDATE sync_profiles SET bootstrapStatus = 'ready' WHERE id = ?").run(profileId);
    ensureDevice(db, { profileId, platform: "test" });
  };
  const gate = () => (db.prepare(
    "SELECT enabled FROM sync_v2_tree_outbox_ready",
  ).get() as { enabled: number }).enabled;

  prepareProfile(first.id);
  assert.equal(gate(), 0, "升级后的 Profile 默认必须保持树同步锁定");
  assert.equal(isKnowledgeTreeSyncReady(db, first.id), false);

  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('folder', 'owner', '目录')").run();
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES ('map', 'owner', '脑图', '{}')").run();
  db.prepare("DELETE FROM sync_outbox").run();
  db.prepare("UPDATE knowledge_tree_nodes SET parentId = 'notebook:folder' WHERE id = 'mindmap:map'").run();
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE entityType = 'knowledge_tree_node'")
      .get() as { count: number }).count,
    0,
  );

  markKnowledgeTreeSyncReady(db, first.id);
  assert.equal(isKnowledgeTreeSyncReady(db, first.id), true);
  assert.equal(isKnowledgeTreeSyncReady(db, first.id, "workspace:alpha"), false);
  markKnowledgeTreeSyncReady(db, first.id, "workspace:alpha");
  assert.equal(isKnowledgeTreeSyncReady(db, first.id, "workspace:alpha"), true);
  assert.equal(isKnowledgeTreeSyncReady(db, first.id, "workspace:beta"), false);
  assert.equal(gate(), 1);
  db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = 4 WHERE id = 'mindmap:map'").run();
  const firstMutation = db.prepare(`
    SELECT profileId, entityType, entityId FROM sync_outbox
    WHERE entityType = 'knowledge_tree_node' ORDER BY rowid DESC LIMIT 1
  `).get() as { profileId: string; entityType: string; entityId: string };
  assert.equal(firstMutation.profileId, first.id);
  assert.equal(firstMutation.entityId, "mindmap:map");

  prepareProfile(second.id);
  assert.equal(gate(), 0, "切到尚未建立树基线的 Profile 必须重新锁住");
  db.prepare("DELETE FROM sync_outbox").run();
  db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = 5 WHERE id = 'mindmap:map'").run();
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE entityType = 'knowledge_tree_node'")
      .get() as { count: number }).count,
    0,
  );

  markKnowledgeTreeSyncReady(db, second.id);
  assert.equal(gate(), 1);
  db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = 6 WHERE id = 'mindmap:map'").run();
  assert.equal(
    (db.prepare("SELECT profileId FROM sync_outbox WHERE entityType = 'knowledge_tree_node' ORDER BY rowid DESC LIMIT 1")
      .get() as { profileId: string }).profileId,
    second.id,
  );

  prepareProfile(first.id);
  assert.equal(gate(), 1, "每个 Profile 的树基线状态必须相互独立");
  resetBootstrap(db, first.id);
  assert.equal(isKnowledgeTreeSyncReady(db, first.id), false);
  assert.equal(isKnowledgeTreeSyncReady(db, first.id, "workspace:alpha"), false);
  assert.equal(gate(), 0, "手动重新对账时必须立即关闭该 Profile 的所有树 Outbox");

  db.prepare("UPDATE sync_profiles SET bootstrapStatus = 'ready' WHERE id = ?").run(first.id);
  markKnowledgeTreeSyncReady(db, first.id);
  markKnowledgeTreeSyncReady(db, second.id);
  assert.equal(gate(), 1);
  const resetCount = markSyncNeedsReconcile(db);
  assert.ok(resetCount >= 2);
  assert.equal(isKnowledgeTreeSyncReady(db, first.id), false);
  assert.equal(isKnowledgeTreeSyncReady(db, second.id), false);
  assert.equal(gate(), 0, "备份恢复后所有远端关系都必须重新建立树基线");
});
