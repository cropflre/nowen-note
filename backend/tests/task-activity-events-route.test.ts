import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-activity-events-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let app: Hono;
let getDb: () => Database.Database;
let closeDb: (() => void) | undefined;

test.before(async () => {
  const schemaModule = await import("../src/db/schema.js");
  const [honoModule, statsModule] = await Promise.all([
    import("hono"),
    import("../src/runtime/task-stats-hardening"),
  ]);
  app = new honoModule.Hono();
  statsModule.installTaskStatsRoutes(app);
  statsModule.ensureTaskStatsSchema();
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("activity-user", "activity-user", "hash");
  db.prepare(`
    INSERT INTO tasks (id, userId, workspaceId, title, createdAt, updatedAt)
    VALUES (?, ?, NULL, ?, ?, ?)
  `).run(
    "task-live",
    "activity-user",
    "Live task",
    "2026-07-15 08:00:00",
    "2026-07-15 08:00:00",
  );
  db.prepare(`
    INSERT INTO tasks (id, userId, workspaceId, title, createdAt, updatedAt)
    VALUES (?, ?, NULL, ?, ?, ?)
  `).run(
    "task-deleted",
    "activity-user",
    "Deleted task",
    "2026-07-15 09:00:00",
    "2026-07-15 09:00:00",
  );
  db.prepare("DELETE FROM tasks WHERE id = ?").run("task-deleted");
});

test.after(() => {
  try {
    closeDb?.();
  } finally {
    fs.rmSync(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

test("activity API excludes deleted tasks while preserving the ledger", async () => {
  const deletedEventCount = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM task_activity_events
    WHERE taskId = ?
  `).get("task-deleted") as { count: number };
  assert.equal(deletedEventCount.count, 1);

  const response = await app.request(
    "/stats/activity-events?workspaceId=personal&from=2026-07-01&to=2026-07-31",
    { headers: { "X-User-Id": "activity-user" } },
  );

  assert.equal(response.status, 200);
  const events = await response.json() as Array<{ taskId: string }>;
  assert.deepEqual(events.map((event) => event.taskId), ["task-live"]);
});
