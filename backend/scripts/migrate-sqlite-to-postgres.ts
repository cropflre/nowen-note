#!/usr/bin/env node

import { Pool } from "pg";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createSqlitePostgresMigrationRuntime } from "../src/services/sqlite-postgres-migration-runtime";

type CliOptions = {
  mode: "dry-run";
  sourcePath: string;
  backupPath?: string;
  allowNonEmptyTarget: boolean;
};

function usage(): string {
  return [
    "SQLite → PostgreSQL migration preflight",
    "",
    "Usage:",
    "  npm run migrate:sqlite-to-postgres -- --dry-run --source <nowen-note.db> --backup <backup.db>",
    "",
    "Options:",
    "  --dry-run                  Run read-only preflight; never writes target data",
    "  --source <path>            Source SQLite file (defaults to DB_PATH)",
    "  --backup <path>            Full SQLite backup used for safety verification",
    "  --allow-non-empty-target   Explicitly allow planning against a non-empty target",
    "  --help                     Show this help",
    "",
    "The apply/verify/rollback workers are intentionally not enabled in this slice.",
  ].join("\n");
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes("--help")) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.includes("--dry-run")) {
    throw new Error("Only --dry-run is enabled. Apply/verify/rollback are not available yet.");
  }
  const sourcePath = valueAfter(args, "--source") || process.env.DB_PATH;
  if (!sourcePath) {
    throw new Error("SQLite source path is required via --source or DB_PATH.");
  }
  return {
    mode: "dry-run",
    sourcePath,
    backupPath: valueAfter(args, "--backup"),
    allowNonEmptyTarget: args.includes("--allow-non-empty-target"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: "nowen-note-sqlite-pg-migration-preflight",
  });
  try {
    await pool.query("SELECT 1");
    const runtime = createSqlitePostgresMigrationRuntime(
      new PostgresAdapter(pool),
    );
    const report = await runtime.dryRun({
      sourcePath: options.sourcePath,
      backupPath: options.backupPath,
      allowNonEmptyTarget: options.allowNonEmptyTarget,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.canApply) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    ok: false,
    code: "SQLITE_PG_MIGRATION_PREFLIGHT_FAILED",
    error: message,
  }));
  process.exitCode = 1;
});
