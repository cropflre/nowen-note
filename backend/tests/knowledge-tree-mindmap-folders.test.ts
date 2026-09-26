import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-legacy-mindmap-folders-"));
process.env.DB_PATH = path.join(tempDir, "legacy-mindmap-folders.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("legacy mindmap folders migrate without losing hierarchy or crossing scopes", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  await import("../src/runtime/knowledge-tree.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const {
    ensureKnowledgeTreeMindmapFolders,
    MINDMAP_LEGACY_NOTEBOOK_PREFIX,
  } = await import("../src/db/knowledgeTreeMindmapFolderMigration.js");
  const { createKnowledgeChild, listKnowledgeTree, moveKnowledgeNode } = await import("../src/services/knowledgeTree.js");
  closeDatabase = closeDb;
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run("owner", "owner");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run("other", "other");
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('ws', 'Team', 'owner')").run();
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('ws', 'owner', 'owner')").run();

  // Simulate rows from an older client before v105, while v104 mindmap nodes already exist.
  db.exec("DROP TRIGGER knowledge_tree_mindmap_folders_ai");
  const insertFolder = db.prepare("INSERT INTO mindmap_folders (id, userId, workspaceId, parentId, name) VALUES (?, ?, ?, ?, ?)");
  insertFolder.run("personal-root", "owner", null, null, "旧项目");
  insertFolder.run("personal-child", "owner", null, "personal-root", "设计");
  insertFolder.run("workspace-root", "owner", "ws", null, "团队脑图");
  const insertMap = db.prepare("INSERT INTO mindmaps (id, userId, workspaceId, title, data, folderId) VALUES (?, ?, ?, ?, '{}', ?)");
  insertMap.run("personal-map", "owner", null, "原有脑图", "personal-child");
  insertMap.run("workspace-map", "owner", "ws", "团队脑图", "workspace-root");
  insertMap.run("bad-scope-map", "owner", null, "错误旧归属", "workspace-root");
  insertMap.run("moved-before-upgrade", "owner", null, "用户已移动", "personal-child");
  db.prepare("INSERT INTO knowledge_tree_history (id, nodeId, action, actorUserId) VALUES ('old-move', 'mindmap:moved-before-upgrade', 'move', 'owner')").run();

  ensureKnowledgeTreeMindmapFolders(db);
  const folderNodeId = `notebook:${MINDMAP_LEGACY_NOTEBOOK_PREFIX}personal-child`;
  const personal = listKnowledgeTree({ userId: "owner", workspaceId: null, db });
  assert.equal(personal.find((node) => node.id === folderNodeId)?.parentId,
    `notebook:${MINDMAP_LEGACY_NOTEBOOK_PREFIX}personal-root`);
  assert.equal(personal.find((node) => node.id === "mindmap:personal-map")?.parentId, folderNodeId);
  assert.equal(personal.find((node) => node.id === "mindmap:bad-scope-map")?.parentId, null);
  assert.equal(personal.find((node) => node.id === "mindmap:moved-before-upgrade")?.parentId, null);
  assert.equal(personal.some((node) => node.id === "mindmap:workspace-map"), false);
  assert.equal(listKnowledgeTree({ userId: "owner", workspaceId: "ws", db })
    .find((node) => node.id === "mindmap:workspace-map")?.parentId,
    `notebook:${MINDMAP_LEGACY_NOTEBOOK_PREFIX}workspace-root`);
  assert.equal(listKnowledgeTree({ userId: "other", workspaceId: null, db }).length, 0);
  assert.equal((db.prepare("SELECT folderId FROM mindmaps WHERE id = 'personal-map'").get() as { folderId: string }).folderId,
    "personal-child");

  // Old-center operations remain reflected in the unified tree.
  insertFolder.run("new-folder", "owner", null, "personal-root", "新目录");
  assert.equal(listKnowledgeTree({ userId: "owner", workspaceId: null, db })
    .find((node) => node.resourceId === `${MINDMAP_LEGACY_NOTEBOOK_PREFIX}new-folder`)?.parentId,
    `notebook:${MINDMAP_LEGACY_NOTEBOOK_PREFIX}personal-root`);
  db.prepare("UPDATE mindmap_folders SET name = '已改名', parentId = NULL WHERE id = 'new-folder'").run();
  const renamed = listKnowledgeTree({ userId: "owner", workspaceId: null, db })
    .find((node) => node.resourceId === `${MINDMAP_LEGACY_NOTEBOOK_PREFIX}new-folder`);
  assert.equal(renamed?.title, "已改名");
  assert.equal(renamed?.parentId, null);
  db.prepare("UPDATE mindmaps SET folderId = 'new-folder' WHERE id = 'personal-map'").run();
  assert.equal(listKnowledgeTree({ userId: "owner", workspaceId: null, db })
    .find((node) => node.id === "mindmap:personal-map")?.parentId, renamed?.id);

  // New-tree moves keep old clients' folderId usable, while standard folders show as unclassified.
  const standard = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: null, nodeType: "folder", title: "普通目录", db });
  moveKnowledgeNode({ actorUserId: "owner", nodeId: "mindmap:personal-map", parentId: standard.id, db });
  assert.equal((db.prepare("SELECT folderId FROM mindmaps WHERE id = 'personal-map'").get() as { folderId: string | null }).folderId, null);
  moveKnowledgeNode({ actorUserId: "owner", nodeId: "mindmap:personal-map", parentId: folderNodeId, db });
  assert.equal((db.prepare("SELECT folderId FROM mindmaps WHERE id = 'personal-map'").get() as { folderId: string }).folderId, "personal-child");

  ensureKnowledgeTreeMindmapFolders(db);
  assert.equal(listKnowledgeTree({ userId: "owner", workspaceId: null, db })
    .find((node) => node.id === "mindmap:personal-map")?.parentId, folderNodeId);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM mindmap_folders").get() as { count: number }).count, 4);

  moveKnowledgeNode({ actorUserId: "owner", nodeId: folderNodeId,
    parentId: `notebook:${MINDMAP_LEGACY_NOTEBOOK_PREFIX}new-folder`, db });
  assert.equal((db.prepare("SELECT parentId FROM mindmap_folders WHERE id = 'personal-child'").get() as { parentId: string }).parentId,
    "new-folder");

  insertFolder.run("empty-folder", "owner", null, null, "空目录");
  db.prepare("DELETE FROM mindmap_folders WHERE id = 'empty-folder'").run();
  assert.equal(db.prepare("SELECT 1 FROM notebooks WHERE id = ?")
    .get(`${MINDMAP_LEGACY_NOTEBOOK_PREFIX}empty-folder`), undefined);

  insertFolder.run("folder-with-note", "owner", null, null, "有文档的旧目录");
  const note = createKnowledgeChild({ actorUserId: "owner", workspaceId: null,
    parentId: `notebook:${MINDMAP_LEGACY_NOTEBOOK_PREFIX}folder-with-note`, nodeType: "note", title: "不能丢", db });
  db.prepare("DELETE FROM mindmap_folders WHERE id = 'folder-with-note'").run();
  assert.ok(db.prepare("SELECT 1 FROM notebooks WHERE id = ?")
    .get(`${MINDMAP_LEGACY_NOTEBOOK_PREFIX}folder-with-note`));
  assert.ok(db.prepare("SELECT 1 FROM notes WHERE id = ?").get(note.resourceId));
});
