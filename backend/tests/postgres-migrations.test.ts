import assert from "node:assert/strict";
import test from "node:test";
import { hasPg, getPgPool, closePgPool } from "./helpers/pg-test-db";

const skip = !hasPg;

test("PG migrations bootstrap an empty database and are idempotent", { skip }, async () => {
  const pool = await getPgPool()!;
  await pool.query("DROP TABLE IF EXISTS postgres_schema_migrations");
  await pool.query("DROP TABLE IF EXISTS postgres_migration_state");

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { runPostgresMigrations } = await import("../src/db/postgres/migrations");
  const adapter = new PostgresAdapter(pool);

  const first = await runPostgresMigrations(adapter);
  const versions = first.map((migration) => migration.version);
  assert.deepEqual(versions, [
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
  ]);

  const stateTable = await pool.query(
    "SELECT to_regclass('public.postgres_migration_state') AS table_name",
  );
  assert.equal(stateTable.rows[0].table_name, "postgres_migration_state");

  const apiTokenColumns = await pool.query(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_tokens'
      AND column_name IN ('tokenHash', 'scopes', 'resourceMode')
    ORDER BY column_name
  `);
  assert.deepEqual(
    apiTokenColumns.rows.map((row) => [row.column_name, row.is_nullable]),
    [["resourceMode", "NO"], ["scopes", "NO"], ["tokenHash", "NO"]],
  );

  const parityTables = [
    "api_token_resources",
    "audit_logs",
    "habit_checkins",
    "habits",
    "mindmaps",
    "note_import_origins",
    "note_split_attachment_copies",
    "note_split_items",
    "note_split_operations",
    "notebook_acl_overrides",
    "notebook_public_comments",
    "notebook_publications",
    "roundtrip_import_batches",
    "roundtrip_import_links",
    "user_preferences",
    "webhook_deliveries",
    "webhooks",
  ];
  const tableRows = await pool.query(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
      ORDER BY tablename`,
    [parityTables],
  );
  assert.deepEqual(
    tableRows.rows.map((row) => row.tablename),
    [...parityTables].sort(),
  );

  const notebookMembersUnique = await pool.query(
    `SELECT to_regclass('public.idx_notebook_members_notebook_user') AS index_name`,
  );
  assert.equal(
    notebookMembersUnique.rows[0].index_name,
    "idx_notebook_members_notebook_user",
  );

  const resourceIndexes = await pool.query(
    `SELECT to_regclass('public.idx_api_token_resources_token') AS token_index,
            to_regclass('public.idx_api_token_resources_resource') AS resource_index`,
  );
  assert.equal(resourceIndexes.rows[0].token_index, "idx_api_token_resources_token");
  assert.equal(resourceIndexes.rows[0].resource_index, "idx_api_token_resources_resource");

  const shareColumns = await pool.query(`
    SELECT table_name, column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        (table_name = 'notebook_share_links' AND column_name IN ('maxUses', 'useCount'))
        OR
        (table_name = 'notebook_members' AND column_name IN ('allowDownload', 'allowReshare', 'source', 'sourceId'))
      )
    ORDER BY table_name, column_name
  `);
  assert.deepEqual(
    shareColumns.rows.map((row) => [row.table_name, row.column_name, row.is_nullable]),
    [
      ["notebook_members", "allowDownload", "NO"],
      ["notebook_members", "allowReshare", "NO"],
      ["notebook_members", "source", "NO"],
      ["notebook_members", "sourceId", "YES"],
      ["notebook_share_links", "maxUses", "YES"],
      ["notebook_share_links", "useCount", "NO"],
    ],
  );

  const importOriginIndexes = await pool.query(
    `SELECT to_regclass('public.idx_note_import_origins_scope_external') AS scope_external,
            to_regclass('public.idx_note_import_origins_note') AS note_index,
            to_regclass('public.idx_note_import_origins_batch') AS batch_index`,
  );
  assert.equal(
    importOriginIndexes.rows[0].scope_external,
    "idx_note_import_origins_scope_external",
  );
  assert.equal(importOriginIndexes.rows[0].note_index, "idx_note_import_origins_note");
  assert.equal(importOriginIndexes.rows[0].batch_index, "idx_note_import_origins_batch");

  const splitIndexes = await pool.query(
    `SELECT to_regclass('public.idx_note_split_operations_source') AS operations_index,
            to_regclass('public.idx_note_split_items_operation') AS items_index,
            to_regclass('public.idx_note_split_attachment_operation') AS attachments_index`,
  );
  assert.equal(
    splitIndexes.rows[0].operations_index,
    "idx_note_split_operations_source",
  );
  assert.equal(splitIndexes.rows[0].items_index, "idx_note_split_items_operation");
  assert.equal(
    splitIndexes.rows[0].attachments_index,
    "idx_note_split_attachment_operation",
  );

  const roundTripIndexes = await pool.query(
    `SELECT to_regclass('public.idx_roundtrip_links_source') AS link_source,
            to_regclass('public.idx_roundtrip_links_target') AS link_target,
            to_regclass('public.idx_roundtrip_links_batch') AS link_batch,
            to_regclass('public.idx_roundtrip_import_batches_user_time') AS batch_user,
            to_regclass('public.idx_roundtrip_import_batches_scope_time') AS batch_scope,
            to_regclass('public.idx_roundtrip_import_batches_source') AS batch_source`,
  );
  assert.equal(roundTripIndexes.rows[0].link_source, "idx_roundtrip_links_source");
  assert.equal(roundTripIndexes.rows[0].link_target, "idx_roundtrip_links_target");
  assert.equal(roundTripIndexes.rows[0].link_batch, "idx_roundtrip_links_batch");
  assert.equal(roundTripIndexes.rows[0].batch_user, "idx_roundtrip_import_batches_user_time");
  assert.equal(roundTripIndexes.rows[0].batch_scope, "idx_roundtrip_import_batches_scope_time");
  assert.equal(roundTripIndexes.rows[0].batch_source, "idx_roundtrip_import_batches_source");

  const second = await runPostgresMigrations(adapter);
  assert.deepEqual(second, first);

  await closePgPool(pool);
});
