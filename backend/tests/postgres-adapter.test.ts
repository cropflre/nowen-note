/**
 * PostgresAdapter 测试
 *
 * 需要 TEST_PG_DATABASE_URL 环境变量。
 * 无 TEST_PG_DATABASE_URL 时全部 skip。
 *
 * 启动 PostgreSQL：
 *   docker compose -f docker-compose.postgres.yml up -d
 *   $env:TEST_PG_DATABASE_URL="postgres://nowen:nowen_dev_password@localhost:5432/nowen_note_test"
 */

import assert from "node:assert/strict";
import test from "node:test";

const PG_URL = process.env.TEST_PG_DATABASE_URL;

// Skip all tests if no PostgreSQL available
const skip = !PG_URL;

async function getPgPool() {
  if (!PG_URL) throw new Error("TEST_PG_DATABASE_URL not set");
  const { Pool } = await import("pg");
  return new Pool({ connectionString: PG_URL });
}

async function setupTable(pool: import("pg").Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query("DELETE FROM test_items");
}

async function dropTable(pool: import("pg").Pool) {
  await pool.query("DROP TABLE IF EXISTS test_items");
}

// ============================================================
// queryOne
// ============================================================

test("PostgresAdapter queryOne returns one row", { skip }, async () => {
  const pool = await getPgPool();
  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  await setupTable(pool);

  await pool.query("INSERT INTO test_items (id, name, count) VALUES ($1, $2, $3)", ["a1", "alpha", 10]);
  const adapter = new PostgresAdapter(pool);
  const row = await adapter.queryOne<{ id: string; name: string; count: number }>(
    "SELECT id, name, count FROM test_items WHERE id = ?",
    ["a1"],
  );

  assert.ok(row);
  assert.equal(row.name, "alpha");
  assert.equal(row.count, 10);

  await dropTable(pool);
  await pool.end();
});

test("PostgresAdapter queryOne returns undefined when not found", { skip }, async () => {
  const pool = await getPgPool();
  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  await setupTable(pool);

  const adapter = new PostgresAdapter(pool);
  const row = await adapter.queryOne<{ id: string }>(
    "SELECT id FROM test_items WHERE id = ?",
    ["nonexistent"],
  );

  assert.equal(row, undefined);

  await dropTable(pool);
  await pool.end();
});

// ============================================================
// queryMany
// ============================================================

test("PostgresAdapter queryMany returns multiple rows", { skip }, async () => {
  const pool = await getPgPool();
  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  await setupTable(pool);

  await pool.query("INSERT INTO test_items (id, name, count) VALUES ($1, $2, $3)", ["a1", "alpha", 1]);
  await pool.query("INSERT INTO test_items (id, name, count) VALUES ($1, $2, $3)", ["b1", "beta", 2]);
  await pool.query("INSERT INTO test_items (id, name, count) VALUES ($1, $2, $3)", ["g1", "gamma", 3]);

  const adapter = new PostgresAdapter(pool);
  const rows = await adapter.queryMany<{ id: string; name: string }>(
    "SELECT id, name FROM test_items ORDER BY name",
  );

  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, "alpha");
  assert.equal(rows[1].name, "beta");
  assert.equal(rows[2].name, "gamma");

  await dropTable(pool);
  await pool.end();
});

test("PostgresAdapter queryMany returns empty array when no rows", { skip }, async () => {
  const pool = await getPgPool();
  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  await setupTable(pool);

  const adapter = new PostgresAdapter(pool);
  const rows = await adapter.queryMany<{ id: string }>("SELECT id FROM test_items");

  assert.deepEqual(rows, []);

  await dropTable(pool);
  await pool.end();
});

// ============================================================
// execute
// ============================================================

test("PostgresAdapter execute inserts row and returns changes", { skip }, async () => {
  const pool = await getPgPool();
  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  await setupTable(pool);

  const adapter = new PostgresAdapter(pool);
  const result = await adapter.execute(
    "INSERT INTO test_items (id, name, count) VALUES (?, ?, ?)",
    ["a1", "alpha", 42],
  );

  assert.equal(result.changes, 1);

  const row = await pool.query("SELECT name, count FROM test_items WHERE id = $1", ["a1"]);
  assert.equal(row.rows[0].name, "alpha");
  assert.equal(row.rows[0].count, 42);

  await dropTable(pool);
  await pool.end();
});

// ============================================================
// executeBatch
// ============================================================

test("PostgresAdapter executeBatch inserts multiple rows", { skip }, async () => {
  const pool = await getPgPool();
  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  await setupTable(pool);

  const adapter = new PostgresAdapter(pool);
  const result = await adapter.executeBatch(
    "INSERT INTO test_items (id, name, count) VALUES (?, ?, ?)",
    [["a1", "alpha", 1], ["b1", "beta", 2], ["g1", "gamma", 3]],
  );

  assert.equal(result.changes, 3);

  const rows = await pool.query("SELECT name FROM test_items ORDER BY name");
  assert.equal(rows.rows.length, 3);

  await dropTable(pool);
  await pool.end();
});

test("PostgresAdapter executeBatch rolls back on failure", { skip }, async () => {
  const pool = await getPgPool();
  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  await setupTable(pool);

  await pool.query("INSERT INTO test_items (id, name, count) VALUES ($1, $2, $3)", ["existing", "ex", 0]);

  const adapter = new PostgresAdapter(pool);
  await assert.rejects(
    () => adapter.executeBatch(
      "INSERT INTO test_items (id, name, count) VALUES (?, ?, ?)",
      [["new1", "new", 1], ["existing", "dup", 2]],
    ),
  );

  // Verify rollback - new1 should not exist
  const rows = await pool.query("SELECT * FROM test_items");
  assert.equal(rows.rows.length, 1, "first insert should be rolled back");

  await dropTable(pool);
  await pool.end();
});

test("PostgresAdapter executeBatch returns changes 0 for empty paramsList", { skip }, async () => {
  const pool = await getPgPool();
  const { PostgresAdapter } = await import("../src/db/postgresAdapter");

  const adapter = new PostgresAdapter(pool);
  const result = await adapter.executeBatch(
    "INSERT INTO test_items (id, name, count) VALUES (?, ?, ?)",
    [],
  );

  assert.equal(result.changes, 0);

  await pool.end();
});

// ============================================================
// executeStatements
// ============================================================

test("PostgresAdapter executeStatements runs multiple statements", { skip }, async () => {
  const pool = await getPgPool();
  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  await setupTable(pool);

  const adapter = new PostgresAdapter(pool);
  const result = await adapter.executeStatements([
    { sql: "INSERT INTO test_items (id, name, count) VALUES (?, ?, ?)", params: ["a1", "alpha", 1] },
    { sql: "INSERT INTO test_items (id, name, count) VALUES (?, ?, ?)", params: ["b1", "beta", 2] },
  ]);

  assert.equal(result.changes, 2);

  const rows = await pool.query("SELECT name FROM test_items ORDER BY name");
  assert.equal(rows.rows.length, 2);

  await dropTable(pool);
  await pool.end();
});

test("PostgresAdapter executeStatements rolls back on failure", { skip }, async () => {
  const pool = await getPgPool();
  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  await setupTable(pool);

  const adapter = new PostgresAdapter(pool);
  await assert.rejects(
    () => adapter.executeStatements([
      { sql: "INSERT INTO test_items (id, name, count) VALUES (?, ?, ?)", params: ["a1", "alpha", 1] },
      { sql: "INSERT INTO nonexistent_table (id) VALUES (?)", params: ["x"] },
    ]),
  );

  // Verify rollback
  const rows = await pool.query("SELECT * FROM test_items");
  assert.equal(rows.rows.length, 0, "first insert should be rolled back");

  await dropTable(pool);
  await pool.end();
});

// ============================================================
// placeholder conversion
// ============================================================

test("PostgresAdapter converts ? placeholders to $1, $2", { skip }, async () => {
  const pool = await getPgPool();
  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  await setupTable(pool);

  await pool.query("INSERT INTO test_items (id, name, count) VALUES ($1, $2, $3)", ["a1", "alpha", 10]);

  const adapter = new PostgresAdapter(pool);
  const row = await adapter.queryOne<{ name: string }>(
    "SELECT name FROM test_items WHERE id = ? AND count = ?",
    ["a1", 10],
  );

  assert.ok(row);
  assert.equal(row.name, "alpha");

  await dropTable(pool);
  await pool.end();
});
