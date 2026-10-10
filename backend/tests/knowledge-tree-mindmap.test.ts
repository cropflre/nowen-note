import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-mindmap-"));
process.env.DB_PATH = path.join(tempDir, "mindmap.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("legacy and newly created mindmaps share the knowledge tree with notes", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  await import("../src/runtime/knowledge-tree.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { ensureKnowledgeTreeMindmaps } = await import("../src/db/knowledgeTreeMindmapMigration.js");
  const { createKnowledgeChild, listKnowledgeTree, moveKnowledgeNode } = await import("../src/services/knowledgeTree.js");
  closeDatabase = closeDb;
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();

  // Simulate a mindmap written before the projection was installed.
  db.exec("DROP TRIGGER knowledge_tree_mindmaps_ai");
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES (?, ?, ?, ?)")
    .run("old-map", "owner", "旧脑图", "{}");
  ensureKnowledgeTreeMindmaps(db);
  const old = listKnowledgeTree({ userId: "owner", workspaceId: null, db })
    .find((node) => node.resourceId === "old-map");
  assert.equal(old?.nodeType, "mindmap");
  assert.equal(old?.title, "旧脑图");

  const folder = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: null, nodeType: "folder", title: "项目", db });
  const note = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: folder.id, nodeType: "markdown", title: "说明", db });
  const map = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: folder.id, nodeType: "mindmap", title: "结构", db });
  assert.equal(map.parentId, folder.id);
  assert.equal(JSON.parse((db.prepare("SELECT data FROM mindmaps WHERE id = ?").get(map.resourceId) as { data: string }).data).root.text, "结构");

  const siblings = listKnowledgeTree({ userId: "owner", workspaceId: null, db })
    .filter((node) => node.parentId === folder.id);
  assert.deepEqual(new Set(siblings.map((node) => node.nodeType)), new Set(["markdown", "mindmap"]));
  assert.equal(siblings.find((node) => node.id === note.id)?.resourceType, "note");
  db.prepare("UPDATE mindmaps SET title = '新结构', updatedAt = '2026-09-26 12:00:00' WHERE id = ?").run(map.resourceId);
  const renamed = listKnowledgeTree({ userId: "owner", workspaceId: null, db }).find((node) => node.id === map.id);
  assert.equal(renamed?.title, "新结构");
  assert.equal(renamed?.updatedAt, "2026-09-26 12:00:00");

  const { reorderKnowledgeNodes } = await import("../src/services/knowledgeTree.js");
  reorderKnowledgeNodes({ actorUserId: "owner", items: [{ id: map.id, sortOrder: 1 }, { id: note.id, sortOrder: 2 }], db });
  assert.deepEqual(listKnowledgeTree({ userId: "owner", workspaceId: null, db })
    .filter((node) => node.parentId === folder.id).map((node) => node.id), [map.id, note.id]);

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('other', 'other', 'hash')").run();
  assert.equal(listKnowledgeTree({ userId: "other", workspaceId: null, db }).some((node) => node.id === map.id), false);
  assert.throws(() => moveKnowledgeNode({ actorUserId: "other", nodeId: map.id, parentId: null, db }), /权限不足/);

  moveKnowledgeNode({ actorUserId: "owner", nodeId: map.id, parentId: null, db });
  assert.equal(listKnowledgeTree({ userId: "owner", workspaceId: null, db }).find((node) => node.id === map.id)?.parentId, null);

  db.prepare("DELETE FROM mindmaps WHERE id = ?").run(map.resourceId);
  assert.equal(listKnowledgeTree({ userId: "owner", workspaceId: null, db }).some((node) => node.id === map.id), false);
});
