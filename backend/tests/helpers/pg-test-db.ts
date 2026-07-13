/**
 * PostgreSQL test database helper.
 *
 * schema.sql may use psql's \ir directive so existing pilot databases can run
 * a prelude before the idempotent baseline. node-postgres does not understand
 * psql meta-commands, therefore tests inline the referenced baseline first.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PG_URL = process.env.TEST_PG_DATABASE_URL;

export async function getPgPool() {
  if (!PG_URL) return null;
  const { Pool } = await import("pg");
  return new Pool({ connectionString: PG_URL });
}

function readPgSchema(schemaPath: string): string {
  const source = readFileSync(schemaPath, "utf-8");
  return source.replace(/^\\ir\s+(.+)$/gm, (_line, relativePath: string) => {
    const clean = relativePath.trim().replace(/^['"]|['"]$/g, "");
    return readFileSync(join(dirname(schemaPath), clean), "utf-8");
  });
}

export async function initPgSchema(pool: import("pg").Pool) {
  const schemaPath = join(__dirname, "..", "..", "src", "db", "postgres", "schema.sql");
  await pool.query(readPgSchema(schemaPath));
}

export async function cleanTable(pool: import("pg").Pool, table: string) {
  await pool.query(`DELETE FROM ${table}`);
}

export async function closePgPool(pool: import("pg").Pool) {
  await pool.end();
}

export const hasPg = !!PG_URL;
