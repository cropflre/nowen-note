import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-personal-owner-invariant-"));
process.env.DB_PATH = path.join(tempDir, "personal-owner-invariant.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("personal owner keeps member-management access when the tree ownership mirror is stale", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const {
    clearKnowledgeNodeRole,
    resolveKnowledgeNodeAccess,
    setKnowledgeNodeRole,
  } = await import("../src/services/knowledgeCapabilities.js");
  const {
    clearKnowledgeNodeDenied,
    setKnowledgeNodeDenied,
  } = await import("../src/services/knowledgeDenyPolicy.js");
  const { getKnowledgeNodeAccessPolicy } = await import("../src/services/knowledgeAccessPolicy.js");

  closeDatabase = closeDb;
  const db = getDb();
  for (const userId of ["owner-invariant", "member-invariant", "stale-tree-user"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')")
      .run(userId, userId);
  }

  const root = createKnowledgeChild({
    actorUserId: "owner-invariant",
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "个人资料",
    db,
  });
  const note = createKnowledgeChild({
    actorUserId: "owner-invariant",
    workspaceId: null,
    parentId: root.id,
    nodeType: "note",
    title: "个人文档",
    db,
  });

  // Reproduce a historical/migration inconsistency: business rows still belong to the real owner,
  // but the unified-tree mirror points at another user. scopeKey intentionally stays unchanged so
  // the owner can still see the tree, matching the field report behind #783.
  db.prepare("UPDATE knowledge_tree_nodes SET userId = ? WHERE id IN (?, ?)")
    .run("stale-tree-user", root.id, note.id);

  assert.equal(
    (db.prepare("SELECT userId FROM notebooks WHERE id = ?").get(root.resourceId) as { userId: string }).userId,
    "owner-invariant",
  );
  assert.equal(
    (db.prepare("SELECT userId FROM notes WHERE id = ?").get(note.resourceId) as { userId: string }).userId,
    "owner-invariant",
  );

  const ownerBeforeGrant = resolveKnowledgeNodeAccess(root.id, "owner-invariant", db);
  assert.equal(ownerBeforeGrant.source, "owner");
  assert.equal(ownerBeforeGrant.capabilities.canManageMembers, true);

  // The stale tree user must not be promoted to owner merely because the mirror says so.
  const staleUserAccess = resolveKnowledgeNodeAccess(root.id, "stale-tree-user", db);
  assert.equal(staleUserAccess.source, "none");
  assert.equal(staleUserAccess.capabilities.canManageMembers, false);

  // Granting the first member creates the automatic restricted boundary. This was the transition
  // that previously locked the real owner out when ownership was resolved only from tree.userId.
  setKnowledgeNodeRole({
    nodeId: root.id,
    targetUserId: "member-invariant",
    rolePreset: "readonly",
    actorUserId: "owner-invariant",
    db,
  });
  assert.equal(getKnowledgeNodeAccessPolicy(root.id, db).accessMode, "restricted");

  const ownerAfterGrant = resolveKnowledgeNodeAccess(root.id, "owner-invariant", db);
  assert.equal(ownerAfterGrant.source, "owner");
  assert.equal(ownerAfterGrant.capabilities.canManageMembers, true);
  assert.equal(ownerAfterGrant.capabilities.canDelete, true);
  assert.equal(ownerAfterGrant.capabilities.canReshare, true);

  const memberAfterGrant = resolveKnowledgeNodeAccess(root.id, "member-invariant", db);
  assert.equal(memberAfterGrant.source, "direct");
  assert.equal(memberAfterGrant.capabilities.canView, true);
  assert.equal(memberAfterGrant.capabilities.canManageMembers, false);

  // The same invariant must hold for directly shared personal notes.
  setKnowledgeNodeRole({
    nodeId: note.id,
    targetUserId: "member-invariant",
    rolePreset: "editor",
    actorUserId: "owner-invariant",
    db,
  });
  const noteOwner = resolveKnowledgeNodeAccess(note.id, "owner-invariant", db);
  assert.equal(noteOwner.source, "owner");
  assert.equal(noteOwner.capabilities.canManageMembers, true);

  // Owner can revoke access or switch to an explicit deny without losing management access.
  setKnowledgeNodeDenied({
    nodeId: root.id,
    targetUserId: "member-invariant",
    actorUserId: "owner-invariant",
    db,
  });
  assert.equal(resolveKnowledgeNodeAccess(root.id, "member-invariant", db).capabilities.canView, false);
  assert.equal(resolveKnowledgeNodeAccess(root.id, "owner-invariant", db).capabilities.canManageMembers, true);

  assert.equal(clearKnowledgeNodeDenied({
    nodeId: root.id,
    targetUserId: "member-invariant",
    actorUserId: "owner-invariant",
    db,
  }), true);
  assert.equal(clearKnowledgeNodeRole({
    nodeId: root.id,
    targetUserId: "member-invariant",
    actorUserId: "owner-invariant",
    db,
  }), true);
  assert.equal(resolveKnowledgeNodeAccess(root.id, "owner-invariant", db).capabilities.canManageMembers, true);
});
