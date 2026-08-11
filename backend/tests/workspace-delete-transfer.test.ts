import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { installNotebookTreeIntegrityGuards } from "../src/runtime/notebook-tree-hardening";
import { transferWorkspaceNotesToOwner } from "../src/services/workspace-deletion";

test("workspace deletion transfers notes and preserves nested notebook hierarchy", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      ownerId TEXT NOT NULL,
      FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE workspace_members (
      workspaceId TEXT NOT NULL,
      userId TEXT NOT NULL,
      PRIMARY KEY (workspaceId, userId),
      FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
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

  try {
    db.exec(`
      INSERT INTO users (id) VALUES ('owner');
      INSERT INTO workspaces (id, ownerId) VALUES ('workspace', 'owner');
      INSERT INTO workspace_members (workspaceId, userId) VALUES ('workspace', 'owner');
      INSERT INTO notebooks (id, userId, workspaceId, parentId)
      VALUES ('root', 'owner', 'workspace', NULL),
             ('child', 'owner', 'workspace', 'root');
      INSERT INTO notes (id, userId, workspaceId, notebookId)
      VALUES ('note', 'owner', 'workspace', 'child');
    `);

    db.transaction(() => {
      transferWorkspaceNotesToOwner(db, "workspace", "owner");
      db.prepare("DELETE FROM workspaces WHERE id = ?").run("workspace");
    })();

    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspaces").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspace_members").get().count, 0);
    assert.deepEqual(
      db.prepare("SELECT id, userId, workspaceId, parentId FROM notebooks ORDER BY id").all(),
      [
        { id: "child", userId: "owner", workspaceId: null, parentId: "root" },
        { id: "root", userId: "owner", workspaceId: null, parentId: null },
      ],
    );
    assert.deepEqual(
      db.prepare("SELECT id, userId, workspaceId, notebookId FROM notes").get(),
      { id: "note", userId: "owner", workspaceId: null, notebookId: "child" },
    );
  } finally {
    db.close();
  }
});
