import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import {
  createPostgresBackupRuntime,
  type PostgresBackupRuntime,
  type ProcessRunOptions,
  type ProcessRunner,
} from "../src/services/postgres-backup-runtime";
import {
  createPostgresRestoreDrillRuntime,
  type RestoreDrillPool,
} from "../src/services/postgres-restore-drill-runtime";
import {
  closePgPool,
  getPgPool,
  hasPg,
  initPgSchema,
} from "./helpers/pg-test-db";

const ADMIN_ID = "pg-restore-drill-admin";
const DATABASE_URL = "postgres://nowen:super-secret-password@127.0.0.1:5432/nowen_note_test?sslmode=disable";

class FakeRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];

  constructor(private readonly failRestore = false) {}

  async run(command: string, args: string[], options: ProcessRunOptions) {
    this.calls.push({ command, args: [...args], env: { ...options.env } });
    if (this.failRestore) throw new Error("simulated restore failure");
    return { stdout: "", stderr: "" };
  }
}

class FakePool implements RestoreDrillPool {
  readonly queries: Array<{ sql: string; params?: unknown[] }> = [];
  ended = false;

  constructor(private readonly kind: "maintenance" | "temporary") {}

  async query<T>(sql: string, params?: unknown[]) {
    this.queries.push({ sql, params });
    if (this.kind === "maintenance") return { rows: [] as T[] };
    if (sql.includes("postgres_schema_migrations")) {
      return { rows: [{ version: "0026_notes_full_text_search" }] as T[] };
    }
    if (sql.includes("information_schema.tables")) {
      return { rows: [{ tableName: "notes" }, { tableName: "users" }] as T[] };
    }
    if (sql.includes('FROM "notes"')) {
      return { rows: [{ count: "3" }] as T[] };
    }
    if (sql.includes('FROM "users"')) {
      return { rows: [{ count: "1" }] as T[] };
    }
    if (sql.includes("FROM pg_constraint") || sql.includes("FROM pg_index")) {
      return { rows: [] as T[] };
    }
    return { rows: [] as T[] };
  }

  async end() {
    this.ended = true;
  }
}

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeBackupRuntime(artifact: string): PostgresBackupRuntime {
  return {
    dryRunRestore: async () => ({
      success: true,
      dryRun: {
        databaseDriver: "postgres",
        backupType: "db-only",
        schemaVersion: "0026_notes_full_text_search",
        applicationVersion: "test",
        tables: { notes: 3, users: 1 },
        files: {
          attachments: { count: 0, bytes: 0, checksum: "0".repeat(64) },
          fonts: { count: 0, bytes: 0, checksum: "0".repeat(64) },
          plugins: { count: 0, bytes: 0, checksum: "0".repeat(64) },
        },
        checksumVerified: true,
        restoreToolVersion: "pg_restore 16",
      },
    }),
    getBackupPath: async () => artifact,
  } as unknown as PostgresBackupRuntime;
}

test("restore drill restores into an isolated database and always drops it", async () => {
  const root = tempRoot("nowen-pg-restore-drill-");
  const artifact = path.join(root, "backup.pgdump");
  fs.writeFileSync(artifact, "custom-dump");
  const runner = new FakeRunner();
  const maintenance = new FakePool("maintenance");
  const temporary = new FakePool("temporary");
  try {
    const runtime = createPostgresRestoreDrillRuntime({
      backupRuntime: fakeBackupRuntime(artifact),
      databaseUrl: DATABASE_URL,
      processRunner: runner,
      poolFactory: async (connectionString) => {
        const database = decodeURIComponent(new URL(connectionString).pathname.slice(1));
        return database === "postgres" ? maintenance : temporary;
      },
      now: () => new Date("2026-08-06T09:00:00.000Z"),
      randomId: () => "unit-drill-id",
    });

    const result = await runtime.run(ADMIN_ID, path.basename(artifact));
    assert.equal(result.success, true);
    assert.equal(result.drill.validationPassed, true);
    assert.equal(result.drill.cutoverEligible, true);
    assert.equal(result.drill.temporaryDatabaseDropped, true);
    assert.equal(result.drill.rowCountMismatches.length, 0);

    const restoreCall = runner.calls[0];
    assert.ok(restoreCall);
    assert.equal(restoreCall.args.join(" ").includes("super-secret-password"), false);
    assert.equal(restoreCall.env.PGPASSWORD, "super-secret-password");
    assert.equal(restoreCall.args.includes("--single-transaction"), true);
    assert.equal(fs.existsSync(restoreCall.args.at(-1)!), false);

    assert.equal(
      maintenance.queries.some((entry) => entry.sql.includes("CREATE DATABASE")),
      true,
    );
    assert.equal(
      maintenance.queries.some((entry) => entry.sql.includes("DROP DATABASE IF EXISTS")),
      true,
    );
    assert.equal(temporary.ended, true);
    assert.equal(maintenance.ended, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restore drill drops the temporary database when pg_restore fails", async () => {
  const root = tempRoot("nowen-pg-restore-drill-failure-");
  const artifact = path.join(root, "backup.pgdump");
  fs.writeFileSync(artifact, "custom-dump");
  const maintenance = new FakePool("maintenance");
  try {
    const runtime = createPostgresRestoreDrillRuntime({
      backupRuntime: fakeBackupRuntime(artifact),
      databaseUrl: DATABASE_URL,
      processRunner: new FakeRunner(true),
      poolFactory: async () => maintenance,
      randomId: () => "failure-drill-id",
    });

    await assert.rejects(
      () => runtime.run(ADMIN_ID, path.basename(artifact)),
      /simulated restore failure/,
    );
    assert.equal(
      maintenance.queries.some((entry) => entry.sql.includes("DROP DATABASE IF EXISTS")),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "real PostgreSQL backup can be restored and validated in an ephemeral database",
  { skip: !hasPg || process.env.RUN_PG_BACKUP_INTEGRATION !== "1" },
  async () => {
    const pool = await getPgPool();
    assert.ok(pool);
    const root = tempRoot("nowen-pg-restore-drill-integration-");
    try {
      await initPgSchema(pool);
      await pool.query(
        `INSERT INTO users (id, username, "passwordHash", role)
         VALUES ($1, $2, 'hash', 'admin')
         ON CONFLICT (id) DO UPDATE SET role = 'admin', "isDisabled" = false`,
        [ADMIN_ID, ADMIN_ID],
      );
      const backupRuntime = createPostgresBackupRuntime({
        adapter: new PostgresAdapter(pool),
        databaseUrl: process.env.TEST_PG_DATABASE_URL,
        dataDir: path.join(root, "data"),
        backupDir: path.join(root, "backups"),
        appVersion: "integration-test",
      });
      const backup = await backupRuntime.createBackup(ADMIN_ID, { type: "db-only" });
      const restoreRuntime = createPostgresRestoreDrillRuntime({
        backupRuntime,
        databaseUrl: process.env.TEST_PG_DATABASE_URL,
      });

      const result = await restoreRuntime.run(ADMIN_ID, backup.filename);
      assert.equal(result.success, true);
      assert.equal(result.drill.validationPassed, true);
      assert.equal(result.drill.temporaryDatabaseDropped, true);
      const exists = await pool.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [result.drill.temporaryDatabase],
      );
      assert.equal(exists.rowCount, 0);
    } finally {
      await pool.query(`DELETE FROM users WHERE id = $1`, [ADMIN_ID]).catch(() => {});
      await closePgPool(pool);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
