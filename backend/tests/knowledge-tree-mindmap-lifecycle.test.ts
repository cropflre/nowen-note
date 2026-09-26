import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-mindmap-trash-"));
process.env.DB_PATH = path.join(tempDir, "mindmap-trash.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("tree trash hides mindmaps from legacy APIs and restore brings back the original data", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild, deleteKnowledgeNode, listKnowledgeTree, restoreKnowledgeNode } = await import("../src/services/knowledgeTree.js");
  const mindmaps = (await import("../src/routes/mindmaps.js")).default;
  closeDatabase = closeDb;
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('other', 'other', 'hash')").run();
  const folder = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: null, nodeType: "folder", title: "项目", db });
  const map = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: folder.id, nodeType: "mindmap", title: "设计", db });
  const originalData = (db.prepare("SELECT data FROM mindmaps WHERE id = ?").get(map.resourceId) as { data: string }).data;

  const app = new Hono();
  app.route("/api/mindmaps", mindmaps);
  const headers = { "X-User-Id": "owner", "Content-Type": "application/json" };
  const read = () => app.request(`/api/mindmaps/${map.resourceId}`, { headers });
  const list = () => app.request("/api/mindmaps", { headers });

  deleteKnowledgeNode({ actorUserId: "owner", nodeId: map.id, mode: "subtree", db });
  assert.equal((await read()).status, 404);
  assert.deepEqual(await (await list()).json(), []);
  assert.equal((await app.request(`/api/mindmaps/${map.resourceId}`, {
    method: "PUT", headers, body: JSON.stringify({ title: "should not save" }),
  })).status, 404);
  assert.equal(listKnowledgeTree({ userId: "owner", workspaceId: null, db }).some((node) => node.id === map.id), false);
  assert.equal(listKnowledgeTree({ userId: "owner", workspaceId: null, includeDeleted: true, db })
    .find((node) => node.id === map.id)?.isDeleted, 1);
  assert.equal((db.prepare("SELECT data FROM mindmaps WHERE id = ?").get(map.resourceId) as { data: string }).data, originalData);
  assert.throws(() => restoreKnowledgeNode({ actorUserId: "other", nodeId: map.id, db }), /没有恢复权限/);
  assert.equal((await app.request(`/api/mindmaps/${map.resourceId}/permanent`, {
    method: "DELETE", headers: { "X-User-Id": "other" },
  })).status, 403);

  restoreKnowledgeNode({ actorUserId: "owner", nodeId: map.id, db });
  assert.equal((await read()).status, 200);
  assert.equal((await (await list()).json() as Array<{ id: string }>)[0]?.id, map.resourceId);
  assert.equal((db.prepare("SELECT data FROM mindmaps WHERE id = ?").get(map.resourceId) as { data: string }).data, originalData);
});

test("restoring a deleted folder recovers its active mindmap and note, not a previously trashed child", async () => {
  const { getDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild, deleteKnowledgeNode, restoreKnowledgeNode } = await import("../src/services/knowledgeTree.js");
  const db = getDb();
  const folder = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: null, nodeType: "folder", title: "恢复目录", db });
  const map = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: folder.id, nodeType: "mindmap", title: "要恢复", db });
  const note = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: folder.id, nodeType: "note", title: "要恢复的笔记", db });
  const olderMap = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: folder.id, nodeType: "mindmap", title: "先前已删", db });
  deleteKnowledgeNode({ actorUserId: "owner", nodeId: olderMap.id, mode: "subtree", db });
  assert.equal((db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE id = ?").get(olderMap.id) as { isDeleted: number }).isDeleted, 1);
  deleteKnowledgeNode({ actorUserId: "owner", nodeId: folder.id, mode: "subtree", db });
  const deletion = db.prepare("SELECT metadata FROM knowledge_tree_history WHERE nodeId = ? AND action = 'delete_subtree' ORDER BY rowid DESC LIMIT 1")
    .get(folder.id) as { metadata: string };
  assert.equal(JSON.parse(deletion.metadata).affectedNodeIds.includes(olderMap.id), false);

  const result = restoreKnowledgeNode({ actorUserId: "owner", nodeId: folder.id, includeSubtree: true, db });
  assert.deepEqual(new Set(result.restoredNodeIds), new Set([folder.id, map.id, note.id]));
  assert.equal((db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE id = ?").get(olderMap.id) as { isDeleted: number }).isDeleted, 1);
  assert.equal((db.prepare("SELECT isTrashed FROM notes WHERE id = ?").get(note.resourceId) as { isTrashed: number }).isTrashed, 0);
});

test("legacy mindmap delete enters trash and permanent delete removes both resource and tree node", async () => {
  const { Hono } = await import("hono");
  const { getDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const mindmaps = (await import("../src/routes/mindmaps.js")).default;
  const db = getDb();
  const map = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: null, nodeType: "mindmap", title: "中心删除", db });
  const app = new Hono();
  app.route("/api/mindmaps", mindmaps);
  const headers = { "X-User-Id": "owner" };

  assert.equal((await app.request(`/api/mindmaps/${map.resourceId}`, { method: "DELETE", headers })).status, 200);
  assert.ok(db.prepare("SELECT id FROM mindmaps WHERE id = ?").get(map.resourceId));
  assert.equal((db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE id = ?").get(map.id) as { isDeleted: number }).isDeleted, 1);
  assert.equal((await app.request(`/api/mindmaps/${map.resourceId}/permanent`, { method: "DELETE", headers })).status, 200);
  assert.equal(db.prepare("SELECT id FROM mindmaps WHERE id = ?").get(map.resourceId), undefined);
  assert.equal(db.prepare("SELECT id FROM knowledge_tree_nodes WHERE id = ?").get(map.id), undefined);
});

test("trashing a migrated legacy folder hides it and its maps from the old center until restore", async () => {
  const { Hono } = await import("hono");
  const { getDb } = await import("../src/db/schema.js");
  const { deleteKnowledgeNode, restoreKnowledgeNode } = await import("../src/services/knowledgeTree.js");
  const folders = (await import("../src/routes/mindmap-folders.js")).default;
  const mindmaps = (await import("../src/routes/mindmaps.js")).default;
  const { MINDMAP_LEGACY_NOTEBOOK_PREFIX } = await import("../src/db/knowledgeTreeMindmapFolderMigration.js");
  const db = getDb();
  db.prepare("INSERT INTO mindmap_folders (id, userId, name) VALUES ('old-folder', 'owner', '旧目录')").run();
  db.prepare("INSERT INTO mindmaps (id, userId, title, data, folderId) VALUES ('old-folder-map', 'owner', '旧目录脑图', '{}', 'old-folder')").run();
  const nodeId = `notebook:${MINDMAP_LEGACY_NOTEBOOK_PREFIX}old-folder`;
  const app = new Hono();
  app.route("/api/mindmap-folders", folders);
  app.route("/api/mindmaps", mindmaps);
  const headers = { "X-User-Id": "owner" };
  const readFolders = async () => (await (await app.request("/api/mindmap-folders", { headers })).json()) as Array<{ id: string; mindmapCount: number }>;
  const readMaps = async () => (await (await app.request("/api/mindmaps", { headers })).json()) as Array<{ id: string }>;
  assert.equal((await readFolders()).find((folder) => folder.id === "old-folder")?.mindmapCount, 1);
  deleteKnowledgeNode({ actorUserId: "owner", nodeId, mode: "subtree", db });
  assert.equal((await readFolders()).some((folder) => folder.id === "old-folder"), false);
  assert.equal((await readMaps()).some((map) => map.id === "old-folder-map"), false);
  restoreKnowledgeNode({ actorUserId: "owner", nodeId, db });
  assert.equal((await readFolders()).find((folder) => folder.id === "old-folder")?.mindmapCount, 1);
  assert.equal((await readMaps()).some((map) => map.id === "old-folder-map"), true);
});
