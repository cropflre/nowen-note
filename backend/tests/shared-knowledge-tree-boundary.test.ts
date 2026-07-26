import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-shared-tree-boundary-"));
process.env.DB_PATH = path.join(tempDir, "shared-tree-boundary.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("shared roots and descendants cannot cross server-side boundaries", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const {
    createKnowledgeChild,
    KnowledgeTreeError,
    moveKnowledgeNode,
  } = await import("../src/services/knowledgeTree.js");
  const { setKnowledgeNodeRole } = await import("../src/services/knowledgeCapabilities.js");

  const db = getDb();
  for (const userId of ["owner", "maintainer"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')")
      .run(userId, userId);
  }

  const firstRoot = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "共享根 A",
    db,
  });
  const firstChild = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: firstRoot.id,
    nodeType: "folder",
    title: "A 子目录",
    db,
  });
  const firstDocument = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: firstChild.id,
    nodeType: "note",
    title: "A 文档",
    db,
  });
  const secondRoot = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "共享根 B",
    db,
  });
  const secondChild = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: null,
    parentId: secondRoot.id,
    nodeType: "folder",
    title: "B 子目录",
    db,
  });

  for (const root of [firstRoot, secondRoot]) {
    setKnowledgeNodeRole({
      nodeId: root.id,
      targetUserId: "maintainer",
      rolePreset: "maintainer",
      actorUserId: "owner",
      db,
    });
  }

  assert.throws(
    () => moveKnowledgeNode({
      actorUserId: "maintainer",
      nodeId: firstRoot.id,
      parentId: firstChild.id,
      db,
    }),
    (error: unknown) => error instanceof KnowledgeTreeError
      && error.code === "KNOWLEDGE_SHARED_ROOT_MOVE_FORBIDDEN",
  );

  assert.throws(
    () => moveKnowledgeNode({
      actorUserId: "maintainer",
      nodeId: firstDocument.id,
      parentId: secondChild.id,
      db,
    }),
    (error: unknown) => error instanceof KnowledgeTreeError
      && error.code === "KNOWLEDGE_SHARED_ROOT_SCOPE_MISMATCH",
  );

  const moved = moveKnowledgeNode({
    actorUserId: "maintainer",
    nodeId: firstDocument.id,
    parentId: firstRoot.id,
    db,
  });
  assert.equal(moved.parentId, firstRoot.id);
});
