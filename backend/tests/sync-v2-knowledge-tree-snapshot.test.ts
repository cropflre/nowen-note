import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-snapshot-"));
process.env.DB_PATH = path.join(tempDir, "tree-snapshot.db");
process.env.ELECTRON_USER_DATA = tempDir;

test.after(async () => {
  const { closeDb } = await import("../src/db/schema.js");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("tree snapshot sends cross-type parents before children and keeps tombstones", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const { prepareKnowledgeTreeSnapshot, knowledgeTreeSnapshotPage } = await import("../src/sync/knowledgeTreeSnapshot.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();
  const folder = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: null,
    nodeType: "folder", title: "目录", db });
  const note = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: folder.id,
    nodeType: "markdown", title: "笔记", db });
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES ('a-map', 'owner', '脑图', '{}')").run();
  const noteResourceId = (db.prepare("SELECT resourceId FROM knowledge_tree_nodes WHERE id = ?")
    .get(note.id) as { resourceId: string }).resourceId;
  db.prepare(`INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
    VALUES ('attachment-1', ?, 'owner', '文件.txt', 'text/plain', 3, '/tmp/file')`).run(noteResourceId);
  db.prepare(`INSERT INTO knowledge_tree_nodes
    (id, userId, scopeKey, parentId, nodeType, resourceType, resourceId)
    VALUES ('file:attachment-1', 'owner', 'personal:owner', ?, 'file', 'file', 'attachment-1')`).run(note.id);
  db.prepare("UPDATE knowledge_tree_nodes SET parentId = ?, sortOrder = 9, isDeleted = 1, deletedAt = '2026-09-27' WHERE id = 'mindmap:a-map'")
    .run(note.id);

  const items = prepareKnowledgeTreeSnapshot(db, "owner", null);
  const ids = items.map((item) => item.entityId);
  assert.ok(ids.indexOf(folder.id) < ids.indexOf(note.id));
  assert.ok(ids.indexOf(note.id) < ids.indexOf("mindmap:a-map"), "ID sorting alone would place the mindmap first");
  assert.ok(ids.indexOf(note.id) < ids.indexOf("file:attachment-1"), "附件元数据已同步时文件节点也应保留");
  const map = items.find((item) => item.entityId === "mindmap:a-map")?.payload;
  assert.equal(map?.parentId, note.id);
  assert.equal(map?.sortOrder, 9);
  assert.equal(map?.isDeleted, 1);
  assert.equal(map?.deletedAt, "2026-09-27");

  const collected: string[] = [];
  let cursor: string | null = null;
  do {
    const page = knowledgeTreeSnapshotPage(db, "owner", null, cursor, 1);
    collected.push(...page.items.map((item) => item.entityId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(collected, ids, "分页不能丢失跨类型子节点或重复节点");
  assert.throws(() => knowledgeTreeSnapshotPage(db, "owner", null, "missing", 1),
    (error: { code: string }) => error.code === "INVALID_PAYLOAD");
});

test("tree snapshot fails closed for orphaned file nodes and unauthorized workspace access", async () => {
  const { getDb } = await import("../src/db/schema.js");
  const { prepareKnowledgeTreeSnapshot } = await import("../src/sync/knowledgeTreeSnapshot.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('other', 'other', 'hash')").run();
  assert.deepEqual(prepareKnowledgeTreeSnapshot(db, "other", null), []);
  db.prepare(`INSERT INTO knowledge_tree_nodes
    (id, userId, scopeKey, nodeType, resourceType, resourceId)
    VALUES ('file:unsupported', 'owner', 'personal:owner', 'file', 'file', 'unsupported')`).run();
  assert.throws(() => prepareKnowledgeTreeSnapshot(db, "owner", null),
    (error: { code: string }) => error.code === "MISSING_DEPENDENCY");

  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('ws', '团队', 'owner')").run();
  assert.throws(() => prepareKnowledgeTreeSnapshot(db, "other", "ws"),
    (error: { code: string }) => error.code === "ACCESS_REVOKED");
});
