import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-notebook-owner-transfer-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.ELECTRON_USER_DATA = dir;

let closeDb: () => void;

test("personal notebook owner can transfer the complete subtree to an existing collaborator", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  const [schema, transferModule] = await Promise.all([
    import("../src/db/schema"),
    import("../src/services/notebookOwnershipTransfer"),
  ]);
  closeDb = schema.closeDb;
  const db = schema.getDb();

  for (const id of ["owner", "target", "outsider"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(id, id);
  }
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name) VALUES ('root', 'owner', NULL, 'Root')").run();
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name) VALUES ('child', 'owner', 'root', 'Child')").run();
  db.prepare("INSERT INTO notes (id, userId, notebookId, title) VALUES ('note', 'owner', 'child', 'Note')").run();
  db.prepare(
    `INSERT INTO notebook_members (id, notebookId, userId, role, status, invitedBy)
     VALUES ('root:target', 'root', 'target', 'editor', 'active', 'owner')`,
  ).run();

  assert.throws(
    () => transferModule.transferNotebookOwnership({
      notebookId: "root",
      actorUserId: "owner",
      targetUserId: "outsider",
    }, db),
    (error: unknown) =>
      error instanceof transferModule.NotebookOwnershipTransferError &&
      error.code === "TARGET_NOT_COLLABORATOR",
  );

  const result = transferModule.transferNotebookOwnership({
    notebookId: "root",
    actorUserId: "owner",
    targetUserId: "target",
  }, db);
  assert.equal(result.previousOwnerId, "owner");
  assert.equal(result.newOwnerId, "target");
  assert.equal(result.notebookCount, 2);
  assert.equal(result.noteCount, 1);

  const notebooks = db.prepare("SELECT id, userId, parentId FROM notebooks ORDER BY id").all() as Array<{
    id: string;
    userId: string;
    parentId: string | null;
  }>;
  assert.deepEqual(notebooks, [
    { id: "child", userId: "target", parentId: "root" },
    { id: "root", userId: "target", parentId: null },
  ]);
  const note = db.prepare("SELECT userId FROM notes WHERE id = 'note'").get() as { userId: string };
  assert.equal(note.userId, "target");

  const knowledgeNodes = db.prepare(
    `SELECT id, userId, scopeKey, parentId
       FROM knowledge_tree_nodes
      WHERE id IN ('notebook:root', 'notebook:child', 'note:note')
      ORDER BY id`,
  ).all() as Array<{
    id: string;
    userId: string;
    scopeKey: string;
    parentId: string | null;
  }>;
  assert.deepEqual(knowledgeNodes, [
    { id: "note:note", userId: "target", scopeKey: "personal:target", parentId: "notebook:child" },
    { id: "notebook:child", userId: "target", scopeKey: "personal:target", parentId: "notebook:root" },
    { id: "notebook:root", userId: "target", scopeKey: "personal:target", parentId: null },
  ]);

  const memberships = db.prepare(
    "SELECT userId, role, status FROM notebook_members WHERE notebookId = 'root' ORDER BY role DESC, userId ASC",
  ).all() as Array<{ userId: string; role: string; status: string }>;
  assert.deepEqual(memberships, [
    { userId: "target", role: "owner", status: "active" },
    { userId: "owner", role: "editor", status: "active" },
  ]);
});

test("permission runtime registers summary and transfer endpoints", () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(currentDir, "../src/runtime/notebook-permission-management.ts"),
    "utf8",
  );
  assert.match(source, /\/:id\/permission-summary/);
  assert.match(source, /\/:id\/transfer-owner/);
  assert.match(source, /resolveNotebookPermission/);
  assert.match(source, /transferNotebookOwnership/);
});

test.after(() => {
  closeDb?.();
  fs.rmSync(dir, { recursive: true, force: true });
});
