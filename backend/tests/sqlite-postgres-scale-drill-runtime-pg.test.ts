import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import type { DatabaseAdapter, DbStatement } from "../src/db/adapters/types";
import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createSqlitePostgresMigrationDrillRuntime } from "../src/services/sqlite-postgres-migration-drill-runtime";
import { createSqlitePostgresMigrationRuntime } from "../src/services/sqlite-postgres-migration-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";
import {
  createSqlitePostgresDrillFixture,
  sqlitePostgresDrillFixtureIds,
} from "./helpers/sqlite-postgres-drill-fixture";

async function createTargetFixtures(pool: import("pg").Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migration_drill_accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      enabled BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      profile JSONB NOT NULL,
      avatar BYTEA NOT NULL,
      quota BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS migration_drill_events (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES migration_drill_accounts(id),
      kind TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);
}

async function reset(pool: import("pg").Pool): Promise<void> {
  await pool.query("TRUNCATE TABLE migration_drill_events, migration_drill_accounts CASCADE");
  await pool.query("DELETE FROM sqlite_postgres_migration_row_changes");
  await pool.query("DELETE FROM sqlite_postgres_migration_batch_checkpoints");
  await pool.query("DELETE FROM sqlite_postgres_migration_table_checkpoints");
  await pool.query("DELETE FROM sqlite_postgres_migration_runs");
}

async function dropTargetFixtures(pool: import("pg").Pool): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS migration_drill_events CASCADE");
  await pool.query("DROP TABLE IF EXISTS migration_drill_accounts CASCADE");
}

function transactionalFailureAdapter(base: PostgresAdapter): DatabaseAdapter {
  let injected = false;
  return {
    queryOne: base.queryOne.bind(base),
    queryMany: base.queryMany.bind(base),
    execute: base.execute.bind(base),
    executeBatch: base.executeBatch.bind(base),
    async executeStatements(statements: DbStatement[]) {
      if (!injected && statements.some((statement) => (
        statement.sql.includes("sqlite_postgres_migration_batch_checkpoints")
      ))) {
        injected = true;
        return base.executeStatements([
          ...statements,
          { sql: "INSERT INTO __sqlite_pg_forced_transaction_failure__ VALUES (1)" },
        ]);
      }
      return base.executeStatements(statements);
    },
  };
}

function readSourceRow(path: string, tableName: string, id: string): Record<string, unknown> {
  assert.match(tableName, /^[A-Za-z_][A-Za-z0-9_]*$/);
  const db = new Database(path);
  try {
    const row = db.prepare(`SELECT * FROM "${tableName}" WHERE id = ?`).get(id);
    assert.ok(row);
    return row as Record<string, unknown>;
  } finally {
    db.close();
  }
}

async function insertExactAccount(
  pool: import("pg").Pool,
  row: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO migration_drill_accounts
       (id, email, enabled, created_at, profile, avatar, quota)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      row.id,
      row.email,
      Number(row.enabled) === 1,
      row.created_at,
      row.profile,
      row.avatar,
      String(row.quota),
    ],
  );
}

async function insertExactEvent(
  pool: import("pg").Pool,
  row: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO migration_drill_events
       (id, account_id, kind, payload, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [row.id, row.account_id, row.kind, row.payload, row.created_at],
  );
}

test("medium empty-target drill resumes bounded apply and rollback and persists the final report", {
  skip: !hasPg,
}, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const directory = mkdtempSync(join(tmpdir(), "nowen-pg-drill-medium-"));
  const sourcePath = join(directory, "source.db");
  const backupPath = join(directory, "backup.db");
  try {
    await initPgSchema(pool);
    await createTargetFixtures(pool);
    await reset(pool);
    const fixture = createSqlitePostgresDrillFixture(sourcePath, "medium");
    cpSync(sourcePath, backupPath);
    const sourceMtime = statSync(sourcePath).mtimeMs;
    const backupMtime = statSync(backupPath).mtimeMs;

    const runtime = createSqlitePostgresMigrationDrillRuntime(new PostgresAdapter(pool));
    const report = await runtime.run({
      idempotencyKey: "sqlite-pg-drill-medium-001",
      sourcePath,
      backupPath,
      batchSize: 40,
      maxBatchesPerPass: 2,
      maxRollbackBatchesPerPass: 1,
    });

    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.scenario, "empty-target");
    assert.equal(report.source.totalRows, fixture.totalRows);
    assert(report.execution.applyPasses > 1);
    assert(report.execution.rollbackPasses > 1);
    assert.equal(report.stages.verify.ok, true);
    assert.equal(report.stages.rollback.complete, true);
    assert.equal(report.stages.postRollback.ok, true);
    assert.equal(report.summary.inserted, fixture.totalRows);
    assert.equal(report.summary.deleted, fixture.totalRows);
    assert.equal(report.summary.failures, 0);
    assert.equal(statSync(sourcePath).mtimeMs, sourceMtime);
    assert.equal(statSync(backupPath).mtimeMs, backupMtime);

    const target = await pool.query<{ accounts: string; events: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM migration_drill_accounts) AS accounts,
         (SELECT COUNT(*)::text FROM migration_drill_events) AS events`,
    );
    assert.deepEqual(target.rows[0], { accounts: "0", events: "0" });
    const persisted = await pool.query<{ report: Record<string, unknown> }>(
      `SELECT report FROM sqlite_postgres_migration_runs WHERE id = $1`,
      [report.runId],
    );
    assert.equal(persisted.rows[0].report.schemaVersion, 1);
    assert.equal(persisted.rows[0].report.ok, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await reset(pool).catch(() => undefined);
    await dropTargetFixtures(pool).catch(() => undefined);
    await closePgPool(pool);
  }
});

test("transaction failure leaves no partial business row or checkpoint and the same run resumes", {
  skip: !hasPg,
}, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const directory = mkdtempSync(join(tmpdir(), "nowen-pg-drill-failure-"));
  const sourcePath = join(directory, "source.db");
  const backupPath = join(directory, "backup.db");
  try {
    await initPgSchema(pool);
    await createTargetFixtures(pool);
    await reset(pool);
    createSqlitePostgresDrillFixture(sourcePath, "medium");
    cpSync(sourcePath, backupPath);

    const adapter = new PostgresAdapter(pool);
    const failingRuntime = createSqlitePostgresMigrationRuntime(
      transactionalFailureAdapter(adapter),
    );
    await assert.rejects(
      failingRuntime.apply({
        idempotencyKey: "sqlite-pg-drill-failure-001",
        sourcePath,
        backupPath,
        batchSize: 40,
      }),
    );
    const afterFailure = await pool.query<{
      accounts: string;
      events: string;
      batches: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM migration_drill_accounts) AS accounts,
         (SELECT COUNT(*)::text FROM migration_drill_events) AS events,
         (SELECT COUNT(*)::text FROM sqlite_postgres_migration_batch_checkpoints)
           AS batches`,
    );
    assert.deepEqual(afterFailure.rows[0], {
      accounts: "0",
      events: "0",
      batches: "0",
    });

    const report = await createSqlitePostgresMigrationDrillRuntime(adapter).run({
      idempotencyKey: "sqlite-pg-drill-failure-001",
      sourcePath,
      backupPath,
      batchSize: 40,
      maxBatchesPerPass: 3,
      maxRollbackBatchesPerPass: 2,
    });
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert(report.stages.apply.attempts >= 1);
    assert.equal(report.stages.postRollback.ok, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await reset(pool).catch(() => undefined);
    await dropTargetFixtures(pool).catch(() => undefined);
    await closePgPool(pool);
  }
});

test("large non-empty drill restores updated rows, preserves unchanged and unrelated rows", {
  skip: !hasPg,
}, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const directory = mkdtempSync(join(tmpdir(), "nowen-pg-drill-large-"));
  const sourcePath = join(directory, "source.db");
  const backupPath = join(directory, "backup.db");
  try {
    await initPgSchema(pool);
    await createTargetFixtures(pool);
    await reset(pool);
    createSqlitePostgresDrillFixture(sourcePath, "large");
    cpSync(sourcePath, backupPath);

    const account1 = sqlitePostgresDrillFixtureIds.accountId(1);
    const account2 = sqlitePostgresDrillFixtureIds.accountId(2);
    const event1 = sqlitePostgresDrillFixtureIds.eventId(1);
    const event2 = sqlitePostgresDrillFixtureIds.eventId(2);
    await pool.query(
      `INSERT INTO migration_drill_accounts
         (id, email, enabled, created_at, profile, avatar, quota)
       VALUES ($1, 'old@example.invalid', false, '2020-01-01T00:00:00Z',
               '{"before":true}'::jsonb, decode('00ff', 'hex'), 7)`,
      [account1],
    );
    await insertExactAccount(pool, readSourceRow(sourcePath, "migration_drill_accounts", account2));
    await pool.query(
      `INSERT INTO migration_drill_accounts
         (id, email, enabled, created_at, profile, avatar, quota)
       VALUES ('target-only', 'target-only@example.invalid', true,
               '2021-01-01T00:00:00Z', '{"targetOnly":true}'::jsonb,
               decode('01', 'hex'), 9)`,
    );
    await pool.query(
      `INSERT INTO migration_drill_events
         (id, account_id, kind, payload, created_at)
       VALUES ($1, $2, 'old', '{"before":true}'::jsonb, '2020-01-02T00:00:00Z')`,
      [event1, account1],
    );
    await insertExactEvent(pool, readSourceRow(sourcePath, "migration_drill_events", event2));
    await pool.query(
      `INSERT INTO migration_drill_events
         (id, account_id, kind, payload, created_at)
       VALUES ('target-only-event', 'target-only', 'target-only',
               '{"targetOnly":true}'::jsonb, '2021-01-02T00:00:00Z')`,
    );

    const report = await createSqlitePostgresMigrationDrillRuntime(
      new PostgresAdapter(pool),
    ).run({
      idempotencyKey: "sqlite-pg-drill-large-001",
      sourcePath,
      backupPath,
      allowNonEmptyTarget: true,
      conflictPolicy: "overwrite-with-backup",
      batchSize: 100,
      maxBatchesPerPass: 4,
      maxRollbackBatchesPerPass: 2,
    });

    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.scenario, "non-empty-target");
    assert(report.summary.inserted > 0);
    assert(report.summary.updated >= 2);
    assert(report.summary.unchanged >= 2);
    assert(report.summary.restored >= 2);
    assert.equal(report.summary.concurrentConflicts, 0);
    assert.equal(report.stages.postRollback.foreignKeyViolations.length, 0);

    const restoredAccount = await pool.query<{
      email: string;
      enabled: boolean;
      profile: unknown;
      quota: string;
    }>(
      `SELECT email, enabled, profile, quota::text
         FROM migration_drill_accounts WHERE id = $1`,
      [account1],
    );
    assert.deepEqual(restoredAccount.rows[0], {
      email: "old@example.invalid",
      enabled: false,
      profile: { before: true },
      quota: "7",
    });
    const restoredEvent = await pool.query<{ kind: string; payload: unknown }>(
      `SELECT kind, payload FROM migration_drill_events WHERE id = $1`,
      [event1],
    );
    assert.deepEqual(restoredEvent.rows[0], { kind: "old", payload: { before: true } });
    const preserved = await pool.query<{ accounts: string; events: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM migration_drill_accounts
           WHERE id IN ($1, $2, 'target-only')) AS accounts,
         (SELECT COUNT(*)::text FROM migration_drill_events
           WHERE id IN ($3, $4, 'target-only-event')) AS events`,
      [account1, account2, event1, event2],
    );
    assert.deepEqual(preserved.rows[0], { accounts: "3", events: "3" });
    const insertedSourceOnly = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM migration_drill_accounts WHERE id = $1`,
      [sqlitePostgresDrillFixtureIds.accountId(3)],
    );
    assert.equal(insertedSourceOnly.rows[0].count, "0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await reset(pool).catch(() => undefined);
    await dropTargetFixtures(pool).catch(() => undefined);
    await closePgPool(pool);
  }
});
