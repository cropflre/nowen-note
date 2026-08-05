from pathlib import Path
from textwrap import dedent


def replace_once(text: str, needle: str, replacement: str, label: str) -> str:
    if text.count(needle) != 1:
        raise SystemExit(f"{label} anchor changed: {needle!r}")
    return text.replace(needle, replacement)


copy_path = Path("backend/src/services/sqlite-postgres-copy-runtime.ts")
text = copy_path.read_text()
helper_anchor = "async function repairSelfReferences(input: {"
helper = dedent(
    '''
    function buildRowOwnershipStatement(input: {
      runId: string;
      tableName: string;
      columns: TargetColumn[];
      primaryKeyColumns: string[];
      row: Record<string, unknown>;
      batchSequence: number;
    }): DbStatement {
      const byName = new Map(input.columns.map((column) => [column.name, column]));
      const primaryKey = Object.fromEntries(input.primaryKeyColumns.map((columnName) => {
        const column = byName.get(columnName);
        if (!column) {
          throw new SqlitePostgresMigrationError(
            "SQLITE_PG_MIGRATION_PRIMARY_KEY_COLUMN_MISSING",
            "目标表缺少 run-owned tracking 所需主键列",
            500,
            { tableName: input.tableName, column: columnName },
          );
        }
        return [columnName, canonicalValue(column, input.row[columnName])];
      }));
      const canonicalRow = Object.fromEntries(input.columns.map((column) => [
        column.name,
        canonicalValue(column, input.row[column.name]),
      ]));
      return {
        sql: `INSERT INTO sqlite_postgres_migration_row_changes (
                "runId", "tableName", "primaryKey", "primaryKeyHash",
                "batchSequence", "changeKind", "originalRow", "migratedChecksum"
              ) VALUES (?, ?, ?::jsonb, ?, ?, 'inserted', NULL, ?)
              ON CONFLICT ("runId", "tableName", "primaryKeyHash") DO UPDATE
                SET "batchSequence" = LEAST(
                      sqlite_postgres_migration_row_changes."batchSequence",
                      EXCLUDED."batchSequence"
                    ),
                    "migratedChecksum" = EXCLUDED."migratedChecksum",
                    "updatedAt" = CURRENT_TIMESTAMP`,
        params: [
          input.runId,
          input.tableName,
          JSON.stringify(primaryKey),
          sha256(stableJson(primaryKey)),
          Math.max(0, Math.trunc(input.batchSequence)),
          sha256(stableJson(canonicalRow)),
        ],
      };
    }

    '''
)
if "function buildRowOwnershipStatement(input:" not in text:
    text = replace_once(text, helper_anchor, helper + helper_anchor, "copy helper")

start_marker = "      const statements = batch.rows.map((row) => buildUpsertStatement({"
end_marker = "      copiedRows += batch.rows.length;"
start = text.find(start_marker)
end = text.find(end_marker, max(start, 0))
segment = text[start:end] if start >= 0 and end >= 0 else ""
if "buildRowOwnershipStatement({" not in segment:
    if start < 0 or end < 0:
        raise SystemExit("copy statements range changed")
    replacement = dedent(
        '''
              const statements = batch.rows.flatMap((row) => [
                buildUpsertStatement({
                  tableName: sourceTable.name,
                  columns,
                  primaryKeyColumns: sourceTable.primaryKeyColumns,
                  row,
                  deferredSelfColumns: deferredNames,
                }),
                buildRowOwnershipStatement({
                  runId: input.claim.runId,
                  tableName: sourceTable.name,
                  columns,
                  primaryKeyColumns: sourceTable.primaryKeyColumns,
                  row,
                  batchSequence,
                }),
              ]);
        '''
    ).lstrip("\n")
    text = text[:start] + replacement + text[end:]
copy_path.write_text(text)

runtime_path = Path("backend/src/services/sqlite-postgres-migration-runtime.ts")
text = runtime_path.read_text()
if '  "sqlite_postgres_migration_row_changes",' not in text:
    text = replace_once(
        text,
        '  "sqlite_postgres_migration_batch_checkpoints",\n]);',
        '  "sqlite_postgres_migration_batch_checkpoints",\n  "sqlite_postgres_migration_row_changes",\n]);',
        "migration metadata",
    )
runtime_path.write_text(text)

cli_path = Path("backend/scripts/migrate-sqlite-to-postgres.ts")
cli_path.write_text(
    dedent(
        '''
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
          ].join("\\n");
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
        '''
    ).lstrip()
)

workflow_path = Path(".github/workflows/pg-sqlite-data-migration.yml")
text = workflow_path.read_text()
additions = [
    (
        '      - "backend/src/db/postgres/migrations/0023_sqlite_postgres_migration_runs.sql"\n',
        '      - "backend/src/db/postgres/migrations/0024_sqlite_postgres_migration_rollback.sql"\n',
    ),
    (
        '      - "backend/src/services/sqlite-postgres-migration-runtime.ts"\n',
        '      - "backend/src/services/sqlite-postgres-rollback-runtime.ts"\n',
    ),
    (
        '      - "backend/tests/sqlite-postgres-migration-runtime-pg.test.ts"\n',
        '      - "backend/tests/sqlite-postgres-rollback-runtime-pg.test.ts"\n',
    ),
    (
        '          tests/sqlite-postgres-migration-runtime-pg.test.ts\n',
        '          tests/sqlite-postgres-rollback-runtime-pg.test.ts\n',
    ),
    (
        '          test -f dist/postgres/migrations/0023_sqlite_postgres_migration_runs.sql\n',
        '          test -f dist/postgres/migrations/0024_sqlite_postgres_migration_rollback.sql\n',
    ),
]
for anchor, addition in additions:
    if addition not in text:
        if anchor not in text:
            raise SystemExit(f"permanent workflow anchor changed: {anchor!r}")
        text = text.replace(anchor, anchor + addition)
workflow_path.write_text(text)

docs_path = Path("backend/docs/sqlite-to-postgres-migration.md")
docs = docs_path.read_text()
if "## Empty-target rollback" not in docs:
    docs += dedent(
        '''

        ## Empty-target rollback

        Each apply batch records the migrated row primary key in `sqlite_postgres_migration_row_changes` in the same PostgreSQL transaction as the business upsert and checkpoint. For targets that were empty at preflight, rollback deletes only those run-owned rows in reverse table dependency order.

        ```bash
        npm run migrate:sqlite-to-postgres -- \\
          --rollback \\
          --idempotency-key migration-2026-08-05
        ```

        Rollback is resumable and idempotent. A run created before ownership tracking, or a run planned against a non-empty target, is rejected rather than guessing a deletion range. Restoring overwritten pre-existing rows remains disabled until original-row snapshots and conflict policies are complete.
        '''
    )
docs_path.write_text(docs)
