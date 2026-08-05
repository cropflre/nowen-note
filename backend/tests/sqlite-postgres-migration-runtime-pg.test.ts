import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createSqlitePostgresMigrationRepository } from "../src/repositories/sqlitePostgresMigrationRepository";
import {
  createSqlitePostgresMigrationRuntime,
} from "../src/services/sqlite-postgres-migration-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const METADATA_TABLES = new Set([
  "postgres_schema_migrations",
  "postgres_migration_state",
  "sqlite_postgres_migration_runs",
  "sqlite_postgres_migration_table_checkpoints",
  "sqlite_postgres_migration_batch_checkpoints",
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

function createSource(path: string, extraUser = false): void {
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
    `);
    const insertUser = db.prepare(
      `INSERT INTO users (id, username, passwordHash, tokenVersion)
       VALUES (?, ?, 'hash', 0)`,
    );
    insertUser.run("migration-user-1", "migration-user-1");
    if (extraUser) insertUser.run("migration-user-2", "migration-user-2");
    db.prepare(
      `INSERT INTO workspaces (id, name, ownerId)
       VALUES ('migration-workspace-1', 'Migration workspace', 'migration-user-1')`,
    ).run();
  } finally {
    db.close();
  }
}

test("SQLite to PostgreSQL preflight and durable checkpoints are safe and resumable", {
  skip: !hasPg,
}, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const directory = mkdtempSync(join(tmpdir(), "nowen-pg-data-"));
  const sourcePath = join(directory, "source.db");
  const backupPath = join(directory, "backup.db");

  try {
    await initPgSchema(pool);
    await truncateBusinessTables(pool);
    await pool.query("DELETE FROM sqlite_postgres_migration_batch_checkpoints");
    await pool.query("DELETE FROM sqlite_postgres_migration_table_checkpoints");
    await pool.query("DELETE FROM sqlite_postgres_migration_runs");

    createSource(sourcePath);
    cpSync(sourcePath, backupPath);
    const sourceMtimeBefore = statSync(sourcePath).mtimeMs;

    const adapter = new PostgresAdapter(pool);
    const repository = createSqlitePostgresMigrationRepository(adapter);
    const runtime = createSqlitePostgresMigrationRuntime(adapter, { repository });

    const beforeDryRun = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sqlite_postgres_migration_runs",
    );
    const report = await runtime.dryRun({
      sourcePath,
      backupPath,
    });
    const afterDryRun = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sqlite_postgres_migration_runs",
    );

    assert.equal(report.canApply, true, JSON.stringify(report.blockers));
    assert.equal(report.backup.verified, true);
    assert.equal(report.target.targetWasEmpty, true);
    assert.equal(report.source.integrityOk, true);
    assert.equal(report.source.foreignKeyViolationCount, 0);
    assert.equal(report.source.sourcePathHint, "source.db");
    assert.equal(report.source.sourceSchemaVersion, 78);
    assert.deepEqual(
      report.plan.tables.map((table) => table.tableName),
      ["users", "workspaces"],
    );
    assert.deepEqual(
      report.plan.tables.map((table) => table.primaryKeyColumns),
      [["id"], ["id"]],
    );
    assert.equal(beforeDryRun.rows[0].count, afterDryRun.rows[0].count);
    assert.equal(statSync(sourcePath).mtimeMs, sourceMtimeBefore);

    const prepared = await runtime.prepareApply({
      idempotencyKey: "sqlite-pg-foundation-001",
      sourcePath,
      backupPath,
    });
    assert.equal(prepared.reused, false);
    assert.equal(prepared.snapshot.run.status, "planned");
    assert.equal(prepared.snapshot.run.totalTables, 2);
    assert.equal(prepared.snapshot.run.totalRows, 2);
    assert.deepEqual(
      prepared.snapshot.tables.map((table) => [
        table.tableName,
        table.dependencyOrder,
        table.status,
      ]),
      [
        ["users", 0, "planned"],
        ["workspaces", 1, "planned"],
      ],
    );

    const replay = await runtime.prepareApply({
      idempotencyKey: "sqlite-pg-foundation-001",
      sourcePath,
      backupPath,
    });
    assert.equal(replay.reused, true);
    assert.equal(replay.snapshot.run.id, prepared.snapshot.run.id);

    const firstClaim = await repository.claimNextTable({
      runId: prepared.snapshot.run.id,
      leaseSeconds: 30,
    });
    assert.ok(firstClaim);
    assert.equal(firstClaim.tableName, "users");

    const concurrentClaim = await repository.claimNextTable({
      runId: prepared.snapshot.run.id,
      leaseSeconds: 30,
    });
    assert.equal(concurrentClaim, null);

    await pool.query(
      `UPDATE sqlite_postgres_migration_table_checkpoints
          SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE "runId" = $1 AND "tableName" = 'users'`,
      [prepared.snapshot.run.id],
    );
    const recoveredClaim = await repository.claimNextTable({
      runId: prepared.snapshot.run.id,
      leaseSeconds: 30,
    });
    assert.ok(recoveredClaim);
    assert.equal(recoveredClaim.tableName, "users");
    assert.notEqual(recoveredClaim.leaseToken, firstClaim.leaseToken);

    await repository.markTableCopied({
      runId: recoveredClaim.runId,
      tableName: recoveredClaim.tableName,
      leaseToken: recoveredClaim.leaseToken,
      copiedRows: recoveredClaim.totalRows,
      lastCursor: { id: "migration-user-1" },
      sourceChecksum: "a".repeat(64),
    });
    const secondClaim = await repository.claimNextTable({
      runId: prepared.snapshot.run.id,
      leaseSeconds: 30,
    });
    assert.ok(secondClaim);
    assert.equal(secondClaim.tableName, "workspaces");

    await pool.query(
      `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
       VALUES ('pg-existing-user', 'pg-existing-user', 'hash', 0)`,
    );
    const blocked = await runtime.dryRun({
      sourcePath,
      backupPath,
    });
    assert.equal(blocked.canApply, false);
    assert(
      blocked.blockers.some((entry) => entry.code === "POSTGRES_TARGET_NOT_EMPTY"),
    );
    const overridden = await runtime.dryRun({
      sourcePath,
      backupPath,
      allowNonEmptyTarget: true,
    });
    assert.equal(
      overridden.blockers.some((entry) => entry.code === "POSTGRES_TARGET_NOT_EMPTY"),
      false,
    );

    await pool.query("DELETE FROM users WHERE id = 'pg-existing-user'");
    rmSync(sourcePath);
    rmSync(backupPath);
    createSource(sourcePath, true);
    cpSync(sourcePath, backupPath);

    await assert.rejects(
      runtime.prepareApply({
        idempotencyKey: "sqlite-pg-foundation-001",
        sourcePath,
        backupPath,
      }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "SQLITE_PG_MIGRATION_IDEMPOTENCY_CONFLICT",
        );
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await closePgPool(pool);
  }
});
