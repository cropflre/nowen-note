import assert from "node:assert/strict";
import test from "node:test";

import { closePgPool, getPgPool, hasPg } from "./helpers/pg-test-db";

const skip = !hasPg;

const EXPECTED_MIGRATIONS = [
  "0001_migration_state",
  "0002_api_tokens_parity",
  "0003_runtime_tables_parity",
  "0004_notebook_members_unique",
  "0005_api_token_resources",
  "0006_share_capabilities",
  "0007_note_import_origins",
  "0008_note_split_tables",
  "0009_roundtrip_import_resource_links",
  "0010_roundtrip_import_batches",
  "0011_note_block_runtime",
  "0012_tag_scope_unique_names",
  "0013_yjs_subdocuments",
  "0014_yjs_subdocument_structure_operations",
  "0015_knowledge_tree_read_runtime",
  "0016_note_transfer_operations",
  "0017_note_transfer_staging_manifest",
  "0018_note_transfer_attachment_staging_runtime",
  "0019_note_transfer_cleanup_runtime",
  "0020_note_transfer_effect_outbox",
  "0021_note_transfer_move_source_deletion",
  "0022_note_transfer_orchestration",
  "0023_sqlite_postgres_migration_runs",
  "0024_sqlite_postgres_migration_rollback",
  "0025_sqlite_postgres_nonempty_recovery",
];

test("PG migrations bootstrap an empty database and are idempotent", { skip }, async () => {
  const pool = await getPgPool()!;
  await pool.query("DROP TABLE IF EXISTS postgres_schema_migrations");
  await pool.query("DROP TABLE IF EXISTS postgres_migration_state");

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { runPostgresMigrations } = await import("../src/db/postgres/migrations");
  const adapter = new PostgresAdapter(pool);

  const first = await runPostgresMigrations(adapter);
  assert.deepEqual(
    first.map((migration) => migration.version),
    EXPECTED_MIGRATIONS,
  );

  const requiredTables = [
    "api_token_resources",
    "audit_logs",
    "block_operations",
    "habit_checkins",
    "habits",
    "mindmaps",
    "note_blocks_index",
    "note_import_origins",
    "note_split_attachment_copies",
    "note_split_items",
    "note_split_operations",
    "note_transfer_effect_outbox",
    "note_transfer_move_source_deletions",
    "note_transfer_operation_items",
    "note_transfer_operations",
    "note_transfer_staged_attachments",
    "note_y_subdocument_manifests",
    "note_y_subdocument_structure_operations",
    "note_y_subdocument_updates",
    "note_y_subdocuments",
    "notebook_acl_overrides",
    "notebook_public_comments",
    "notebook_publications",
    "postgres_migration_state",
    "roundtrip_import_batches",
    "roundtrip_import_links",
    "sqlite_postgres_migration_batch_checkpoints",
    "sqlite_postgres_migration_runs",
    "sqlite_postgres_migration_row_changes",
    "sqlite_postgres_migration_table_checkpoints",
    "user_preferences",
    "webhook_deliveries",
    "webhooks",
  ];
  const tableRows = await pool.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
      ORDER BY tablename`,
    [requiredTables],
  );
  assert.deepEqual(
    tableRows.rows.map((row) => row.tablename),
    [...requiredTables].sort(),
  );

  const requiredIndexes = [
    "idx_api_token_resources_resource",
    "idx_api_token_resources_token",
    "idx_block_operations_note",
    "idx_note_blocks_hash",
    "idx_note_blocks_note_order",
    "idx_note_import_origins_batch",
    "idx_note_import_origins_note",
    "idx_note_import_origins_scope_external",
    "idx_note_split_attachment_operation",
    "idx_note_split_items_operation",
    "idx_note_split_operations_source",
    "idx_note_transfer_effect_outbox_claim",
    "idx_note_transfer_effect_outbox_operation",
    "idx_note_transfer_items_source",
    "idx_note_transfer_move_source_claim",
    "idx_note_transfer_move_source_operation",
    "idx_note_transfer_operations_orchestration_claim",
    "idx_note_transfer_operations_orchestration_user",
    "idx_note_transfer_operations_status_expiry",
    "idx_note_transfer_operations_user_time",
    "idx_note_transfer_staged_attachments_cleanup_lease",
    "idx_note_transfer_staged_attachments_lease",
    "idx_note_transfer_staged_attachments_operation_status",
    "idx_note_transfer_staged_attachments_source_note",
    "idx_note_y_subdocument_structure_operations_created",
    "idx_note_y_subdocument_updates_section",
    "idx_note_y_subdocuments_order",
    "idx_notebook_members_notebook_user",
    "idx_roundtrip_import_batches_scope_time",
    "idx_roundtrip_import_batches_source",
    "idx_roundtrip_import_batches_user_time",
    "idx_roundtrip_links_batch",
    "idx_roundtrip_links_source",
    "idx_roundtrip_links_target",
    "idx_sqlite_pg_migration_batches_table",
    "idx_sqlite_pg_migration_runs_claim",
    "idx_sqlite_pg_migration_runs_source",
    "idx_sqlite_pg_migration_tables_claim",
  ];
  const indexRows = await pool.query<{ indexname: string }>(
    `SELECT indexname
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1::text[])
      ORDER BY indexname`,
    [requiredIndexes],
  );
  assert.deepEqual(
    indexRows.rows.map((row) => row.indexname),
    [...requiredIndexes].sort(),
  );

  const requiredColumns: Array<[string, string]> = [
    ["api_tokens", "resourceMode"],
    ["api_tokens", "scopes"],
    ["api_tokens", "tokenHash"],
    ["note_transfer_operations", "orchestrationAttempts"],
    ["note_transfer_operations", "orchestrationAvailableAt"],
    ["note_transfer_operations", "orchestrationLastAdvancedAt"],
    ["note_transfer_operations", "orchestrationLastError"],
    ["note_transfer_operations", "orchestrationLeaseExpiresAt"],
    ["note_transfer_operations", "orchestrationLeaseToken"],
    ["note_transfer_staged_attachments", "cleanupAttempts"],
    ["note_transfer_staged_attachments", "cleanupLeaseExpiresAt"],
    ["note_transfer_staged_attachments", "cleanupLeaseToken"],
    ["note_transfer_staged_attachments", "cleanupStatus"],
    ["note_transfer_staged_attachments", "leaseExpiresAt"],
    ["note_transfer_staged_attachments", "leaseToken"],
    ["sqlite_postgres_migration_runs", "sourceFingerprint"],
    ["sqlite_postgres_migration_runs", "sourceSnapshot"],
    ["sqlite_postgres_migration_runs", "targetWasEmpty"],
    ["sqlite_postgres_migration_table_checkpoints", "lastCursor"],
    ["sqlite_postgres_migration_table_checkpoints", "primaryKeyColumns"],
  ];
  const columnRows = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          SELECT item->>0, item->>1
            FROM jsonb_array_elements($1::jsonb) item
        )
      ORDER BY table_name, column_name`,
    [JSON.stringify(requiredColumns)],
  );
  assert.deepEqual(
    columnRows.rows.map((row) => [row.table_name, row.column_name]),
    [...requiredColumns].sort(([leftTable, leftColumn], [rightTable, rightColumn]) =>
      leftTable.localeCompare(rightTable) || leftColumn.localeCompare(rightColumn)),
  );

  const second = await runPostgresMigrations(adapter);
  assert.deepEqual(second, first);

  await closePgPool(pool);
});
