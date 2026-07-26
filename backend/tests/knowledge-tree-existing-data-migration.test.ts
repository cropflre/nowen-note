import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { ensureKnowledgeTreeTables } from "../src/db/knowledgeTreeMigrationCore.js";

test("knowledge tree migration preserves existing deleted subtrees", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE notebooks (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      parentId TEXT,
      name TEXT NOT NULL,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      isExpanded INTEGER NOT NULL DEFAULT 1,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      deletedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      notebookId TEXT,
      title TEXT NOT NULL,
      contentFormat TEXT,
      note_type TEXT,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      isTrashed INTEGER NOT NULL DEFAULT 0,
      trashedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    INSERT INTO users (id) VALUES ('user-1');
    INSERT INTO notebooks
      (id, userId, parentId, name, isDeleted, deletedAt, createdAt, updatedAt)
    VALUES
      ('deleted-child', 'user-1', 'deleted-parent', 'Child', 1, '2026-01-01', '2026-01-01', '2026-01-01'),
      ('deleted-parent', 'user-1', NULL, 'Parent', 1, '2026-01-01', '2026-01-01', '2026-01-01');
    INSERT INTO notes
      (id, userId, notebookId, title, contentFormat, note_type, isTrashed, trashedAt, createdAt, updatedAt)
    VALUES
      ('deleted-note', 'user-1', 'deleted-child', 'Note', 'markdown', 'note', 1, '2026-01-01', '2026-01-01', '2026-01-01');
  `);

  try {
    ensureKnowledgeTreeTables(db);

    const child = db.prepare("SELECT parentId, isDeleted FROM knowledge_tree_nodes WHERE id = ?")
      .get("notebook:deleted-child") as { parentId: string | null; isDeleted: number };
    const note = db.prepare("SELECT parentId, isDeleted FROM knowledge_tree_nodes WHERE id = ?")
      .get("note:deleted-note") as { parentId: string | null; isDeleted: number };
    assert.deepEqual(child, { parentId: "notebook:deleted-parent", isDeleted: 1 });
    assert.deepEqual(note, { parentId: "notebook:deleted-child", isDeleted: 1 });
  } finally {
    db.close();
  }
});
