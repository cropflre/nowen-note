import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { installNotebookTreeIntegrityGuards } from "../src/runtime/notebook-tree-hardening";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE notebooks (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      parentId TEXT,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (parentId) REFERENCES notebooks(id)
    );

    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      notebookId TEXT NOT NULL,
      FOREIGN KEY (notebookId) REFERENCES notebooks(id)
    );
  `);
  installNotebookTreeIntegrityGuards(db);
  return db;
}

function insertNotebook(
  db: Database.Database,
  id: string,
  parentId: string | null = null,
  workspaceId: string | null = null,
  userId = "user-1",
): void {
  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, isDeleted)
    VALUES (?, ?, ?, ?, 0)
  `).run(id, userId, workspaceId, parentId);
}

test("moving a child notebook to root preserves every note notebookId", () => {
  const db = createDb();
  try {
    insertNotebook(db, "root");
    insertNotebook(db, "child", "root");
    db.prepare(`
      INSERT INTO notes (id, userId, workspaceId, notebookId)
      VALUES ('root-note', 'user-1', NULL, 'root'),
             ('child-note', 'user-1', NULL, 'child')
    `).run();

    const before = db.prepare("SELECT id, notebookId FROM notes ORDER BY id").all();
    const result = db.prepare("UPDATE notebooks SET parentId = NULL WHERE id = 'child'").run();
    const after = db.prepare("SELECT id, notebookId FROM notes ORDER BY id").all();

    assert.equal(result.changes, 1);
    assert.deepEqual(after, before);
    assert.equal(
      (db.prepare("SELECT parentId FROM notebooks WHERE id = 'child'").get() as { parentId: string | null }).parentId,
      null,
    );

    const history = db.prepare(`
      SELECT notebookId, oldParentId, newParentId
      FROM notebook_tree_history
      WHERE notebookId = 'child'
    `).get() as { notebookId: string; oldParentId: string | null; newParentId: string | null };
    assert.deepEqual(history, { notebookId: "child", oldParentId: "root", newParentId: null });
  } finally {
    db.close();
  }
});

test("rejects moving a notebook into its own descendant", () => {
  const db = createDb();
  try {
    insertNotebook(db, "root");
    insertNotebook(db, "child", "root");
    insertNotebook(db, "grandchild", "child");

    assert.throws(
      () => db.prepare("UPDATE notebooks SET parentId = 'grandchild' WHERE id = 'root'").run(),
      /NOTEBOOK_PARENT_CYCLE/,
    );
    assert.equal(
      (db.prepare("SELECT parentId FROM notebooks WHERE id = 'root'").get() as { parentId: string | null }).parentId,
      null,
    );
  } finally {
    db.close();
  }
});

test("rejects cross-workspace and cross-user personal parent assignments", () => {
  const db = createDb();
  try {
    insertNotebook(db, "personal-a", null, null, "user-1");
    insertNotebook(db, "personal-b", null, null, "user-2");
    insertNotebook(db, "workspace-a", null, "workspace-1", "user-1");
    insertNotebook(db, "workspace-b", null, "workspace-2", "user-2");

    assert.throws(
      () => db.prepare("UPDATE notebooks SET parentId = 'personal-b' WHERE id = 'personal-a'").run(),
      /NOTEBOOK_PARENT_SCOPE_MISMATCH/,
    );
    assert.throws(
      () => db.prepare("UPDATE notebooks SET parentId = 'workspace-b' WHERE id = 'workspace-a'").run(),
      /NOTEBOOK_PARENT_SCOPE_MISMATCH/,
    );
  } finally {
    db.close();
  }
});

test("rejects blank, missing, deleted and self parents", () => {
  const db = createDb();
  try {
    insertNotebook(db, "root");
    insertNotebook(db, "deleted");
    db.prepare("UPDATE notebooks SET isDeleted = 1 WHERE id = 'deleted'").run();

    assert.throws(
      () => db.prepare("UPDATE notebooks SET parentId = '' WHERE id = 'root'").run(),
      /NOTEBOOK_PARENT_EMPTY/,
    );
    assert.throws(
      () => db.prepare("UPDATE notebooks SET parentId = 'missing' WHERE id = 'root'").run(),
      /NOTEBOOK_PARENT_NOT_FOUND/,
    );
    assert.throws(
      () => db.prepare("UPDATE notebooks SET parentId = 'deleted' WHERE id = 'root'").run(),
      /NOTEBOOK_PARENT_NOT_FOUND/,
    );
    assert.throws(
      () => db.prepare("UPDATE notebooks SET parentId = 'root' WHERE id = 'root'").run(),
      /NOTEBOOK_PARENT_SELF/,
    );
  } finally {
    db.close();
  }
});
