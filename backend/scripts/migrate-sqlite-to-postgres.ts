#!/usr/bin/env node

import { Pool } from "pg";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createSqlitePostgresMigrationRuntime } from "../src/services/sqlite-postgres-migration-runtime";
import { createSqlitePostgresRollbackRuntime } from "../src/services/sqlite-postgres-rollback-runtime";

type CliOptions = {
  mode: "dry-run" | "apply" | "verify" | "rollback";
  sourcePath?: string;
  backupPath?: string;
  idempotencyKey?: string;
  allowNonEmptyTarget: boolean;
  batchSize?: number;
};

function usage(): string {
  return [
    "SQLite → PostgreSQL migration tool",
    "",
    "Usage:",
    "  npm run migrate:sqlite-to-postgres -- --dry-run --source <nowen-note.db> --backup <backup.db>",
    "  npm run migrate:sqlite-to-postgres -- --apply --source <nowen-note.db> --backup <backup.db> --idempotency-key <key>",
    "  npm run migrate:sqlite-to-postgres -- --verify --backup <backup.db> --idempotency-key <key>",
    "  npm run migrate:sqlite-to-postgres -- --rollback --idempotency-key <key>",
    "",
    "Options:",
    "  --dry-run                  Run read-only preflight; never writes target data",
    "  --apply                    Copy and verify all planned business tables",
    "  --verify                   Independently re-read the frozen backup and verify PostgreSQL",
    "  --rollback                 Delete only rows owned by an empty-target migration run",
    "  --source <path>            Live SQLite source used only for preflight (defaults to DB_PATH)",
    "  --backup <path>            Verified frozen SQLite backup used as the execution source",
    "  --idempotency-key <key>    Stable 8–128 character migration key for apply/verify/rollback",
    "  --batch-size <1..2000>     Rows per transactional upsert/checkpoint batch (default 200)",
    "  --allow-non-empty-target   Allow planning against non-empty PostgreSQL; apply remains blocked",
    "  --help                     Show this help",
    "",
    "Rollback currently supports only runs whose PostgreSQL target was empty at preflight.",
  ].join("\n");
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseBatchSize(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2_000) {
    throw new Error("--batch-size must be an integer between 1 and 2000.");
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes("--help")) {
    console.log(usage());
    process.exit(0);
  }
  const selected = ["--dry-run", "--apply", "--verify", "--rollback"]
    .filter((mode) => args.includes(mode));
  if (selected.length !== 1) {
    throw new Error("Select exactly one mode: --dry-run, --apply, --verify, or --rollback.");
  }
  const mode = selected[0] === "--apply"
    ? "apply"
    : selected[0] === "--verify"
      ? "verify"
      : selected[0] === "--rollback"
        ? "rollback"
        : "dry-run";
  const sourcePath = valueAfter(args, "--source") || process.env.DB_PATH;
  const backupPath = valueAfter(args, "--backup");
  const idempotencyKey = valueAfter(args, "--idempotency-key");
  if ((mode === "dry-run" || mode === "apply") && !sourcePath) {
    throw new Error("SQLite source path is required via --source or DB_PATH.");
  }
  if (mode !== "rollback" && !backupPath) {
    throw new Error("A frozen SQLite backup is required via --backup.");
  }
  if ((mode === "apply" || mode === "verify" || mode === "rollback")
    && !idempotencyKey) {
    throw new Error("--idempotency-key is required for apply, verify, and rollback.");
  }
  return {
    mode,
    sourcePath,
    backupPath,
    idempotencyKey,
    allowNonEmptyTarget: args.includes("--allow-non-empty-target"),
    batchSize: parseBatchSize(valueAfter(args, "--batch-size")),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: "nowen-note-sqlite-pg-migration",
  });
  try {
    await pool.query("SELECT 1");
    const adapter = new PostgresAdapter(pool);
    const runtime = createSqlitePostgresMigrationRuntime(adapter);
    const rollbackRuntime = createSqlitePostgresRollbackRuntime(adapter);
    if (options.mode === "dry-run") {
      const report = await runtime.dryRun({
        sourcePath: options.sourcePath!,
        backupPath: options.backupPath,
        allowNonEmptyTarget: options.allowNonEmptyTarget,
        batchSize: options.batchSize,
      });
      console.log(JSON.stringify(report, null, 2));
      if (!report.canApply) process.exitCode = 2;
      return;
    }
    if (options.mode === "apply") {
      const result = await runtime.apply({
        idempotencyKey: options.idempotencyKey!,
        sourcePath: options.sourcePath!,
        backupPath: options.backupPath!,
        allowNonEmptyTarget: options.allowNonEmptyTarget,
        batchSize: options.batchSize,
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.snapshot.run.status !== "completed") process.exitCode = 3;
      return;
    }
    if (options.mode === "rollback") {
      const snapshot = await runtime.getStatusByIdempotencyKey(options.idempotencyKey!);
      const report = await rollbackRuntime.rollback({ runId: snapshot.run.id });
      console.log(JSON.stringify(report, null, 2));
      if (!report.complete) process.exitCode = 5;
      return;
    }
    const report = await runtime.verify({
      idempotencyKey: options.idempotencyKey!,
      backupPath: options.backupPath!,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 4;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    ok: false,
    code: "SQLITE_PG_MIGRATION_COMMAND_FAILED",
    error: message,
  }));
  process.exitCode = 1;
});
