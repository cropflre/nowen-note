import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../src/db/migrations";

function createLegacyDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      title TEXT NOT NULL,
      isCompleted INTEGER NOT NULL DEFAULT 0,
      projectId TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

test("v44 does not invent completedAt from updatedAt", () => {
  const db = createLegacyDb();
  db.prepare(`
    INSERT INTO tasks (id, userId, title, isCompleted, updatedAt)
    VALUES ('legacy-done', 'u1', 'Legacy done', 1, '2025-01-02 03:04:05')
  `).run();
  const migration = MIGRATIONS.find((item) => item.version === 44);
  assert.ok(migration);
  migration.up(db);
  const row = db.prepare("SELECT completedAt FROM tasks WHERE id = 'legacy-done'").get() as {
    completedAt: string | null;
  };
  assert.equal(row.completedAt, null);
  db.close();
});

test("task activity ledger preserves completion history after reopen and delete", () => {
  const db = createLegacyDb();
  MIGRATIONS.find((item) => item.version === 44)!.up(db);
  MIGRATIONS.find((item) => item.version === 45)!.up(db);

  db.prepare(`
    INSERT INTO tasks (
      id, userId, workspaceId, title, isCompleted, completedAt, projectId, createdAt, updatedAt
    ) VALUES (?, ?, NULL, ?, 0, NULL, NULL, ?, ?)
  `).run("task-1", "u1", "Persistent history", "2026-07-01 08:00:00", "2026-07-01 08:00:00");

  db.prepare("UPDATE tasks SET isCompleted = 1, completedAt = ? WHERE id = ?")
    .run("2026-07-02T09:00:00.000Z", "task-1");
  db.prepare("UPDATE tasks SET isCompleted = 0, completedAt = NULL WHERE id = ?")
    .run("task-1");
  db.prepare("UPDATE tasks SET isCompleted = 1, completedAt = ? WHERE id = ?")
    .run("2026-07-05T10:00:00.000Z", "task-1");
  db.prepare("DELETE FROM tasks WHERE id = ?").run("task-1");

  const events = db.prepare(`
    SELECT eventType, occurredAt, taskTitle
    FROM task_activity_events
    ORDER BY occurredAt
  `).all() as Array<{ eventType: string; occurredAt: string; taskTitle: string }>;

  assert.deepEqual(events, [
    { eventType: "created", occurredAt: "2026-07-01T08:00:00Z", taskTitle: "Persistent history" },
    { eventType: "completed", occurredAt: "2026-07-02T09:00:00.000Z", taskTitle: "Persistent history" },
    { eventType: "completed", occurredAt: "2026-07-05T10:00:00.000Z", taskTitle: "Persistent history" },
  ]);
  db.close();
});
