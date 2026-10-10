import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-apply-local-"));
process.env.DB_PATH = path.join(tempDir, "tree-apply-local.db");
process.env.ELECTRON_USER_DATA = tempDir;

test.after(async () => {
  const { closeDb } = await import("../src/db/schema.js");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("tree snapshot apply restores cross-type positions and tombstones without an outbox echo", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const { prepareKnowledgeTreeSnapshot } = await import("../src/sync/knowledgeTreeSnapshot.js");
  const { applyKnowledgeTreeSnapshotLocal, applyKnowledgeTreeChangesLocal } =
    await import("../src/sync/knowledgeTreeApplyLocal.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();
  const folder = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: null,
    nodeType: "folder", title: "目录", db });
  const note = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: folder.id,
    nodeType: "markdown", title: "笔记", db });
  const noteId = (db.prepare("SELECT resourceId FROM knowledge_tree_nodes WHERE id = ?")
    .get(note.id) as { resourceId: string }).resourceId;
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES ('map', 'owner', '脑图', '{}')").run();
  db.prepare(`INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
    VALUES ('attachment-1', ?, 'owner', '文件.txt', 'text/plain', 3, '/tmp/file')`).run(noteId);
  db.prepare(`INSERT INTO knowledge_tree_nodes
    (id, userId, scopeKey, parentId, nodeType, resourceType, resourceId)
    VALUES ('file:attachment-1', 'owner', 'personal:owner', ?, 'file', 'file', 'attachment-1')`).run(note.id);
  db.prepare("UPDATE knowledge_tree_nodes SET parentId = ?, sortOrder = 7, isExpanded = 0 WHERE id = 'mindmap:map'")
    .run(note.id);
  for (const id of ["mindmap:map", "file:attachment-1", note.id, folder.id]) {
    db.prepare("UPDATE knowledge_tree_nodes SET isDeleted = 1, deletedAt = '2026-09-27' WHERE id = ?").run(id);
  }
  const snapshot = prepareKnowledgeTreeSnapshot(db, "owner", null);

  for (const id of [folder.id, note.id, "file:attachment-1", "mindmap:map"]) {
    db.prepare("UPDATE knowledge_tree_nodes SET isDeleted = 0, deletedAt = NULL WHERE id = ?").run(id);
  }
  db.prepare("UPDATE knowledge_tree_nodes SET parentId = NULL, sortOrder = 0 WHERE id = 'mindmap:map'").run();
  db.prepare("DELETE FROM knowledge_tree_nodes WHERE id = 'file:attachment-1'").run();
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile.js");
  const { ensureDevice } = await import("../src/sync/device.js");
  const { markKnowledgeTreeSyncReady, resetKnowledgeTreeSyncReadiness } =
    await import("../src/sync/knowledgeTreeReadiness.js");
  const profile = createProfile(db, { name: "测试服务", serverUrl: "http://tree-local.test" });
  switchActiveProfile(db, profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus = 'ready' WHERE id = ?").run(profile.id);
  ensureDevice(db, { profileId: profile.id, platform: "test" });
  markKnowledgeTreeSyncReady(db, profile.id, "personal");
  const beforeProbe = (db.prepare("SELECT COUNT(*) AS count FROM sync_outbox").get() as { count: number }).count;
  db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = 55 WHERE id = ?").run(folder.id);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sync_outbox").get() as { count: number }).count,
    beforeProbe + 1, "门禁开启后普通本地修改应进入 Outbox");
  db.prepare("DELETE FROM sync_outbox WHERE entityType = 'knowledge_tree_node'").run();
  const feedBefore = (db.prepare("SELECT COUNT(*) AS count FROM sync_changes_v2").get() as { count: number }).count;
  const outboxBefore = (db.prepare("SELECT COUNT(*) AS count FROM sync_outbox").get() as { count: number }).count;

  applyKnowledgeTreeSnapshotLocal(db, snapshot, { userId: "owner", workspaceId: null });
  const map = db.prepare(`SELECT parentId, sortOrder, isDeleted, isExpanded
    FROM knowledge_tree_nodes WHERE id = 'mindmap:map'`)
    .get() as { parentId: string; sortOrder: number; isDeleted: number; isExpanded: number };
  assert.deepEqual(map, { parentId: note.id, sortOrder: 7, isDeleted: 1, isExpanded: 0 });
  const restoredFolder = db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE id = ?")
    .get(folder.id) as { isDeleted: number };
  const restoredFile = db.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id = 'file:attachment-1'")
    .get() as { parentId: string };
  assert.equal(restoredFolder.isDeleted, 1);
  assert.equal(restoredFile.parentId, note.id);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sync_changes_v2").get() as { count: number }).count, feedBefore);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sync_outbox").get() as { count: number }).count, outboxBefore);
  resetKnowledgeTreeSyncReadiness(db, profile.id, "personal");

  db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = 99 WHERE id = ?").run(folder.id);
  db.prepare("INSERT INTO sync_profiles (id, name, serverUrl) VALUES ('profile', '测试', 'http://sync.test')").run();
  db.prepare(`INSERT INTO sync_outbox
    (id, mutationId, profileId, scopeKey, deviceId, entityType, entityId, operation)
    VALUES ('pending', 'pending', 'profile', 'personal', 'device', 'knowledge_tree_node', 'mindmap:map', 'upsert')`).run();
  assert.throws(() => applyKnowledgeTreeSnapshotLocal(db, snapshot, { userId: "owner", workspaceId: null }),
    (error: { code: string }) => error.code === "VERSION_CONFLICT");
  const afterConflict = db.prepare("SELECT sortOrder FROM knowledge_tree_nodes WHERE id = ?")
    .get(folder.id) as { sortOrder: number };
  assert.equal(afterConflict.sortOrder, 99, "冲突必须回滚整批，不能留下半棵树");
  db.prepare("DELETE FROM sync_outbox WHERE id = 'pending'").run();
  const broken = snapshot.map((item) => item.entityId === "mindmap:map"
    ? { ...item, payload: { ...item.payload, parentId: "note:missing" } } : item);
  assert.throws(() => applyKnowledgeTreeSnapshotLocal(db, broken, { userId: "owner", workspaceId: null }),
    (error: { code: string }) => error.code === "MISSING_DEPENDENCY");
  const afterMissingParent = db.prepare("SELECT sortOrder FROM knowledge_tree_nodes WHERE id = ?")
    .get(folder.id) as { sortOrder: number };
  assert.equal(afterMissingParent.sortOrder, 99);

  const mapSnapshot = snapshot.find((item) => item.entityId === "mindmap:map")!;
  db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = 13, isDeleted = 0 WHERE id = 'mindmap:map'").run();
  const feedBeforeIncrementalRow = db.prepare("SELECT COUNT(*) AS count FROM sync_changes_v2")
    .get() as { count: number };
  applyKnowledgeTreeChangesLocal(db, [{ ...mapSnapshot, operation: "upsert" }],
    { userId: "owner", workspaceId: null });
  const incrementalMap = db.prepare(`SELECT parentId, sortOrder, isDeleted
    FROM knowledge_tree_nodes WHERE id = 'mindmap:map'`)
    .get() as { parentId: string; sortOrder: number; isDeleted: number };
  assert.deepEqual(incrementalMap, { parentId: note.id, sortOrder: 7, isDeleted: 1 },
    "父节点已删除时，保留原父子关系的子节点墓碑仍需能到达本地");
  const feedAfterIncrementalRow = db.prepare("SELECT COUNT(*) AS count FROM sync_changes_v2")
    .get() as { count: number };
  assert.equal(feedAfterIncrementalRow.count, feedBeforeIncrementalRow.count);

  assert.throws(() => applyKnowledgeTreeChangesLocal(db, [{ ...mapSnapshot, operation: "upsert",
    payload: { ...mapSnapshot.payload, parentId: folder.id } }],
    { userId: "owner", workspaceId: null }),
  (error: { code: string }) => error.code === "MISSING_DEPENDENCY",
  "不能把节点移动到已删除的父节点");
  assert.throws(() => applyKnowledgeTreeChangesLocal(db, [{ entityId: note.id, operation: "delete" }],
    { userId: "owner", workspaceId: null }),
  (error: { code: string }) => error.code === "MISSING_DEPENDENCY",
  "子节点尚未处理时不得删除父节点并静默拍平目录");
  assert.ok(db.prepare("SELECT 1 FROM knowledge_tree_nodes WHERE id = ?").get(note.id));
  applyKnowledgeTreeChangesLocal(db, [{ entityId: "file:attachment-1", operation: "delete" }],
    { userId: "owner", workspaceId: null });
  assert.equal(db.prepare("SELECT 1 FROM knowledge_tree_nodes WHERE id = 'file:attachment-1'").get(), undefined);
  applyKnowledgeTreeChangesLocal(db, [
    { entityId: note.id, operation: "delete" },
    { entityId: "mindmap:map", operation: "delete" },
  ], { userId: "owner", workspaceId: null });
  assert.equal(db.prepare("SELECT 1 FROM knowledge_tree_nodes WHERE id = ?").get(note.id), undefined);
  assert.equal(db.prepare("SELECT 1 FROM knowledge_tree_nodes WHERE id = 'mindmap:map'").get(), undefined);
});
