import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-outbox-"));
process.env.DB_PATH = path.join(tempDir, "tree-outbox.db");
process.env.ELECTRON_USER_DATA = tempDir;

test.after(async () => {
  const { closeDb } = await import("../src/db/schema.js");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("tree outbox capture remains gated until the full entity protocol is ready", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile.js");
  const { ensureDevice } = await import("../src/sync/device.js");
  const { markKnowledgeTreeSyncReady } = await import("../src/sync/knowledgeTreeReadiness.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();
  const profile = createProfile(db, { name: "测试服务", serverUrl: "http://tree-sync.test" });
  switchActiveProfile(db, profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus = 'ready' WHERE id = ?").run(profile.id);
  ensureDevice(db, { profileId: profile.id, platform: "test" });

  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('folder', 'owner', '目录')").run();
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES ('map', 'owner', '脑图', '{}')").run();
  const before = db.prepare("SELECT entityType FROM sync_outbox ORDER BY rowid").all() as Array<{ entityType: string }>;
  assert.ok(before.some((row) => row.entityType === "notebook"));
  assert.ok(before.some((row) => row.entityType === "mindmap"));
  assert.ok(before.every((row) => row.entityType !== "knowledge_tree_node"));

  markKnowledgeTreeSyncReady(db, profile.id, "personal");
  db.prepare("DELETE FROM sync_outbox").run();
  db.prepare("UPDATE knowledge_tree_nodes SET parentId = 'notebook:folder', sortOrder = 7 WHERE id = 'mindmap:map'").run();
  const rows = db.prepare(`
    SELECT profileId, scopeKey, deviceId, entityType, entityId, operation, payload
    FROM sync_outbox ORDER BY rowid
  `).all() as Array<Record<string, string>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].profileId, profile.id);
  assert.equal(rows[0].scopeKey, "personal");
  assert.ok(rows[0].deviceId);
  assert.equal(rows[0].entityType, "knowledge_tree_node");
  assert.equal(rows[0].entityId, "mindmap:map");
  assert.equal(rows[0].operation, "upsert");
  const payload = JSON.parse(rows[0].payload);
  assert.equal(payload.parentId, "notebook:folder");
  assert.equal(payload.sortOrder, 7);
  assert.equal(payload.baseParentId, null);
  assert.equal(payload.baseSortOrder, 0);
  assert.equal(payload.resourceType, "mindmap");

  db.prepare("UPDATE knowledge_tree_nodes SET isExpanded = 0, updatedAt = datetime('now') WHERE id = 'mindmap:map'").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sync_outbox").get() as { count: number }).count, 1);
  assert.throws(() => db.transaction(() => {
    db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = 8 WHERE id = 'mindmap:map'").run();
    throw new Error("rollback");
  })(), /rollback/);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sync_outbox").get() as { count: number }).count, 1);

  db.prepare("UPDATE knowledge_tree_nodes SET isDeleted = 1, deletedAt = datetime('now') WHERE id = 'mindmap:map'").run();
  const softDelete = db.prepare("SELECT operation, payload FROM sync_outbox ORDER BY rowid DESC LIMIT 1")
    .get() as { operation: string; payload: string };
  assert.equal(softDelete.operation, "upsert");
  assert.equal(JSON.parse(softDelete.payload).isDeleted, 1);
  db.prepare("DELETE FROM knowledge_tree_nodes WHERE id = 'mindmap:map'").run();
  assert.equal((db.prepare("SELECT operation FROM sync_outbox ORDER BY rowid DESC LIMIT 1").get() as { operation: string }).operation, "delete");

  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: null,
    nodeType: "markdown", title: "根级文档", db });
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM sync_outbox
    WHERE entityId GLOB 'notebook:__nowen_root_documents__:*'
  `).get() as { count: number }).count, 0);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM sync_changes_v2
    WHERE entityId GLOB 'notebook:__nowen_root_documents__:*'
  `).get() as { count: number }).count, 0);

  const pending = db.prepare("SELECT mutationId, entityType, entityId, payload FROM sync_outbox ORDER BY rowid").all();
  const { syncV2KnowledgeTreeOutboxMigration } = await import("../src/db/syncV2KnowledgeTreeOutboxMigration.js");
  const { syncV2KnowledgeTreeScopeReadinessMigration } =
    await import("../src/db/syncV2KnowledgeTreeScopeReadinessMigration.js");
  syncV2KnowledgeTreeOutboxMigration.up(db);
  syncV2KnowledgeTreeScopeReadinessMigration.up(db);
  assert.deepEqual(db.prepare("SELECT mutationId, entityType, entityId, payload FROM sync_outbox ORDER BY rowid").all(), pending,
    "扩展 Outbox 约束时必须保留尚未推送的用户修改");
  assert.equal((db.prepare("SELECT enabled FROM sync_v2_tree_outbox_ready").get() as { enabled: number }).enabled, 1);
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES ('another', 'owner', '新脑图', '{}')").run();
  assert.ok(db.prepare("SELECT 1 FROM sync_outbox WHERE entityType = 'mindmap' AND entityId = 'another'").get(),
    "重建 Outbox 后已有实体仍须被捕获");
});
