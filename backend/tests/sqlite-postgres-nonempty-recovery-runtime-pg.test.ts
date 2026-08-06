import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createSqlitePostgresMigrationRepository } from "../src/repositories/sqlitePostgresMigrationRepository";
import { createSqlitePostgresMigrationRuntime } from "../src/services/sqlite-postgres-migration-runtime";
import { createSqlitePostgresRollbackRuntime } from "../src/services/sqlite-postgres-rollback-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

function createSource(path: string): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name) VALUES (78, 'fixture');

      CREATE TABLE migration_recovery_fixture (
        id TEXT PRIMARY KEY,
        flag INTEGER NOT NULL,
        happenedAt TEXT NOT NULL,
        payload TEXT NOT NULL,
        bytes BLOB NOT NULL,
        bigValue INTEGER NOT NULL,
        note TEXT NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO migration_recovery_fixture
        (id, flag, happenedAt, payload, bytes, bigValue, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "updated-row",
      1,
      "2026-08-05 12:34:56",
      JSON.stringify({ source: true, nested: { value: 2 } }),
      Buffer.from([1, 2, 3, 4]),
      9007199254740991,
      "source updated value",
    );
    insert.run(
      "unchanged-row",
      0,
      "2026-08-05T00:00:00.000Z",
      JSON.stringify({ same: true }),
      Buffer.from([5, 6]),
      42,
      "same value",
    );
    insert.run(
      "inserted-row",
      1,
      "2026-08-06T00:00:00.000Z",
      JSON.stringify({ inserted: true }),
      Buffer.from([7, 8, 9]),
      100,
      "new value",
    );
  } finally {
    db.close();
  }
}

test("non-empty migration snapshots updated rows and rollback protects concurrent changes", {
  skip: !hasPg,
}, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const directory = mkdtempSync(join(tmpdir(), "nowen-pg-nonempty-"));
  const sourcePath = join(directory, "source.db");
  const backupPath = join(directory, "backup.db");

  try {
    await initPgSchema(pool);
    await pool.query(`DROP TABLE IF EXISTS migration_recovery_fixture`);
    await pool.query(`
      CREATE TABLE migration_recovery_fixture (
        id TEXT PRIMARY KEY,
        flag BOOLEAN NOT NULL,
        "happenedAt" TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL,
        bytes BYTEA NOT NULL,
        "bigValue" BIGINT NOT NULL,
        note TEXT NOT NULL
      )
    `);
    await pool.query("DELETE FROM sqlite_postgres_migration_row_changes");
    await pool.query("DELETE FROM sqlite_postgres_migration_batch_checkpoints");
    await pool.query("DELETE FROM sqlite_postgres_migration_table_checkpoints");
    await pool.query("DELETE FROM sqlite_postgres_migration_runs");
    await pool.query(
      `INSERT INTO migration_recovery_fixture
        (id, flag, "happenedAt", payload, bytes, "bigValue", note)
       VALUES
        ('updated-row', false, '2025-01-01T00:00:00Z', '{"original":true}', decode('aabb', 'hex'), 7, 'original target value'),
        ('unchanged-row', false, '2026-08-05T00:00:00Z', '{"same":true}', decode('0506', 'hex'), 42, 'same value'),
        ('extra-row', true, '2024-01-01T00:00:00Z', '{"extra":true}', decode('ff', 'hex'), 9, 'must remain')`,
    );

    createSource(sourcePath);
    cpSync(sourcePath, backupPath);
    const sourceMtime = statSync(sourcePath).mtimeMs;
    const backupMtime = statSync(backupPath).mtimeMs;

    const adapter = new PostgresAdapter(pool);
    const repository = createSqlitePostgresMigrationRepository(adapter);
    const migration = createSqlitePostgresMigrationRuntime(adapter, { repository });
    const rollback = createSqlitePostgresRollbackRuntime(adapter, { repository, batchSize: 2 });

    const blocked = await migration.dryRun({
      sourcePath,
      backupPath,
      allowNonEmptyTarget: true,
    });
    assert.equal(blocked.canApply, false);
    assert.ok(blocked.blockers.some(
      (blocker) => blocker.code === "POSTGRES_NON_EMPTY_CONFLICT_POLICY_REQUIRED",
    ));

    const applied = await migration.apply({
      idempotencyKey: "sqlite-pg-nonempty-001",
      sourcePath,
      backupPath,
      allowNonEmptyTarget: true,
      conflictPolicy: "overwrite-with-backup",
      batchSize: 2,
    });
    assert.equal(applied.snapshot.run.status, "completed");
    assert.equal(applied.snapshot.run.targetWasEmpty, false);

    const changes = await pool.query<{
      primaryKey: { id: string };
      changeKind: string;
      originalRow: Record<string, unknown> | null;
      migratedRow: Record<string, unknown> | null;
    }>(
      `SELECT "primaryKey", "changeKind", "originalRow", "migratedRow"
         FROM sqlite_postgres_migration_row_changes
        WHERE "runId" = $1
        ORDER BY "primaryKey"->>'id'`,
      [applied.snapshot.run.id],
    );
    assert.deepEqual(
      changes.rows.map((row) => [row.primaryKey.id, row.changeKind]),
      [
        ["inserted-row", "inserted"],
        ["unchanged-row", "unchanged"],
        ["updated-row", "updated"],
      ],
    );
    const updatedChange = changes.rows.find((row) => row.primaryKey.id === "updated-row")!;
    assert.ok(updatedChange.originalRow);
    assert.ok(updatedChange.migratedRow);
    assert.equal(updatedChange.originalRow?.note, "original target value");

    const verification = await migration.verify({
      idempotencyKey: "sqlite-pg-nonempty-001",
      backupPath,
    });
    assert.equal(verification.ok, true);
    assert.equal(
      Number((await pool.query(
        `SELECT COUNT(*) AS count FROM migration_recovery_fixture WHERE id = 'extra-row'`,
      )).rows[0].count),
      1,
    );

    await pool.query(
      `UPDATE migration_recovery_fixture SET note = 'user changed after migration'
        WHERE id = 'updated-row'`,
    );
    await assert.rejects(
      rollback.rollback({ runId: applied.snapshot.run.id }),
      (error: unknown) => error instanceof Error
        && error.message.includes("rollback 拒绝覆盖用户的新修改"),
    );
    assert.equal(
      (await pool.query(
        `SELECT note FROM migration_recovery_fixture WHERE id = 'updated-row'`,
      )).rows[0].note,
      "user changed after migration",
    );

    const migratedUpdated = updatedChange.migratedRow!;
    await pool.query(
      `UPDATE migration_recovery_fixture AS target
          SET flag = restored.flag,
              "happenedAt" = restored."happenedAt",
              payload = restored.payload,
              bytes = restored.bytes,
              "bigValue" = restored."bigValue",
              note = restored.note
         FROM jsonb_populate_record(
           NULL::migration_recovery_fixture,
           $1::jsonb
         ) AS restored
        WHERE target.id = 'updated-row'`,
      [JSON.stringify(migratedUpdated)],
    );

    const completed = await rollback.rollback({ runId: applied.snapshot.run.id });
    assert.equal(completed.complete, true);
    assert.equal(completed.totalTrackedRows, 3);
    const table = completed.tables.find(
      (entry) => entry.tableName === "migration_recovery_fixture",
    )!;
    assert.equal(table.insertedRows, 1);
    assert.equal(table.updatedRows, 1);
    assert.equal(table.unchangedRows, 1);
    assert.equal(table.deletedRows, 1);
    assert.equal(table.restoredRows, 1);

    const finalRows = await pool.query<{
      id: string;
      flag: boolean;
      happenedAt: Date;
      payload: Record<string, unknown>;
      bytes: Buffer;
      bigValue: string;
      note: string;
    }>(
      `SELECT id, flag, "happenedAt", payload, bytes, "bigValue", note
         FROM migration_recovery_fixture
        ORDER BY id`,
    );
    assert.deepEqual(finalRows.rows.map((row) => row.id), [
      "extra-row",
      "unchanged-row",
      "updated-row",
    ]);
    const restored = finalRows.rows.find((row) => row.id === "updated-row")!;
    assert.equal(restored.flag, false);
    assert.equal(restored.happenedAt.toISOString(), "2025-01-01T00:00:00.000Z");
    assert.deepEqual(restored.payload, { original: true });
    assert.equal(restored.bytes.toString("hex"), "aabb");
    assert.equal(restored.bigValue, "7");
    assert.equal(restored.note, "original target value");
    assert.equal(statSync(sourcePath).mtimeMs, sourceMtime);
    assert.equal(statSync(backupPath).mtimeMs, backupMtime);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS migration_recovery_fixture`).catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
    await closePgPool(pool);
  }
});
