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

const METADATA_TABLES = new Set([
  "postgres_schema_migrations",
  "postgres_migration_state",
  "sqlite_postgres_migration_runs",
  "sqlite_postgres_migration_table_checkpoints",
  "sqlite_postgres_migration_batch_checkpoints",
  "sqlite_postgres_migration_row_changes",
]);

function quoteIdentifier(value: string): string {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/);
  return `"${value}"`;
}

async function truncateBusinessTables(pool: import("pg").Pool): Promise<void> {
  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename`,
  );
  const tables = result.rows
    .map((row) => row.tablename)
    .filter((name) => !METADATA_TABLES.has(name));
  if (tables.length === 0) return;
  await pool.query(
    `TRUNCATE TABLE ${tables.map(quoteIdentifier).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

function createSource(path: string): void {
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name) VALUES (78, 'fixture');

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        passwordHash TEXT NOT NULL,
        tokenVersion INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ownerId TEXT NOT NULL,
        FOREIGN KEY (ownerId) REFERENCES users(id)
      );

      INSERT INTO users (id, username, passwordHash, tokenVersion)
      VALUES ('rollback-user-1', 'rollback-user-1', 'hash', 0);

      INSERT INTO workspaces (id, name, ownerId)
      VALUES ('rollback-workspace-1', 'Rollback workspace', 'rollback-user-1');
    `);
  } finally {
    db.close();
  }
}

test("SQLite migration records run-owned rows and rollback resumes in reverse dependency order", {
  skip: !hasPg,
}, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const directory = mkdtempSync(join(tmpdir(), "nowen-pg-rollback-"));
  const sourcePath = join(directory, "source.db");
  const backupPath = join(directory, "backup.db");

  try {
    await initPgSchema(pool);
    await truncateBusinessTables(pool);
    await pool.query("DELETE FROM sqlite_postgres_migration_row_changes");
    await pool.query("DELETE FROM sqlite_postgres_migration_batch_checkpoints");
    await pool.query("DELETE FROM sqlite_postgres_migration_table_checkpoints");
    await pool.query("DELETE FROM sqlite_postgres_migration_runs");

    createSource(sourcePath);
    cpSync(sourcePath, backupPath);
    const sourceMtime = statSync(sourcePath).mtimeMs;
    const backupMtime = statSync(backupPath).mtimeMs;

    const adapter = new PostgresAdapter(pool);
    const repository = createSqlitePostgresMigrationRepository(adapter);
    const migration = createSqlitePostgresMigrationRuntime(adapter, { repository });
    const rollback = createSqlitePostgresRollbackRuntime(adapter, {
      repository,
      batchSize: 1,
    });

    const applied = await migration.apply({
      idempotencyKey: "sqlite-pg-rollback-001",
      sourcePath,
      backupPath,
      batchSize: 1,
    });
    assert.equal(applied.snapshot.run.status, "completed");

    const ownership = await pool.query<{
      tableName: string;
      changeKind: string;
      rollbackStatus: string;
    }>(
      `SELECT "tableName", "changeKind", "rollbackStatus"
         FROM sqlite_postgres_migration_row_changes
        WHERE "runId" = $1
        ORDER BY "tableName"`,
      [applied.snapshot.run.id],
    );
    assert.deepEqual(ownership.rows, [
      { tableName: "users", changeKind: "inserted", rollbackStatus: "planned" },
      { tableName: "workspaces", changeKind: "inserted", rollbackStatus: "planned" },
    ]);

    const bounded = await rollback.rollback({
      runId: applied.snapshot.run.id,
      maxBatches: 1,
    });
    assert.equal(bounded.complete, false);
    assert.equal(bounded.totalRolledBackRows, 1);
    assert.equal(
      Number((await pool.query("SELECT COUNT(*) AS count FROM workspaces")).rows[0].count),
      0,
    );
    assert.equal(
      Number((await pool.query("SELECT COUNT(*) AS count FROM users")).rows[0].count),
      1,
    );

    const completed = await rollback.rollback({ runId: applied.snapshot.run.id });
    assert.equal(completed.ok, true);
    assert.equal(completed.complete, true);
    assert.equal(completed.totalTrackedRows, 2);
    assert.equal(completed.totalRolledBackRows, 2);
    assert.equal(
      Number((await pool.query("SELECT COUNT(*) AS count FROM workspaces")).rows[0].count),
      0,
    );
    assert.equal(
      Number((await pool.query("SELECT COUNT(*) AS count FROM users")).rows[0].count),
      0,
    );

    const run = await pool.query<{
      status: string;
      rollbackReport: Record<string, unknown>;
      rolledBackAt: Date | null;
    }>(
      `SELECT status, "rollbackReport", "rolledBackAt"
         FROM sqlite_postgres_migration_runs
        WHERE id = $1`,
      [applied.snapshot.run.id],
    );
    assert.equal(run.rows[0].status, "rolled_back");
    assert.equal(run.rows[0].rollbackReport.complete, true);
    assert.ok(run.rows[0].rolledBackAt);

    const replay = await rollback.rollback({ runId: applied.snapshot.run.id });
    assert.equal(replay.complete, true);
    assert.equal(replay.totalRolledBackRows, 2);
    assert.equal(statSync(sourcePath).mtimeMs, sourceMtime);
    assert.equal(statSync(backupPath).mtimeMs, backupMtime);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await closePgPool(pool);
  }
});
