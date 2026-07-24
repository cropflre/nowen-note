import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureScopedTag } from "../src/services/tagScope";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tags (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#58a6ff',
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_tags_personal_name_unique
      ON tags(userId, lower(trim(name)))
      WHERE workspaceId IS NULL;
    CREATE UNIQUE INDEX idx_tags_workspace_name_unique
      ON tags(workspaceId, lower(trim(name)))
      WHERE workspaceId IS NOT NULL;
  `);
  return db;
}

test("personal tag creation reuses an existing normalized name", () => {
  const db = createDb();
  try {
    const first = ensureScopedTag(db, {
      id: "tag-1",
      userId: "u1",
      workspaceId: null,
      name: "React",
      color: "#111",
    });
    const second = ensureScopedTag(db, {
      id: "tag-2",
      userId: "u1",
      workspaceId: null,
      name: " react ",
      color: "#222",
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.tag.id, "tag-1");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM tags").get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test("workspace tag creation is shared by all editors in that workspace", () => {
  const db = createDb();
  try {
    const first = ensureScopedTag(db, {
      id: "tag-ws-1",
      userId: "u1",
      workspaceId: "ws-a",
      name: "开发",
      color: "#111",
    });
    const second = ensureScopedTag(db, {
      id: "tag-ws-2",
      userId: "u2",
      workspaceId: "ws-a",
      name: "开发",
      color: "#222",
    });
    const third = ensureScopedTag(db, {
      id: "tag-ws-3",
      userId: "u1",
      workspaceId: "ws-b",
      name: "开发",
      color: "#333",
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.tag.id, "tag-ws-1");
    assert.equal(third.created, true);
    assert.equal(third.tag.id, "tag-ws-3");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM tags").get() as { count: number }).count, 2);
  } finally {
    db.close();
  }
});
