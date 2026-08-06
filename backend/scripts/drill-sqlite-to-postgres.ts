#!/usr/bin/env node

import { writeFileSync } from "node:fs";

import { Pool } from "pg";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createSqlitePostgresMigrationDrillRuntime } from "../src/services/sqlite-postgres-migration-drill-runtime";
import type { SqlitePostgresConflictPolicy } from "../src/services/sqlite-postgres-migration-runtime";

type Options = {
  sourcePath: string;
  backupPath: string;
  idempotencyKey: string;
  reportPath: string;
  allowNonEmptyTarget: boolean;
  conflictPolicy: SqlitePostgresConflictPolicy;
  batchSize?: number;
  maxBatchesPerPass?: number;
  maxRollbackBatchesPerPass?: number;
};

function usage(): string {
  return [
    "SQLite → PostgreSQL migration drill",
    "",
    "Usage:",
    "  npm run migrate:sqlite-to-postgres:drill -- \\",
    "    --source <nowen-note.db> --backup <backup.db> \\",
    "    --idempotency-key <key> --report <report.json>",
    "",
    "Options:",
    "  --source <path>                     Live SQLite source used only for preflight",
    "  --backup <path>                     Verified frozen SQLite execution source",
    "  --idempotency-key <key>             Stable migration key",
    "  --report <path>                     Final JSON report path",
    "  --batch-size <1..2000>              Rows per transaction batch",
    "  --max-batches-per-pass <n>          Bound each apply pass to test resume",
    "  --max-rollback-batches-per-pass <n> Bound each rollback pass to test resume",
    "  --allow-non-empty-target            Enable explicit non-empty target mode",
    "  --conflict-policy <mode>            abort or overwrite-with-backup",
    "  --help                              Show this help",
    "",
    "The drill always executes apply → independent verify → rollback → post-rollback validation.",
  ].join("\n");
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function integerOption(value: string | undefined, name: string, max = 2_000): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return parsed;
}

function parseArgs(args: string[]): Options {
  if (args.includes("--help")) {
    console.log(usage());
    process.exit(0);
  }
  const sourcePath = valueAfter(args, "--source") || process.env.DB_PATH;
  const backupPath = valueAfter(args, "--backup");
  const idempotencyKey = valueAfter(args, "--idempotency-key");
  const reportPath = valueAfter(args, "--report") || "sqlite-postgres-drill-report.json";
  if (!sourcePath) throw new Error("--source or DB_PATH is required.");
  if (!backupPath) throw new Error("--backup is required.");
  if (!idempotencyKey) throw new Error("--idempotency-key is required.");
  const allowNonEmptyTarget = args.includes("--allow-non-empty-target");
  const conflictPolicy = (valueAfter(args, "--conflict-policy") || "abort")
    as SqlitePostgresConflictPolicy;
  if (conflictPolicy !== "abort" && conflictPolicy !== "overwrite-with-backup") {
    throw new Error("--conflict-policy must be abort or overwrite-with-backup.");
  }
  if (conflictPolicy === "overwrite-with-backup" && !allowNonEmptyTarget) {
    throw new Error("overwrite-with-backup requires --allow-non-empty-target.");
  }
  return {
    sourcePath,
    backupPath,
    idempotencyKey,
    reportPath,
    allowNonEmptyTarget,
    conflictPolicy,
    batchSize: integerOption(valueAfter(args, "--batch-size"), "--batch-size"),
    maxBatchesPerPass: integerOption(
      valueAfter(args, "--max-batches-per-pass"),
      "--max-batches-per-pass",
      100_000,
    ),
    maxRollbackBatchesPerPass: integerOption(
      valueAfter(args, "--max-rollback-batches-per-pass"),
      "--max-rollback-batches-per-pass",
      100_000,
    ),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: "nowen-note-sqlite-pg-drill",
  });
  try {
    await pool.query("SELECT 1");
    const runtime = createSqlitePostgresMigrationDrillRuntime(new PostgresAdapter(pool));
    const report = await runtime.run({
      idempotencyKey: options.idempotencyKey,
      sourcePath: options.sourcePath,
      backupPath: options.backupPath,
      allowNonEmptyTarget: options.allowNonEmptyTarget,
      conflictPolicy: options.conflictPolicy,
      batchSize: options.batchSize,
      maxBatchesPerPass: options.maxBatchesPerPass,
      maxRollbackBatchesPerPass: options.maxRollbackBatchesPerPass,
    });
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 6;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    ok: false,
    code: "SQLITE_PG_MIGRATION_DRILL_FAILED",
    error: message,
  }));
  process.exitCode = 1;
});
