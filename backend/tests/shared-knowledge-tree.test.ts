import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-shared-knowledge-tree-"));
process.env.DB_PATH = path.join(tempDir, "shared-knowledge-tree.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("shared knowledge tree exposes only authorized mixed subtrees", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const {
    createKnowledgeChild,
    listSharedKnowledgeTree,
  } = await import("../src/services/knowledgeTree.js");
  const { setKnowledgeNodeRole } = await import("../src/services/knowledgeCapabilities.js");

  const db = getDb();
  for (const userId of ["owner", "viewer", "editor"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')")
      .run(userId, userId);
  }

  const root = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "共享产品资料",
    db,
  });
  const product = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: root.id,
    nodeType: "note",
    title: "13012230-V/R-TANK",
    db,
  });
  const order = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: product.id,
    nodeType: "folder",
    title: "PO20260715",
    db,
  });
  const production = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: order.id,
    nodeType: "markdown",
    title: "生产记录",
    db,
  });
  const deleted = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: order.id,
    nodeType: "note",
    title: "已删除文档",
    db,
  });
  db.prepare("UPDATE notes SET isTrashed = 1, trashedAt = datetime('now') WHERE id = ?")
    .run(deleted.resourceId);

  const privateRoot = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "私有兄弟目录",
    db,
  });
  const directlySharedNote = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: privateRoot.id,
    nodeType: "note",
    title: "单独共享文档",
    db,
  });

  db.prepare(`INSERT INTO notebook_members
    (id, notebookId, userId, role, status, allowDownload, allowReshare, source)
    VALUES (?, ?, ?, ?, 'active', 1, 0, 'manual')`)
    .run("viewer-root", root.resourceId, "viewer", "viewer");
  db.prepare(`INSERT INTO notebook_members
    (id, notebookId, userId, role, status, allowDownload, allowReshare, source)
    VALUES (?, ?, ?, ?, 'active', 1, 0, 'manual')`)
    .run("editor-root", root.resourceId, "editor", "editor");

  setKnowledgeNodeRole({
    nodeId: directlySharedNote.id,
    targetUserId: "viewer",
    rolePreset: "readonly",
    actorUserId: "owner",
    db,
  });

  db.prepare(`INSERT INTO favorites (userId, noteId, workspaceId, createdAt)
    VALUES (?, ?, ?, datetime('now'))`)
    .run("viewer", production.resourceId, null);
  db.prepare("UPDATE notes SET isFavorite = 1 WHERE id = ?")
    .run(directlySharedNote.resourceId);

  const viewerRows = listSharedKnowledgeTree({ userId: "viewer", workspaceId: null, db });
  const viewerIds = viewerRows.map((node) => node.id);
  assert.equal(new Set(viewerIds).size, viewerIds.length);
  assert.equal(viewerIds.includes(root.id), true);
  assert.equal(viewerIds.includes(product.id), true);
  assert.equal(viewerIds.includes(order.id), true);
  assert.equal(viewerIds.includes(production.id), true);
  assert.equal(viewerIds.includes(deleted.id), false);
  assert.equal(viewerIds.includes(privateRoot.id), false);
  assert.equal(viewerIds.includes(directlySharedNote.id), true);

  const sharedRoot = viewerRows.find((node) => node.id === root.id)!;
  const sharedProduction = viewerRows.find((node) => node.id === production.id)!;
  const directNote = viewerRows.find((node) => node.id === directlySharedNote.id)!;
  assert.equal(sharedRoot.parentId, null);
  assert.equal(sharedRoot.sharedRootId, root.id);
  assert.equal(sharedProduction.sharedRootId, root.id);
  assert.equal(sharedProduction.access.capabilities.canView, true);
  assert.equal(sharedProduction.access.capabilities.canEdit, false);
  assert.equal(directNote.parentId, null);
  assert.equal(directNote.sharedRootId, directlySharedNote.id);
  assert.equal(sharedProduction.isFavorite, 1);
  assert.equal(directNote.isFavorite, 0);

  const editorCreated = createKnowledgeChild({
    actorUserId: "editor",
    workspaceId: null,
    parentId: root.id,
    nodeType: "note",
    title: "协作者创建的文档",
    db,
  });
  assert.equal(editorCreated.scopeKey, root.scopeKey);
  assert.equal(editorCreated.userId, "owner");
  assert.equal(editorCreated.parentId, root.id);
  assert.equal(editorCreated.access.capabilities.canEdit, true);

  db.prepare(`INSERT INTO notebook_members
    (id, notebookId, userId, role, status, allowDownload, allowReshare, source)
    VALUES (?, ?, ?, 'editor', 'active', 1, 0, 'manual')`)
    .run("viewer-overlap", order.resourceId, "viewer");

  const overlapped = listSharedKnowledgeTree({ userId: "viewer", workspaceId: null, db });
  assert.equal(new Set(overlapped.map((node) => node.id)).size, overlapped.length);
  assert.equal(overlapped.find((node) => node.id === order.id)?.sharedRootId, order.id);
  assert.equal(overlapped.find((node) => node.id === production.id)?.sharedRootId, order.id);
});
