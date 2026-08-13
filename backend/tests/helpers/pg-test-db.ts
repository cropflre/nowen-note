import { PostgresAdapter } from "../../src/db/postgresAdapter";
import { runPostgresMigrations } from "../../src/db/postgres/migrations";

const PG_URL = process.env.TEST_PG_DATABASE_URL;

export async function getPgPool() {
  if (!PG_URL) return null;
  const { Pool } = await import("pg");
  return new Pool({ connectionString: PG_URL });
}

/**
 * Mirror production startup: bootstrap the idempotent schema and then apply every
 * immutable versioned migration. Tests must not silently run against a smaller
 * schema than PostgreSQL runtime-only uses in production.
 */
export async function initPgSchema(pool: import("pg").Pool) {
  await runPostgresMigrations(new PostgresAdapter(pool));
}

export async function cleanTable(pool: import("pg").Pool, table: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error(`unsafe PostgreSQL test table name: ${table}`);
  }
  await pool.query(`DELETE FROM ${table}`);
}

export async function closePgPool(pool: import("pg").Pool) {
  await pool.end();
}

export const hasPg = !!PG_URL;
