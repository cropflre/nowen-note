import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { tagScopeUniquenessMigration } from "../src/db/tagScopeUniquenessMigration";

type ForeignKeyViolation = {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
};

function createLegacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#58a6ff',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      workspaceId TEXT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(userId, name)
    );
    CREATE TABLE note_tags (
      noteId TEXT NOT NULL,
      tagId TEXT NOT NULL,
      PRIMARY KEY (noteId, tagId),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE TABLE user_sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  db.prepare("INSERT INTO users (id) VALUES (?), (?)").run("u1", "u2");
  db.prepare("INSERT INTO notes (id) VALUES (?), (?)").run("n1", "n2");
  return db;
}

test("v59 merges historical duplicates and preserves note relations", () => {
  const db = createLegacyDb();
  try {
    const insertTag = db.prepare(`
      INSERT INTO tags (id, userId, workspaceId, name, color, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertTag.run("personal-old", "u1", null, "React", "#111", "2026-01-01 00:00:00");
    insertTag.run("personal-dup", "u1", null, " react ", "#222", "2026-01-02 00:00:00");
    insertTag.run("workspace-old", "u1", "ws-a", "Shared", "#333", "2026-01-01 00:00:00");
    insertTag.run("workspace-dup", "u2", "ws-a", "shared", "#444", "2026-01-02 00:00:00");

    const link = db.prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, ?)");
    link.run("n1", "personal-old");
    link.run("n1", "personal-dup");
    link.run("n2", "workspace-old");
    link.run("n2", "workspace-dup");

    tagScopeUniquenessMigration.up(db);

    const personal = db.prepare(`
      SELECT id, name FROM tags
      WHERE userId = 'u1' AND workspaceId IS NULL AND lower(trim(name)) = 'react'
    `).all() as Array<{ id: string; name: string }>;
    assert.deepEqual(personal, [{ id: "personal-old", name: "React" }]);

    const workspace = db.prepare(`
      SELECT id, name FROM tags
      WHERE workspaceId = 'ws-a' AND lower(trim(name)) = 'shared'
    `).all() as Array<{ id: string; name: string }>;
    assert.deepEqual(workspace, [{ id: "workspace-old", name: "Shared" }]);

    assert.deepEqual(
      db.prepare("SELECT noteId, tagId FROM note_tags ORDER BY noteId").all(),
      [
        { noteId: "n1", tagId: "personal-old" },
        { noteId: "n2", tagId: "workspace-old" },
      ],
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("v59 enforces personal and workspace scoped names", () => {
  const db = createLegacyDb();
  try {
    db.prepare(`
      INSERT INTO tags (id, userId, workspaceId, name, color, createdAt)
      VALUES ('personal', 'u1', NULL, 'React', '#111', '2026-01-01 00:00:00')
    `).run();
    db.prepare(`
      INSERT INTO tags (id, userId, workspaceId, name, color, createdAt)
      VALUES ('workspace', 'u1', 'ws-a', 'Shared', '#222', '2026-01-01 00:00:00')
    `).run();

    tagScopeUniquenessMigration.up(db);

    assert.throws(() => {
      db.prepare("INSERT INTO tags (id, userId, workspaceId, name) VALUES (?, ?, ?, ?)")
        .run("personal-dup", "u1", null, " react ");
    }, /UNIQUE/);

    assert.throws(() => {
      db.prepare("INSERT INTO tags (id, userId, workspaceId, name) VALUES (?, ?, ?, ?)")
        .run("workspace-dup", "u2", "ws-a", "shared");
    }, /UNIQUE/);

    db.prepare("INSERT INTO tags (id, userId, workspaceId, name) VALUES (?, ?, ?, ?)")
      .run("workspace-other", "u1", "ws-b", "Shared");
    db.prepare("INSERT INTO tags (id, userId, workspaceId, name) VALUES (?, ?, ?, ?)")
      .run("personal-other", "u2", null, "React");

    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM tags").get() as { count: number }).count, 4);
  } finally {
    db.close();
  }
});

test("v59 repairs orphaned user sessions left by a 1.2.x database", () => {
  const db = createLegacyDb();
  try {
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO user_sessions (id, userId) VALUES (?, ?)")
      .run("legacy-session", "deleted-user");
    db.pragma("foreign_keys = ON");

    const before = db.prepare("PRAGMA foreign_key_check").all() as ForeignKeyViolation[];
    assert.equal(before.filter((error) => error.table === "user_sessions").length, 1);

    assert.doesNotThrow(() => tagScopeUniquenessMigration.up(db));
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM user_sessions").get() as { count: number }).count,
      0,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("v59 does not report unrelated legacy foreign key errors as tag migration failures", () => {
  const db = createLegacyDb();
  try {
    db.exec(`
      CREATE TABLE legacy_refs (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO legacy_refs (id, userId) VALUES (?, ?)")
      .run("legacy-ref", "deleted-user");
    db.pragma("foreign_keys = ON");

    assert.doesNotThrow(() => tagScopeUniquenessMigration.up(db));

    const remaining = db.prepare("PRAGMA foreign_key_check").all() as ForeignKeyViolation[];
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].table, "legacy_refs");
  } finally {
    db.close();
  }
});
