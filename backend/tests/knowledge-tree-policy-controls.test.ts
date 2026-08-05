import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-knowledge-policy-"));
process.env.DB_PATH = path.join(tempDir, "knowledge-policy.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("explicit private mode and deny rules compose without hiding unrelated members", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const {
    clearKnowledgeNodeRole,
    resolveKnowledgeNodeAccess,
    setKnowledgeNodeRole,
  } = await import("../src/services/knowledgeCapabilities.js");
  const {
    getKnowledgeNodeAccessPolicy,
    setKnowledgeNodeAccessMode,
  } = await import("../src/services/knowledgeAccessPolicy.js");
  const {
    clearKnowledgeNodeDenied,
    setKnowledgeNodeDenied,
  } = await import("../src/services/knowledgeDenyPolicy.js");

  closeDatabase = closeDb;
  const db = getDb();
  for (const userId of ["owner", "allowed", "other", "excluded"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
      .run(userId, userId, "hash");
  }
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run("ws", "Team", "owner");
  for (const [userId, role] of [
    ["owner", "owner"],
    ["allowed", "viewer"],
    ["other", "viewer"],
    ["excluded", "viewer"],
  ]) {
    db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
      .run("ws", userId, role);
  }

  const root = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: null,
    nodeType: "folder",
    title: "项目",
    db,
  });
  const child = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: root.id,
    nodeType: "note",
    title: "子文档",
    db,
  });

  assert.equal(resolveKnowledgeNodeAccess(child.id, "excluded", db).capabilities.canView, true);

  // Manual restricted mode remains private even with an empty allowlist.
  assert.deepEqual(setKnowledgeNodeAccessMode({
    nodeId: root.id,
    accessMode: "restricted",
    actorUserId: "owner",
    db,
  }), { accessMode: "restricted", isExplicit: true });
  assert.equal(getKnowledgeNodeAccessPolicy(root.id, db).isExplicit, true);
  assert.equal(resolveKnowledgeNodeAccess(child.id, "excluded", db).capabilities.canView, false);
  assert.equal(resolveKnowledgeNodeAccess(child.id, "owner", db).capabilities.canManageMembers, true);

  setKnowledgeNodeAccessMode({
    nodeId: root.id,
    accessMode: "inherit",
    actorUserId: "owner",
    db,
  });
  assert.equal(getKnowledgeNodeAccessPolicy(root.id, db).accessMode, "inherit");
  assert.equal(resolveKnowledgeNodeAccess(child.id, "excluded", db).capabilities.canView, true);

  // A single deny excludes only the target member; unrelated members retain workspace access.
  setKnowledgeNodeDenied({
    nodeId: root.id,
    targetUserId: "excluded",
    actorUserId: "owner",
    db,
  });
  assert.equal(getKnowledgeNodeAccessPolicy(root.id, db).accessMode, "inherit");
  assert.equal(resolveKnowledgeNodeAccess(child.id, "excluded", db).capabilities.canView, false);
  assert.equal(resolveKnowledgeNodeAccess(child.id, "other", db).capabilities.canView, true);

  // A more-specific child allow can re-open one descendant below a denied parent.
  setKnowledgeNodeRole({
    nodeId: child.id,
    targetUserId: "excluded",
    rolePreset: "readonly",
    actorUserId: "owner",
    db,
  });
  assert.equal(resolveKnowledgeNodeAccess(root.id, "excluded", db).capabilities.canView, false);
  assert.equal(resolveKnowledgeNodeAccess(child.id, "excluded", db).capabilities.canView, true);

  clearKnowledgeNodeRole({
    nodeId: child.id,
    targetUserId: "excluded",
    actorUserId: "owner",
    db,
  });
  assert.equal(resolveKnowledgeNodeAccess(child.id, "excluded", db).capabilities.canView, false);

  assert.equal(clearKnowledgeNodeDenied({
    nodeId: root.id,
    targetUserId: "excluded",
    actorUserId: "owner",
    db,
  }), true);
  assert.equal(resolveKnowledgeNodeAccess(child.id, "excluded", db).capabilities.canView, true);
});
