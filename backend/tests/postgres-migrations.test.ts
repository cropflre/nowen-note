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
  assert.deepEqual(versions, ["0001_migration_state", "0002_api_tokens_parity"]);

  const stateTable = await pool.query(
    "SELECT to_regclass('public.postgres_migration_state') AS table_name",
  );
  assert.equal(stateTable.rows[0].table_name, "postgres_migration_state");

  const apiTokenColumns = await pool.query(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_tokens'
      AND column_name IN ('tokenHash', 'scopes')
    ORDER BY column_name
  `);
  assert.deepEqual(
    apiTokenColumns.rows.map((row) => [row.column_name, row.is_nullable]),
    [["scopes", "NO"], ["tokenHash", "NO"]],
  );

  const second = await runPostgresMigrations(adapter);
  assert.deepEqual(second, first);

  await closePgPool(pool);
});
