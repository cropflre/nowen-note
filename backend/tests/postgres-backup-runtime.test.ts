import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import type { DatabaseAdapter, DbRunResult, DbStatement } from "../src/db/adapters/types";
import { PostgresAdapter } from "../src/db/postgresAdapter";
import {
  createPostgresBackupRuntime,
  PostgresBackupRuntimeError,
  type ProcessRunOptions,
  type ProcessRunner,
} from "../src/services/postgres-backup-runtime";
import {
  closePgPool,
  getPgPool,
  hasPg,
  initPgSchema,
} from "./helpers/pg-test-db";

const ADMIN_ID = "pg-backup-admin";
const DATABASE_URL = "postgres://nowen:super-secret-password@127.0.0.1:5432/nowen_note_test?sslmode=disable";

class FakeAdapter implements DatabaseAdapter {
  constructor(private readonly role = "admin") {}

  async queryOne<T>(sql: string): Promise<T | undefined> {
    if (sql.includes("FROM users")) {
      return { role: this.role, isDisabled: false } as T;
    }
    if (sql.includes("postgres_schema_migrations")) {
      return { version: "0026_notes_full_text_search" } as T;
    }
    if (sql.includes("current_setting('server_version')")) {
      return { version: "16.4" } as T;
    }
    if (sql.includes('FROM "notes"')) return { count: "3" } as T;
    if (sql.includes('FROM "notebooks"')) return { count: "2" } as T;
    if (sql.includes('FROM "users"')) return { count: "1" } as T;
    return { count: "0" } as T;
  }

  async queryMany<T>(sql: string): Promise<T[]> {
    if (sql.includes("information_schema.tables")) {
      return [
        { tableName: "notebooks" },
        { tableName: "notes" },
        { tableName: "users" },
      ] as T[];
    }
    return [];
  }

  async execute(): Promise<DbRunResult> {
    return { changes: 0 };
  }

  async executeBatch(): Promise<DbRunResult> {
    return { changes: 0 };
  }

  async executeStatements(_statements: DbStatement[]): Promise<{ changes: number }> {
    return { changes: 0 };
  }
}

class FakeRunner implements ProcessRunner {
  readonly calls: Array<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  }> = [];

  async run(command: string, args: string[], options: ProcessRunOptions) {
    this.calls.push({ command, args: [...args], env: { ...options.env } });
    if (args.includes("--version")) {
      return {
        stdout: command.includes("restore")
          ? "pg_restore (PostgreSQL) 16.4"
          : "pg_dump (PostgreSQL) 16.4",
        stderr: "",
      };
    }
    if (command.includes("pg_dump")) {
      const fileIndex = args.indexOf("--file");
      assert.notEqual(fileIndex, -1);
      fs.writeFileSync(args[fileIndex + 1], Buffer.from("test-custom-pg-dump"));
      return { stdout: "", stderr: "" };
    }
    if (command.includes("pg_restore") && args.includes("--list")) {
      assert.equal(fs.existsSync(args[args.indexOf("--list") + 1]), true);
      return { stdout: "; Archive created at test", stderr: "" };
    }
    throw new Error(`unexpected process call: ${command} ${args.join(" ")}`);
  }
}

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFixture() {
  const root = tempRoot("nowen-pg-backup-");
  const dataDir = path.join(root, "data");
  const backupDir = path.join(root, "backups");
  fs.mkdirSync(path.join(dataDir, "attachments"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "fonts"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "plugins", "sample"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "attachments", "image.png"), "image");
  fs.writeFileSync(path.join(dataDir, "fonts", "font.woff2"), "font");
  fs.writeFileSync(path.join(dataDir, "plugins", "sample", "manifest.json"), "{}");
  fs.writeFileSync(path.join(dataDir, ".jwt_secret"), "jwt-secret-value");
  return { root, dataDir, backupDir };
}


test("PostgreSQL backup runtime rejects non-admin users before touching pg_dump", async () => {
  const fixture = createFixture();
  const runner = new FakeRunner();
  try {
    const runtime = createPostgresBackupRuntime({
      adapter: new FakeAdapter("user"),
      databaseUrl: DATABASE_URL,
      dataDir: fixture.dataDir,
      backupDir: fixture.backupDir,
      processRunner: runner,
    });
    await assert.rejects(
      () => runtime.createBackup("ordinary-user", { type: "db-only" }),
      (error: unknown) => {
        assert.ok(error instanceof PostgresBackupRuntimeError);
        assert.equal(error.code, "FORBIDDEN");
        return true;
      },
    );
    assert.equal(runner.calls.length, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("PostgreSQL db-only backup keeps credentials out of process arguments", async () => {
  const fixture = createFixture();
  const runner = new FakeRunner();
  try {
    const runtime = createPostgresBackupRuntime({
      adapter: new FakeAdapter(),
      databaseUrl: DATABASE_URL,
      dataDir: fixture.dataDir,
      backupDir: fixture.backupDir,
      processRunner: runner,
      appVersion: "1.4.6",
      now: () => new Date("2026-08-06T08:00:00.000Z"),
      randomId: () => "backup-id",
    });

    const info = await runtime.createBackup(ADMIN_ID, { type: "db-only" });
    assert.equal(info.databaseDriver, "postgres");
    assert.equal(info.type, "db-only");
    assert.equal(info.noteCount, 3);
    assert.equal(info.notebookCount, 2);
    assert.equal(fs.existsSync(path.join(fixture.backupDir, info.filename)), true);
    assert.equal(
      fs.existsSync(path.join(fixture.backupDir, `${info.filename}.meta.json`)),
      true,
    );

    const dumpCall = runner.calls.find((call) => call.command.includes("pg_dump") && !call.args.includes("--version"));
    assert.ok(dumpCall);
    assert.equal(dumpCall.args.join(" ").includes("super-secret-password"), false);
    assert.equal(dumpCall.env.PGPASSWORD, "super-secret-password");
    assert.equal(dumpCall.env.PGDATABASE, "nowen_note_test");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("PostgreSQL full backup contains dump, assets, secret and database-independent manifest", async () => {
  const fixture = createFixture();
  try {
    const runtime = createPostgresBackupRuntime({
      adapter: new FakeAdapter(),
      databaseUrl: DATABASE_URL,
      dataDir: fixture.dataDir,
      backupDir: fixture.backupDir,
      processRunner: new FakeRunner(),
      appVersion: "1.4.6",
      now: () => new Date("2026-08-06T08:01:00.000Z"),
      randomId: () => "full-backup-id",
    });

    const info = await runtime.createBackup(ADMIN_ID, {
      type: "full",
      description: "nightly full backup",
    });
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(fixture.backupDir, info.filename)));
    assert.ok(zip.file("database.dump"));
    assert.ok(zip.file("attachments/image.png"));
    assert.ok(zip.file("fonts/font.woff2"));
    assert.ok(zip.file("plugins/sample/manifest.json"));
    assert.ok(zip.file(".jwt_secret"));
    const manifest = JSON.parse(await zip.file("meta.json")!.async("string"));
    assert.equal(manifest.database.driver, "postgres");
    assert.equal(manifest.database.dumpFormat, "custom");
    assert.equal(manifest.database.tables.notes, 3);
    assert.equal(manifest.files.attachments.count, 1);
    assert.equal(manifest.secrets.jwtSecretIncluded, true);
    assert.equal(JSON.stringify(manifest).includes("super-secret-password"), false);
    const dryRun = await runtime.dryRunRestore(ADMIN_ID, info.filename);
    assert.equal(dryRun.dryRun.backupType, "full");
    assert.equal(dryRun.dryRun.checksumVerified, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("PostgreSQL restore dry-run validates checksum before invoking pg_restore", async () => {
  const fixture = createFixture();
  const runner = new FakeRunner();
  try {
    const runtime = createPostgresBackupRuntime({
      adapter: new FakeAdapter(),
      databaseUrl: DATABASE_URL,
      dataDir: fixture.dataDir,
      backupDir: fixture.backupDir,
      processRunner: runner,
      randomId: () => "dry-run-id",
    });
    const info = await runtime.createBackup(ADMIN_ID, { type: "db-only" });
    fs.appendFileSync(path.join(fixture.backupDir, info.filename), "corrupt");

    await assert.rejects(
      () => runtime.dryRunRestore(ADMIN_ID, info.filename),
      (error: unknown) => {
        assert.ok(error instanceof PostgresBackupRuntimeError);
        assert.equal(error.code, "POSTGRES_BACKUP_CHECKSUM_MISMATCH");
        return true;
      },
    );
    assert.equal(
      runner.calls.some((call) => call.command.includes("pg_restore") && call.args.includes("--list")),
      false,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("real PostgreSQL pg_dump and pg_restore dry-run", { skip: !hasPg || process.env.RUN_PG_BACKUP_INTEGRATION !== "1" }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const root = tempRoot("nowen-pg-backup-integration-");
  try {
    await initPgSchema(pool);
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash", role)
       VALUES ($1, $2, 'hash', 'admin')
       ON CONFLICT (id) DO UPDATE SET role = 'admin', "isDisabled" = false`,
      [ADMIN_ID, ADMIN_ID],
    );
    const runtime = createPostgresBackupRuntime({
      adapter: new PostgresAdapter(pool),
      databaseUrl: process.env.TEST_PG_DATABASE_URL,
      dataDir: path.join(root, "data"),
      backupDir: path.join(root, "backups"),
      appVersion: "integration-test",
    });
    const info = await runtime.createBackup(ADMIN_ID, { type: "db-only" });
    assert.ok(info.size > 0);
    const dryRun = await runtime.dryRunRestore(ADMIN_ID, info.filename);
    assert.equal(dryRun.success, true);
    assert.equal(dryRun.dryRun.checksumVerified, true);
    assert.match(dryRun.dryRun.restoreToolVersion, /pg_restore/i);
  } finally {
    await pool.query(`DELETE FROM users WHERE id = $1`, [ADMIN_ID]).catch(() => {});
    await closePgPool(pool);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
