import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import {
  PostgresBackupRuntimeError,
  type PostgresBackupRuntime,
  type ProcessRunOptions,
  type ProcessRunner,
} from "./postgres-backup-runtime";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_TEMP_DATABASE_NAME_LENGTH = 63;

interface QueryResult<T> {
  rows: T[];
}

export interface RestoreDrillPool {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
}

export interface PostgresRestoreDrillOptions {
  backupRuntime: PostgresBackupRuntime;
  databaseUrl?: string;
  pgRestorePath?: string;
  maintenanceDatabase?: string;
  processRunner?: ProcessRunner;
  poolFactory?: (connectionString: string) => Promise<RestoreDrillPool>;
  now?: () => Date;
  randomId?: () => string;
}

export interface RestoreDrillTableResult {
  name: string;
  expectedRows: number | null;
  actualRows: number;
  matches: boolean;
}

export interface PostgresRestoreDrillResult {
  success: true;
  drill: {
    databaseDriver: "postgres";
    backupType: "db-only" | "full";
    temporaryDatabase: string;
    temporaryDatabaseDropped: true;
    restoredAt: string;
    schemaVersion: {
      expected: string | null;
      actual: string | null;
      matches: boolean;
    };
    tables: RestoreDrillTableResult[];
    missingTables: string[];
    unexpectedTables: string[];
    rowCountMismatches: string[];
    invalidForeignKeys: string[];
    invalidIndexes: string[];
    validationPassed: boolean;
    cutoverEligible: boolean;
  };
}

function redactSecrets(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1***@")
    .replace(/(password=)[^\s]+/gi, "$1***");
}

class RestoreSpawnRunner implements ProcessRunner {
  async run(command: string, args: string[], options: ProcessRunOptions) {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const append = (current: string, chunk: Buffer): string => {
        if (Buffer.byteLength(current) >= MAX_PROCESS_OUTPUT_BYTES) return current;
        return (current + chunk.toString("utf8")).slice(0, MAX_PROCESS_OUTPUT_BYTES);
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once("error", (error) => {
        reject(new PostgresBackupRuntimeError(
          `无法启动 ${path.basename(command)}：${redactSecrets(error.message)}`,
          "POSTGRES_RESTORE_DRILL_TOOL_UNAVAILABLE",
          503,
        ));
      });
      child.once("close", (code) => {
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
          return;
        }
        reject(new PostgresBackupRuntimeError(
          `${path.basename(command)} 恢复演练失败（退出码 ${code ?? "unknown"}）：${redactSecrets(stderr || stdout || "无错误输出")}`,
          "POSTGRES_RESTORE_DRILL_TOOL_FAILED",
          500,
        ));
      });
    });
  }
}

function parseDatabaseUrl(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new PostgresBackupRuntimeError(
      "DATABASE_URL 不是合法的 PostgreSQL URL",
      "POSTGRES_RESTORE_DRILL_DATABASE_URL_INVALID",
      503,
    );
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new PostgresBackupRuntimeError(
      "DATABASE_URL 必须使用 postgres:// 或 postgresql://",
      "POSTGRES_RESTORE_DRILL_DATABASE_URL_INVALID",
      503,
    );
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !database) {
    throw new PostgresBackupRuntimeError(
      "DATABASE_URL 缺少主机或数据库名",
      "POSTGRES_RESTORE_DRILL_DATABASE_URL_INVALID",
      503,
    );
  }
  return parsed;
}

function connectionStringForDatabase(source: URL, database: string): string {
  const next = new URL(source.toString());
  next.pathname = `/${encodeURIComponent(database)}`;
  return next.toString();
}

function connectionEnvironment(source: URL, database: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: source.hostname,
    PGPORT: source.port || "5432",
    PGUSER: decodeURIComponent(source.username || ""),
    PGDATABASE: database,
    PGPASSWORD: decodeURIComponent(source.password || ""),
  };
  const sslMode = source.searchParams.get("sslmode");
  if (sslMode) env.PGSSLMODE = sslMode;
  return env;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function safeTemporaryDatabaseName(date: Date, randomId: string): string {
  const timestamp = date.toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = randomId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16)
    || crypto.randomBytes(6).toString("hex");
  return `nowen_restore_${timestamp}_${suffix}`.slice(0, MAX_TEMP_DATABASE_NAME_LENGTH);
}

async function defaultPoolFactory(connectionString: string): Promise<RestoreDrillPool> {
  const { Pool } = await import("pg");
  return new Pool({
    connectionString,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
    max: 2,
  }) as unknown as RestoreDrillPool;
}

async function extractDatabaseDump(backupPath: string): Promise<Buffer> {
  const artifact = fs.readFileSync(backupPath);
  if (!backupPath.endsWith(".zip")) return artifact;
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(artifact);
  } catch (error) {
    throw new PostgresBackupRuntimeError(
      `PostgreSQL 全量备份 ZIP 解析失败：${error instanceof Error ? error.message : String(error)}`,
      "POSTGRES_RESTORE_DRILL_INVALID_ARCHIVE",
      400,
    );
  }
  const dumpFile = zip.file("database.dump");
  if (!dumpFile) {
    throw new PostgresBackupRuntimeError(
      "PostgreSQL 全量备份缺少 database.dump",
      "POSTGRES_RESTORE_DRILL_INVALID_ARCHIVE",
      400,
    );
  }
  return dumpFile.async("nodebuffer");
}

function normalizeError(error: unknown): PostgresBackupRuntimeError {
  if (error instanceof PostgresBackupRuntimeError) return error;
  return new PostgresBackupRuntimeError(
    `PostgreSQL 恢复演练失败：${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    "POSTGRES_RESTORE_DRILL_FAILED",
    500,
  );
}

export function createPostgresRestoreDrillRuntime(options: PostgresRestoreDrillOptions) {
  const backupRuntime = options.backupRuntime;
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const parsedUrl = parseDatabaseUrl(databaseUrl);
  const pgRestorePath = options.pgRestorePath ?? process.env.PG_RESTORE_PATH ?? "pg_restore";
  const maintenanceDatabase = options.maintenanceDatabase
    ?? process.env.PG_MAINTENANCE_DATABASE
    ?? "postgres";
  const runner = options.processRunner ?? new RestoreSpawnRunner();
  const poolFactory = options.poolFactory ?? defaultPoolFactory;
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? crypto.randomUUID;
  let active = false;

  async function validateTemporaryDatabase(
    pool: RestoreDrillPool,
    expectedTables: Record<string, number>,
    expectedSchemaVersion: string | null,
  ) {
    let actualSchemaVersion: string | null = null;
    try {
      const schema = await pool.query<{ version: string }>(
        `SELECT version FROM postgres_schema_migrations ORDER BY version DESC LIMIT 1`,
      );
      actualSchemaVersion = schema.rows[0]?.version ?? null;
    } catch {
      actualSchemaVersion = null;
    }

    const tableRows = await pool.query<{ tableName: string }>(`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const actualTableNames = tableRows.rows.map((row) => row.tableName);
    const expectedTableNames = Object.keys(expectedTables).sort();
    const missingTables = expectedTableNames.filter((name) => !actualTableNames.includes(name));
    const unexpectedTables = actualTableNames.filter((name) => !expectedTableNames.includes(name));
    const tables: RestoreDrillTableResult[] = [];
    for (const name of actualTableNames) {
      const count = await pool.query<{ count: string | number }>(
        `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(name)}`,
      );
      const actualRows = Number(count.rows[0]?.count ?? 0);
      const expectedRows = Object.prototype.hasOwnProperty.call(expectedTables, name)
        ? Number(expectedTables[name])
        : null;
      tables.push({
        name,
        expectedRows,
        actualRows: Number.isSafeInteger(actualRows) ? actualRows : 0,
        matches: expectedRows === null || expectedRows === actualRows,
      });
    }

    const invalidForeignKeysResult = await pool.query<{ name: string }>(`
      SELECT conrelid::regclass::text || '.' || conname AS name
      FROM pg_constraint
      WHERE contype = 'f' AND NOT convalidated
      ORDER BY 1
    `);
    const invalidIndexesResult = await pool.query<{ name: string }>(`
      SELECT indexrelid::regclass::text AS name
      FROM pg_index
      WHERE NOT indisvalid OR NOT indisready
      ORDER BY 1
    `);
    const rowCountMismatches = tables
      .filter((table) => !table.matches)
      .map((table) => table.name);
    const invalidForeignKeys = invalidForeignKeysResult.rows.map((row) => row.name);
    const invalidIndexes = invalidIndexesResult.rows.map((row) => row.name);
    const schemaMatches = expectedSchemaVersion === actualSchemaVersion;
    const validationPassed = schemaMatches
      && missingTables.length === 0
      && unexpectedTables.length === 0
      && rowCountMismatches.length === 0
      && invalidForeignKeys.length === 0
      && invalidIndexes.length === 0;

    return {
      actualSchemaVersion,
      schemaMatches,
      tables,
      missingTables,
      unexpectedTables,
      rowCountMismatches,
      invalidForeignKeys,
      invalidIndexes,
      validationPassed,
    };
  }

  async function run(userId: string, filename: string): Promise<PostgresRestoreDrillResult> {
    if (active) {
      throw new PostgresBackupRuntimeError(
        "已有 PostgreSQL 恢复演练正在运行",
        "POSTGRES_RESTORE_DRILL_BUSY",
        503,
      );
    }
    active = true;

    const temporaryDatabase = safeTemporaryDatabaseName(now(), randomId());
    const tempDump = path.join(os.tmpdir(), `.${temporaryDatabase}.dump`);
    const maintenanceUrl = connectionStringForDatabase(parsedUrl, maintenanceDatabase);
    const temporaryUrl = connectionStringForDatabase(parsedUrl, temporaryDatabase);
    let maintenancePool: RestoreDrillPool | null = null;
    let temporaryPool: RestoreDrillPool | null = null;
    let databaseCreated = false;
    let report: Awaited<ReturnType<typeof validateTemporaryDatabase>> | null = null;
    let preflight: Awaited<ReturnType<PostgresBackupRuntime["dryRunRestore"]>> | null = null;
    let primaryError: PostgresBackupRuntimeError | null = null;
    let cleanupError: PostgresBackupRuntimeError | null = null;

    try {
      preflight = await backupRuntime.dryRunRestore(userId, filename);
      const backupPath = await backupRuntime.getBackupPath(userId, filename);
      const dump = await extractDatabaseDump(backupPath);
      fs.writeFileSync(tempDump, dump, { flag: "wx", mode: 0o600 });

      maintenancePool = await poolFactory(maintenanceUrl);
      await maintenancePool.query(
        `CREATE DATABASE ${quoteIdentifier(temporaryDatabase)} WITH TEMPLATE template0 ENCODING 'UTF8'`,
      );
      databaseCreated = true;

      await runner.run(
        pgRestorePath,
        [
          "--exit-on-error",
          "--single-transaction",
          "--no-owner",
          "--no-privileges",
          "--dbname",
          temporaryDatabase,
          tempDump,
        ],
        { env: connectionEnvironment(parsedUrl, temporaryDatabase) },
      );

      temporaryPool = await poolFactory(temporaryUrl);
      report = await validateTemporaryDatabase(
        temporaryPool,
        preflight.dryRun.tables,
        preflight.dryRun.schemaVersion,
      );
    } catch (error) {
      primaryError = normalizeError(error);
    } finally {
      if (temporaryPool) {
        try { await temporaryPool.end(); } catch (error) {
          cleanupError ??= new PostgresBackupRuntimeError(
            `关闭临时数据库连接失败：${redactSecrets(error instanceof Error ? error.message : String(error))}`,
            "POSTGRES_RESTORE_DRILL_CLEANUP_FAILED",
            500,
          );
        }
      }
      if (databaseCreated) {
        try {
          maintenancePool ??= await poolFactory(maintenanceUrl);
          await maintenancePool.query(
            `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [temporaryDatabase],
          );
          await maintenancePool.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(temporaryDatabase)} WITH (FORCE)`,
          );
        } catch (error) {
          cleanupError ??= new PostgresBackupRuntimeError(
            `临时数据库 ${temporaryDatabase} 删除失败：${redactSecrets(error instanceof Error ? error.message : String(error))}`,
            "POSTGRES_RESTORE_DRILL_CLEANUP_FAILED",
            500,
          );
        }
      }
      if (maintenancePool) {
        try { await maintenancePool.end(); } catch { /* cleanup error already covered by drop path */ }
      }
      try { fs.rmSync(tempDump, { force: true }); } catch { /* ignore */ }
      active = false;
    }

    if (primaryError) {
      if (cleanupError) {
        primaryError.message = `${primaryError.message}；另外，${cleanupError.message}`;
      }
      throw primaryError;
    }
    if (cleanupError) throw cleanupError;
    if (!preflight || !report) {
      throw new PostgresBackupRuntimeError(
        "PostgreSQL 恢复演练未生成校验报告",
        "POSTGRES_RESTORE_DRILL_FAILED",
        500,
      );
    }

    return {
      success: true,
      drill: {
        databaseDriver: "postgres",
        backupType: preflight.dryRun.backupType,
        temporaryDatabase,
        temporaryDatabaseDropped: true,
        restoredAt: now().toISOString(),
        schemaVersion: {
          expected: preflight.dryRun.schemaVersion,
          actual: report.actualSchemaVersion,
          matches: report.schemaMatches,
        },
        tables: report.tables,
        missingTables: report.missingTables,
        unexpectedTables: report.unexpectedTables,
        rowCountMismatches: report.rowCountMismatches,
        invalidForeignKeys: report.invalidForeignKeys,
        invalidIndexes: report.invalidIndexes,
        validationPassed: report.validationPassed,
        cutoverEligible: report.validationPassed,
      },
    };
  }

  return { run };
}

export type PostgresRestoreDrillRuntime = ReturnType<typeof createPostgresRestoreDrillRuntime>;
