import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, getDb } from "../src/db/schema.js";

test.after(() => closeDb());

test("startup upgrades notes without colorMark before creating its index and preserves content", () => {
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("color-user", "color-user", "test-hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run("color-book", "color-user", "Legacy notebook");
  db.prepare("INSERT INTO notes (id, userId, notebookId, title, content, contentText) VALUES (?, ?, ?, ?, ?, ?)")
    .run("color-note", "color-user", "color-book", "Legacy note", "<p>Keep my content</p>", "Keep my content");

  // Recreate the pre-v115 shape without replacing the rest of the database.
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%colorMark%'").all() as Array<{ name: string }>;
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name.replace(/"/g, '""')}"`);
  db.exec("DROP INDEX idx_notes_color_mark; ALTER TABLE notes DROP COLUMN colorMark;");
  db.prepare("DELETE FROM schema_migrations WHERE version = 115").run();
  closeDb();

  const upgraded = getDb();
  assert.deepEqual(
    upgraded.prepare("SELECT title, content, contentText, colorMark FROM notes WHERE id = ?").get("color-note"),
    { title: "Legacy note", content: "<p>Keep my content</p>", contentText: "Keep my content", colorMark: null },
  );
  assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_notes_color_mark'").get());
  assert.ok(upgraded.prepare("SELECT 1 FROM schema_migrations WHERE version = 115").get());
  closeDb();
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM notes WHERE id = ?").get("color-note") as { count: number }).count, 1);
});
