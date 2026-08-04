import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("supports databases that recorded task migrations as versions 71 through 73", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-migration-compat-"));
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(tempDir, "test.db");
  const [{ getDb, closeDb }, { runMigrations, CURRENT_SCHEMA_VERSION }, { taskMetadataMigration }, { taskTimePlanningMigration }, { taskInboxMigration }] = await Promise.all([
    import("../src/db/schema.js"),
    import("../src/db/migrations.js"),
    import("../src/db/taskMetadataMigration.js"),
    import("../src/db/taskTimePlanningMigration.js"),
    import("../src/db/taskInboxMigration.js"),
  ]);
  const db = getDb();

  try {
    taskMetadataMigration.up(db);
    taskTimePlanningMigration.up(db);
    taskInboxMigration.up(db);
    db.prepare("DELETE FROM schema_migrations WHERE version >= 74").run();
    db.prepare("UPDATE schema_migrations SET name = ? WHERE version = 71")
      .run(taskMetadataMigration.name);
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(72, taskTimePlanningMigration.name);
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(73, taskInboxMigration.name);
    db.exec("DROP TABLE yjs_operation_receipts");

    assert.doesNotThrow(() => runMigrations(db));
    assert.equal(CURRENT_SCHEMA_VERSION, 77);
    for (const table of ["yjs_operation_receipts", "task_labels", "task_time_blocks", "task_inbox_items"]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    }
  } finally {
    closeDb();
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
