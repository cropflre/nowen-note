import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-knowledge-tree-"));
process.env.DB_PATH = path.join(tempDir, "knowledge-tree.db");
let closeDatabase: (() => void) | null = null;
const phase = (name: string) => console.log(`[knowledge-tree-test] ${name}`);

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("v64 migration builds a mixed tree and enforces inherited capabilities", async () => {
  phase("bootstrap");
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb, getDbSchemaVersion } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const {
    createKnowledgeChild,
    deleteKnowledgeNode,
    KnowledgeTreeError,
    listKnowledgeTree,
    moveKnowledgeNode,
    restoreKnowledgeNode,
  } = await import("../src/services/knowledgeTree.js");
  const {
    clearKnowledgeNodeRole,
    resolveKnowledgeNodeAccess,
    setKnowledgeNodeRole,
  } = await import("../src/services/knowledgeCapabilities.js");

  const db = getDb();
  assert.equal(getDbSchemaVersion(), 64);

  phase("seed users and workspace");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("owner", "owner", "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("member", "member", "hash");
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run("ws", "Team", "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("ws", "owner", "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("ws", "member", "viewer");

  phase("create root folder");
  const root = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: null,
    nodeType: "folder",
    title: "产品资料",
    db,
  });
  phase("create product document under folder");
  const product = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: root.id,
    nodeType: "note",
    title: "13012230-V/R-TANK",
    db,
  });
  phase("create order folder under document");
  const orderFolder = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: product.id,
    nodeType: "folder",
    title: "PO20260715",
    db,
  });
  phase("create production document");
  const production = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: orderFolder.id,
    nodeType: "markdown",
    title: "生产记录",
    db,
  });

  phase("list mixed tree");
  const tree = listKnowledgeTree({ userId: "owner", workspaceId: "ws", db });
  assert.equal(tree.find((node) => node.id === orderFolder.id)?.parentId, product.id);
  assert.equal(tree.find((node) => node.id === production.id)?.parentId, orderFolder.id);
  assert.equal(tree.find((node) => node.id === product.id)?.childCount, 1);

  phase("legacy sort and expand update");
  db.prepare("UPDATE notebooks SET sortOrder = sortOrder + 1, isExpanded = 0 WHERE id = ?")
    .run(orderFolder.resourceId);
  assert.equal(
    (db.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id = ?").get(orderFolder.id) as { parentId: string }).parentId,
    product.id,
  );

  phase("grant editor role");
  setKnowledgeNodeRole({
    nodeId: product.id,
    targetUserId: "member",
    rolePreset: "editor",
    actorUserId: "owner",
    db,
  });
  const inheritedEditor = resolveKnowledgeNodeAccess(production.id, "member", db);
  assert.equal(inheritedEditor.source, "inherited");
  assert.equal(inheritedEditor.capabilities.canEdit, true);
  assert.equal(inheritedEditor.capabilities.canMove, false);
  assert.equal(inheritedEditor.capabilities.canDelete, false);

  phase("editor creates child document");
  const editorCreated = createKnowledgeChild({
    actorUserId: "member",
    workspaceId: "ws",
    parentId: product.id,
    nodeType: "note",
    title: "编辑成员创建的文档",
    db,
  });
  const creatorAccess = resolveKnowledgeNodeAccess(editorCreated.id, "member", db);
  assert.equal(creatorAccess.source, "inherited");
  assert.equal(creatorAccess.capabilities.canEdit, true);
  assert.equal(creatorAccess.capabilities.canDelete, false);
  assert.equal(creatorAccess.capabilities.canManageMembers, false);

  phase("deny editor move");
  assert.throws(
    () => moveKnowledgeNode({
      actorUserId: "member",
      nodeId: production.id,
      parentId: product.id,
      db,
    }),
    (error: unknown) => error instanceof KnowledgeTreeError && error.code === "KNOWLEDGE_CAPABILITY_FORBIDDEN",
  );

  phase("grant maintainer role");
  setKnowledgeNodeRole({
    nodeId: product.id,
    targetUserId: "member",
    rolePreset: "maintainer",
    actorUserId: "owner",
    db,
  });
  const inheritedMaintainer = resolveKnowledgeNodeAccess(production.id, "member", db);
  assert.equal(inheritedMaintainer.capabilities.canMove, true);
  assert.equal(inheritedMaintainer.capabilities.canDelete, true);
  assert.equal(inheritedMaintainer.capabilities.canManageMembers, false);

  phase("cycle guard");
  assert.throws(
    () => moveKnowledgeNode({
      actorUserId: "member",
      nodeId: product.id,
      parentId: production.id,
      db,
    }),
    (error: unknown) => error instanceof KnowledgeTreeError && error.code === "KNOWLEDGE_TREE_CYCLE",
  );

  phase("create restore subtree");
  const restoreFolder = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: product.id,
    nodeType: "folder",
    title: "待恢复目录",
    db,
  });
  const restoreChild = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: restoreFolder.id,
    nodeType: "note",
    title: "待恢复文档",
    db,
  });
  phase("delete restore subtree");
  const deletedSubtree = deleteKnowledgeNode({
    actorUserId: "member",
    nodeId: restoreFolder.id,
    mode: "subtree",
    db,
  });
  assert.deepEqual(new Set(deletedSubtree.affectedNodeIds), new Set([restoreFolder.id, restoreChild.id]));
  phase("restore complete subtree");
  const restoredSubtree = restoreKnowledgeNode({
    actorUserId: "owner",
    nodeId: restoreFolder.id,
    includeSubtree: true,
    db,
  });
  assert.deepEqual(new Set(restoredSubtree.restoredNodeIds), new Set([restoreFolder.id, restoreChild.id]));
  const restoredRows = db.prepare("SELECT id, isDeleted FROM knowledge_tree_nodes WHERE id IN (?, ?)")
    .all(restoreFolder.id, restoreChild.id) as Array<{ id: string; isDeleted: number }>;
  assert.equal(restoredRows.every((row) => row.isDeleted === 0), true);

  phase("delete parent and promote child");
  const deleted = deleteKnowledgeNode({
    actorUserId: "member",
    nodeId: orderFolder.id,
    mode: "promote",
    db,
  });
  assert.deepEqual(deleted.promotedNodeIds, [production.id]);
  assert.equal(
    (db.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id = ?").get(production.id) as { parentId: string }).parentId,
    product.id,
  );

  phase("clear direct role and use legacy viewer");
  assert.equal(clearKnowledgeNodeRole({
    nodeId: product.id,
    targetUserId: "member",
    actorUserId: "owner",
    db,
  }), true);
  const legacyViewer = resolveKnowledgeNodeAccess(production.id, "member", db);
  assert.equal(legacyViewer.source, "legacy");
  assert.equal(legacyViewer.capabilities.canView, true);
  assert.equal(legacyViewer.capabilities.canEdit, false);
});
