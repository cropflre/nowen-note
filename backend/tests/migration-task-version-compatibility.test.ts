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
    // 原断言硬编码 CURRENT_SCHEMA_VERSION === 77，导致此后每新增一条迁移都会
    // 误报失败（v78/79/80 引入时即已失败）。本用例真正要验证的是
    // "把任务迁移记成 v71-73 的历史库仍能升级到最新版本"，
    // 因此改为断言 canonical 任务迁移已被跨过，而不是锁定某个具体版本号。
    assert.ok(
      CURRENT_SCHEMA_VERSION >= 77,
      `迁移链最高版本不应回退到 77 以下，当前 ${CURRENT_SCHEMA_VERSION}`,
    );
    const applied = db.prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    assert.equal(
      applied.version,
      CURRENT_SCHEMA_VERSION,
      "历史库必须被升级到迁移链最新版本",
    );
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
