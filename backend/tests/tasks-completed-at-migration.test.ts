import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../src/db/migrations";

function createLegacyDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      isCompleted INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 2,
      dueDate TEXT,
      dueAt TEXT,
      startDate TEXT,
      noteId TEXT,
      parentId TEXT,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      projectId TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      repeatRule TEXT DEFAULT 'none',
      repeatInterval INTEGER DEFAULT 1,
      repeatEndDate TEXT,
      repeatGroupId TEXT,
      repeatGeneratedFromId TEXT,
      repeatNextGeneratedId TEXT,
      repeatEndCount INTEGER,
      repeatSequenceIndex INTEGER,
      repeatRuleJson TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO tasks (id, userId, title, isCompleted, status, updatedAt)
    VALUES
      ('task-done', 'user-1', 'Done task', 1, 'done', '2026-07-08T09:30:00'),
      ('task-open', 'user-1', 'Open task', 0, 'todo', '2026-07-08T10:00:00');
  `);
  return db;
}

test("tasks-completed-at migration adds the column without inventing history", () => {
  const migration = MIGRATIONS.find((m) => m.name === "tasks-completed-at");
  assert.ok(migration, "tasks-completed-at migration should be registered");

  const db = createLegacyDb();
  migration.up(db);

  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  assert.ok(cols.some((col) => col.name === "completedAt"));

  const rows = db.prepare("SELECT id, isCompleted, completedAt FROM tasks ORDER BY id").all() as Array<{
    id: string;
    isCompleted: number;
    completedAt: string | null;
  }>;

  assert.deepEqual(rows, [
    { id: "task-done", isCompleted: 1, completedAt: null },
    { id: "task-open", isCompleted: 0, completedAt: null },
  ]);
  db.close();
});

test("tasks-completed-at migration clears stale completedAt on incomplete rows", () => {
  const migration = MIGRATIONS.find((m) => m.name === "tasks-completed-at");
  assert.ok(migration, "tasks-completed-at migration should be registered");

  const db = createLegacyDb();
  db.prepare("ALTER TABLE tasks ADD COLUMN completedAt TEXT").run();
  db.prepare("UPDATE tasks SET completedAt = ? WHERE id = 'task-open'").run("2026-07-01T08:00:00");
  migration.up(db);

  const row = db.prepare("SELECT isCompleted, completedAt FROM tasks WHERE id = 'task-open'").get() as {
    isCompleted: number;
    completedAt: string | null;
  };
  assert.equal(row.isCompleted, 0);
  assert.equal(row.completedAt, null);
  db.close();
});
