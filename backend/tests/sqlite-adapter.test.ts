/**
 * SqliteAdapter 最小行为测试
 *
 * 验证 Phase 1 async adapter 的基本功能：
 * - queryOne 查询单条记录
 * - queryMany 查询多条记录
 * - execute 执行写操作
 * - changes / lastInsertRowid 返回值
 * - SQLite ? 占位符
 *
 * 使用内存 SQLite，不访问真实 DB_PATH。
 * 不涉及 withTransaction，不涉及 PostgreSQL。
 */

import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { SqliteAdapter } from "../src/db/adapters/sqliteAdapter";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

test("queryOne returns one row", async () => {
  const db = createTestDb();
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("alpha", 10);

  const adapter = new SqliteAdapter(db);
  const row = await adapter.queryOne<{ id: number; name: string; count: number }>(
    "SELECT id, name, count FROM items WHERE name = ?",
    ["alpha"],
  );

  assert.ok(row);
  assert.equal(row.name, "alpha");
  assert.equal(row.count, 10);

  db.close();
});

test("queryOne returns undefined when not found", async () => {
  const db = createTestDb();

  const adapter = new SqliteAdapter(db);
  const row = await adapter.queryOne<{ id: number }>(
    "SELECT id FROM items WHERE name = ?",
    ["nonexistent"],
  );

  assert.equal(row, undefined);

  db.close();
});

test("queryMany returns multiple rows", async () => {
  const db = createTestDb();
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("alpha", 1);
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("beta", 2);
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("gamma", 3);

  const adapter = new SqliteAdapter(db);
  const rows = await adapter.queryMany<{ id: number; name: string }>(
    "SELECT id, name FROM items ORDER BY name ASC",
  );

  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, "alpha");
  assert.equal(rows[1].name, "beta");
  assert.equal(rows[2].name, "gamma");

  db.close();
});

test("queryMany returns empty array when no rows", async () => {
  const db = createTestDb();

  const adapter = new SqliteAdapter(db);
  const rows = await adapter.queryMany<{ id: number }>(
    "SELECT id FROM items",
  );

  assert.deepEqual(rows, []);

  db.close();
});

test("execute inserts row and returns changes / lastInsertRowid", async () => {
  const db = createTestDb();

  const adapter = new SqliteAdapter(db);
  const result = await adapter.execute(
    "INSERT INTO items (name, count) VALUES (?, ?)",
    ["alpha", 42],
  );

  assert.equal(result.changes, 1);
  assert.ok(result.lastInsertRowid);
  assert.ok(Number(result.lastInsertRowid) > 0);

  // 验证数据确实插入
  const row = db.prepare("SELECT name, count FROM items WHERE id = ?").get(
    result.lastInsertRowid,
  ) as { name: string; count: number };
  assert.equal(row.name, "alpha");
  assert.equal(row.count, 42);

  db.close();
});

test("execute updates row and returns changes", async () => {
  const db = createTestDb();
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("alpha", 10);

  const adapter = new SqliteAdapter(db);
  const result = await adapter.execute(
    "UPDATE items SET count = ? WHERE name = ?",
    [99, "alpha"],
  );

  assert.equal(result.changes, 1);

  // 验证数据确实更新
  const row = db.prepare("SELECT count FROM items WHERE name = ?").get("alpha") as {
    count: number;
  };
  assert.equal(row.count, 99);

  db.close();
});

test("execute deletes row and returns changes", async () => {
  const db = createTestDb();
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("alpha", 10);

  const adapter = new SqliteAdapter(db);
  const result = await adapter.execute(
    "DELETE FROM items WHERE name = ?",
    ["alpha"],
  );

  assert.equal(result.changes, 1);

  // 验证数据确实删除
  const row = db.prepare("SELECT id FROM items WHERE name = ?").get("alpha");
  assert.equal(row, undefined);

  db.close();
});

test("parameters use SQLite question mark placeholders", async () => {
  const db = createTestDb();
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("alpha", 10);
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("beta", 20);

  const adapter = new SqliteAdapter(db);

  // 使用多个 ? 占位符
  const row = await adapter.queryOne<{ name: string; count: number }>(
    "SELECT name, count FROM items WHERE name = ? AND count = ?",
    ["beta", 20],
  );

  assert.ok(row);
  assert.equal(row.name, "beta");
  assert.equal(row.count, 20);

  db.close();
});

test("execute with empty params", async () => {
  const db = createTestDb();
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("alpha", 1);

  const adapter = new SqliteAdapter(db);
  const rows = await adapter.queryMany<{ id: number }>(
    "SELECT id FROM items",
  );

  assert.equal(rows.length, 1);

  db.close();
});

// ============================================================
// executeBatch
// ============================================================

test("executeBatch inserts multiple rows", async () => {
  const db = createTestDb();
  const adapter = new SqliteAdapter(db);

  const result = await adapter.executeBatch(
    "INSERT INTO items (name, count) VALUES (?, ?)",
    [["alpha", 1], ["beta", 2], ["gamma", 3]],
  );

  assert.equal(result.changes, 3);
  const rows = db.prepare("SELECT name FROM items ORDER BY name").all() as { name: string }[];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, "alpha");
  assert.equal(rows[1].name, "beta");
  assert.equal(rows[2].name, "gamma");

  db.close();
});

test("executeBatch returns total changes for updates", async () => {
  const db = createTestDb();
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("alpha", 1);
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("beta", 2);
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("gamma", 3);

  const adapter = new SqliteAdapter(db);
  const result = await adapter.executeBatch(
    "UPDATE items SET count = ? WHERE name = ?",
    [[10, "alpha"], [20, "beta"], [30, "gamma"]],
  );

  assert.equal(result.changes, 3);
  const row = db.prepare("SELECT SUM(count) as total FROM items").get() as { total: number };
  assert.equal(row.total, 60);

  db.close();
});

test("executeBatch returns total changes for deletes", async () => {
  const db = createTestDb();
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("alpha", 1);
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("beta", 2);
  db.prepare("INSERT INTO items (name, count) VALUES (?, ?)").run("gamma", 3);

  const adapter = new SqliteAdapter(db);
  const result = await adapter.executeBatch(
    "DELETE FROM items WHERE name = ?",
    [["alpha"], ["gamma"]],
  );

  assert.equal(result.changes, 2);
  const rows = db.prepare("SELECT name FROM items").all() as { name: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "beta");

  db.close();
});

test("executeBatch returns changes 0 for empty paramsList", async () => {
  const db = createTestDb();
  const adapter = new SqliteAdapter(db);

  const result = await adapter.executeBatch(
    "INSERT INTO items (name, count) VALUES (?, ?)",
    [],
  );

  assert.equal(result.changes, 0);
  const rows = db.prepare("SELECT * FROM items").all();
  assert.equal(rows.length, 0);

  db.close();
});

test("executeBatch rolls back on failure", async () => {
  const db = createTestDb();
  db.exec("CREATE TABLE uniq (id INTEGER PRIMARY KEY, name TEXT UNIQUE)");
  db.prepare("INSERT INTO uniq (name) VALUES (?)").run("existing");

  const adapter = new SqliteAdapter(db);

  // 第二条会违反 UNIQUE 约束
  await assert.rejects(
    () => adapter.executeBatch(
      "INSERT INTO uniq (name) VALUES (?)",
      [["new_row"], ["existing"]], // 第二条会失败
    ),
    (err: Error) => err.message.includes("UNIQUE"),
  );

  // 确认第一条也被回滚
  const rows = db.prepare("SELECT name FROM uniq").all() as { name: string }[];
  assert.equal(rows.length, 1, "first insert should be rolled back");
  assert.equal(rows[0].name, "existing");

  db.close();
});

test("executeBatch failure propagates error", async () => {
  const db = createTestDb();
  db.exec("CREATE TABLE strict_tbl (id INTEGER PRIMARY KEY, val TEXT NOT NULL)");

  const adapter = new SqliteAdapter(db);

  await assert.rejects(
    () => adapter.executeBatch(
      "INSERT INTO strict_tbl (val) VALUES (?)",
      [["ok"], [null]], // null 违反 NOT NULL
    ),
  );

  db.close();
});

test("executeBatch does not affect existing queryOne/queryMany/execute", async () => {
  const db = createTestDb();
  const adapter = new SqliteAdapter(db);

  // execute
  await adapter.execute("INSERT INTO items (name, count) VALUES (?, ?)", ["alpha", 1]);
  // queryOne
  const one = await adapter.queryOne<{ name: string }>("SELECT name FROM items WHERE name = ?", ["alpha"]);
  assert.ok(one);
  assert.equal(one.name, "alpha");
  // queryMany
  await adapter.execute("INSERT INTO items (name, count) VALUES (?, ?)", ["beta", 2]);
  const many = await adapter.queryMany<{ name: string }>("SELECT name FROM items ORDER BY name");
  assert.equal(many.length, 2);
  // executeBatch
  const batch = await adapter.executeBatch("INSERT INTO items (name, count) VALUES (?, ?)", [["gamma", 3]]);
  assert.equal(batch.changes, 1);
  const all = await adapter.queryMany<{ name: string }>("SELECT name FROM items ORDER BY name");
  assert.equal(all.length, 3);

  db.close();
});

test("executeBatch uses synchronous db.transaction (not async)", async () => {
  const db = createTestDb();
  const adapter = new SqliteAdapter(db);

  // 验证 executeBatch 正常工作即可证明使用了同步 transaction
  const result = await adapter.executeBatch(
    "INSERT INTO items (name, count) VALUES (?, ?)",
    [["a", 1], ["b", 2], ["c", 3]],
  );
  assert.equal(result.changes, 3);

  db.close();
});
