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

async function resetMigrationMetadata(pool: import("pg").Pool): Promise<void> {
  await pool.query("DELETE FROM sqlite_postgres_migration_batch_checkpoints");
  await pool.query("DELETE FROM sqlite_postgres_migration_table_checkpoints");
  await pool.query("DELETE FROM sqlite_postgres_migration_runs");
}

async function createTargetFixtures(pool: import("pg").Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migration_type_fixture (
      id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL,
      bytes BYTEA NOT NULL,
      counter BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS migration_tree_fixture (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES migration_tree_fixture(id),
      label TEXT NOT NULL
    );
  `);
}

async function dropTargetFixtures(pool: import("pg").Pool): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS migration_tree_fixture CASCADE");
  await pool.query("DROP TABLE IF EXISTS migration_type_fixture CASCADE");
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

      CREATE TABLE migration_type_fixture (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        bytes BLOB NOT NULL,
        counter INTEGER NOT NULL
      );

      CREATE TABLE migration_tree_fixture (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        label TEXT NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES migration_tree_fixture(id)
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
    const insertType = db.prepare(
      `INSERT INTO migration_type_fixture
         (id, enabled, created_at, payload, bytes, counter)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertType.run(
      "type-1",
      1,
      "2026-08-05 08:00:00",
      JSON.stringify({ nested: { ok: true }, list: [1, 2, 3] }),
      Buffer.from([0, 1, 2, 255]),
      9_007_199_254_740_000n,
    );
    insertType.run(
      "type-2",
      0,
      "2026-08-05T09:30:00Z",
      JSON.stringify({ message: "migration" }),
      Buffer.from("nowen"),
      42,
    );
    db.prepare(
      `INSERT INTO migration_tree_fixture (id, parent_id, label)
       VALUES ('z-parent', NULL, 'Parent')`,
    ).run();
    db.prepare(
      `INSERT INTO migration_tree_fixture (id, parent_id, label)
       VALUES ('a-child', 'z-parent', 'Child')`,
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
  const directory = mkdtempSync(join(tmpdir(), "nowen-pg-data-foundation-"));
  const sourcePath = join(directory, "source.db");
  const backupPath = join(directory, "backup.db");

  try {
    await initPgSchema(pool);
    await createTargetFixtures(pool);
    await truncateBusinessTables(pool);
    await resetMigrationMetadata(pool);

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
      batchSize: 1,
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
    assert.equal(report.plan.execution.batchSize, 1);
    assert.deepEqual(
      report.plan.tables.map((table) => table.tableName),
      ["migration_tree_fixture", "migration_type_fixture", "users", "workspaces"],
    );
    assert.equal(
      report.warnings.some((warning) => warning.code === "SQLITE_SELF_REFERENTIAL_TABLES"),
      true,
    );
    assert.equal(beforeDryRun.rows[0].count, afterDryRun.rows[0].count);
    assert.equal(statSync(sourcePath).mtimeMs, sourceMtimeBefore);

    const prepared = await runtime.prepareApply({
      idempotencyKey: "sqlite-pg-foundation-001",
      sourcePath,
      backupPath,
      batchSize: 1,
    });
    assert.equal(prepared.reused, false);
    assert.equal(prepared.snapshot.run.status, "planned");
    assert.equal(prepared.snapshot.run.totalTables, 4);
    assert.equal(prepared.snapshot.run.totalRows, 6);

    const replay = await runtime.prepareApply({
      idempotencyKey: "sqlite-pg-foundation-001",
      sourcePath,
      backupPath,
      batchSize: 1,
    });
    assert.equal(replay.reused, true);
    assert.equal(replay.snapshot.run.id, prepared.snapshot.run.id);

    const firstClaim = await repository.claimNextTable({
      runId: prepared.snapshot.run.id,
      leaseSeconds: 30,
    });
    assert.ok(firstClaim);
    assert.equal(firstClaim.tableName, "migration_tree_fixture");

    const concurrentClaim = await repository.claimNextTable({
      runId: prepared.snapshot.run.id,
      leaseSeconds: 30,
    });
    assert.equal(concurrentClaim, null);

    await pool.query(
      `UPDATE sqlite_postgres_migration_table_checkpoints
          SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE "runId" = $1 AND "tableName" = 'migration_tree_fixture'`,
      [prepared.snapshot.run.id],
    );
    const recoveredClaim = await repository.claimNextTable({
      runId: prepared.snapshot.run.id,
      leaseSeconds: 30,
    });
    assert.ok(recoveredClaim);
    assert.equal(recoveredClaim.tableName, "migration_tree_fixture");
    assert.notEqual(recoveredClaim.leaseToken, firstClaim.leaseToken);

    await repository.markTableCopied({
      runId: recoveredClaim.runId,
      tableName: recoveredClaim.tableName,
      leaseToken: recoveredClaim.leaseToken,
      copiedRows: recoveredClaim.totalRows,
      lastCursor: { id: "z-parent" },
      sourceChecksum: "a".repeat(64),
    });

    await pool.query(
      `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
       VALUES ('pg-existing-user', 'pg-existing-user', 'hash', 0)`,
    );
    const blocked = await runtime.dryRun({ sourcePath, backupPath });
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
        batchSize: 1,
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
    await truncateBusinessTables(pool).catch(() => undefined);
    await resetMigrationMetadata(pool).catch(() => undefined);
    await dropTargetFixtures(pool).catch(() => undefined);
    await closePgPool(pool);
  }
});

test("SQLite to PostgreSQL apply is transactional, resumable, idempotent and independently verifiable", {
  skip: !hasPg,
}, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const directory = mkdtempSync(join(tmpdir(), "nowen-pg-data-copy-"));
  const sourcePath = join(directory, "source.db");
  const backupPath = join(directory, "backup.db");

  try {
    await initPgSchema(pool);
    await createTargetFixtures(pool);
    await truncateBusinessTables(pool);
    await resetMigrationMetadata(pool);
    createSource(sourcePath);
    cpSync(sourcePath, backupPath);
    const sourceMtimeBefore = statSync(sourcePath).mtimeMs;
    const backupMtimeBefore = statSync(backupPath).mtimeMs;

    const adapter = new PostgresAdapter(pool);
    const runtime = createSqlitePostgresMigrationRuntime(adapter);
    const first = await runtime.apply({
      idempotencyKey: "sqlite-pg-copy-resume-001",
      sourcePath,
      backupPath,
      batchSize: 1,
      maxBatches: 1,
    });
    assert.notEqual(first.snapshot.run.status, "completed");
    assert.equal(first.snapshot.run.copiedRows, 1);
    const firstBatchCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM sqlite_postgres_migration_batch_checkpoints
        WHERE "runId" = $1`,
      [first.snapshot.run.id],
    );
    assert.equal(firstBatchCount.rows[0].count, "1");

    const resumed = await runtime.apply({
      idempotencyKey: "sqlite-pg-copy-resume-001",
      sourcePath,
      backupPath,
      batchSize: 1,
    });
    assert.equal(resumed.reused, true);
    assert.equal(resumed.snapshot.run.status, "completed");
    assert.equal(resumed.snapshot.run.copiedRows, 6);
    assert.equal(resumed.snapshot.run.verifiedRows, 6);
    assert.equal(resumed.snapshot.progress.complete, true);
    assert(resumed.snapshot.tables.every((table) => table.status === "verified"));
    assert(resumed.snapshot.tables.every((table) => table.sourceChecksum === table.targetChecksum));

    const typeRows = await pool.query<{
      id: string;
      enabled: boolean;
      created_at: Date;
      payload: unknown;
      bytes: Buffer;
      counter: string;
    }>(
      `SELECT id, enabled, created_at, payload, bytes, counter::text
         FROM migration_type_fixture
        ORDER BY id`,
    );
    assert.equal(typeRows.rows.length, 2);
    assert.equal(typeRows.rows[0].enabled, true);
    assert.equal(typeRows.rows[0].created_at.toISOString(), "2026-08-05T08:00:00.000Z");
    assert.deepEqual(typeRows.rows[0].payload, { nested: { ok: true }, list: [1, 2, 3] });
    assert.deepEqual(typeRows.rows[0].bytes, Buffer.from([0, 1, 2, 255]));
    assert.equal(typeRows.rows[0].counter, "9007199254740000");
    assert.equal(typeRows.rows[1].enabled, false);

    const treeRows = await pool.query<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM migration_tree_fixture ORDER BY id`,
    );
    assert.deepEqual(treeRows.rows, [
      { id: "a-child", parent_id: "z-parent" },
      { id: "z-parent", parent_id: null },
    ]);

    const users = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users WHERE id LIKE 'migration-user-%'`,
    );
    const workspaces = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM workspaces WHERE id = 'migration-workspace-1'`,
    );
    assert.equal(users.rows[0].count, "1");
    assert.equal(workspaces.rows[0].count, "1");

    const replay = await runtime.apply({
      idempotencyKey: "sqlite-pg-copy-resume-001",
      sourcePath,
      backupPath,
      batchSize: 1,
    });
    assert.equal(replay.snapshot.run.status, "completed");
    const replayRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM migration_type_fixture`,
    );
    assert.equal(replayRows.rows[0].count, "2");

    const verified = await runtime.verify({
      idempotencyKey: "sqlite-pg-copy-resume-001",
      backupPath,
    });
    assert.equal(verified.ok, true, JSON.stringify(verified.failures));
    assert.equal(verified.tables.length, 4);

    await pool.query(
      `UPDATE migration_type_fixture
          SET payload = '{"tampered":true}'::jsonb
        WHERE id = 'type-1'`,
    );
    const tampered = await runtime.verify({
      idempotencyKey: "sqlite-pg-copy-resume-001",
      backupPath,
    });
    assert.equal(tampered.ok, false);
    assert(
      tampered.failures.some((failure) => (
        failure.tableName === "migration_type_fixture"
        && failure.code === "SQLITE_PG_MIGRATION_BATCH_CHECKSUM_MISMATCH"
      )),
    );

    assert.equal(statSync(sourcePath).mtimeMs, sourceMtimeBefore);
    assert.equal(statSync(backupPath).mtimeMs, backupMtimeBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await truncateBusinessTables(pool).catch(() => undefined);
    await resetMigrationMetadata(pool).catch(() => undefined);
    await dropTargetFixtures(pool).catch(() => undefined);
    await closePgPool(pool);
  }
});
