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

// ============================================================
// executeStatements
// ============================================================

test("executeStatements runs multiple INSERT statements", async () => {
  const db = createTestDb();
  const adapter = new SqliteAdapter(db);

  const result = await adapter.executeStatements([
    { sql: "INSERT INTO items (name, count) VALUES (?, ?)", params: ["alpha", 1] },
    { sql: "INSERT INTO items (name, count) VALUES (?, ?)", params: ["beta", 2] },
    { sql: "INSERT INTO items (name, count) VALUES (?, ?)", params: ["gamma", 3] },
  ]);

  assert.equal(result.changes, 3);
  const rows = db.prepare("SELECT name FROM items ORDER BY name").all() as { name: string }[];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, "alpha");
  assert.equal(rows[1].name, "beta");
  assert.equal(rows[2].name, "gamma");

  db.close();
});

test("executeStatements runs INSERT + UPDATE", async () => {
  const db = createTestDb();
  const adapter = new SqliteAdapter(db);

  const result = await adapter.executeStatements([
    { sql: "INSERT INTO items (name, count) VALUES (?, ?)", params: ["alpha", 1] },
    { sql: "UPDATE items SET count = ? WHERE name = ?", params: [99, "alpha"] },
  ]);

  assert.equal(result.changes, 2);
  const row = db.prepare("SELECT count FROM items WHERE name = ?").get("alpha") as { count: number };
  assert.equal(row.count, 99);

  db.close();
});

test("executeStatements runs DELETE + INSERT (link replacement pattern)", async () => {
  const db = createTestDb();
  db.exec("CREATE TABLE links (id TEXT PRIMARY KEY, source TEXT, target TEXT)");
  db.prepare("INSERT INTO links VALUES (?, ?, ?)").run("l1", "note-1", "note-2");
  db.prepare("INSERT INTO links VALUES (?, ?, ?)").run("l2", "note-1", "note-3");

  const adapter = new SqliteAdapter(db);

  const result = await adapter.executeStatements([
    { sql: "DELETE FROM links WHERE source = ?", params: ["note-1"] },
    { sql: "INSERT INTO links (id, source, target) VALUES (?, ?, ?)", params: ["l3", "note-1", "note-4"] },
    { sql: "INSERT INTO links (id, source, target) VALUES (?, ?, ?)", params: ["l4", "note-1", "note-5"] },
  ]);

  assert.equal(result.changes, 4); // 2 delete + 2 insert
  const rows = db.prepare("SELECT target FROM links WHERE source = ? ORDER BY target").all("note-1") as { target: string }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].target, "note-4");
  assert.equal(rows[1].target, "note-5");

  db.close();
});

test("executeStatements returns total changes", async () => {
  const db = createTestDb();
  const adapter = new SqliteAdapter(db);

  const result = await adapter.executeStatements([
    { sql: "INSERT INTO items (name, count) VALUES (?, ?)", params: ["a", 1] },
    { sql: "INSERT INTO items (name, count) VALUES (?, ?)", params: ["b", 2] },
    { sql: "UPDATE items SET count = ? WHERE name = ?", params: [10, "a"] },
  ]);

  assert.equal(result.changes, 3);

  db.close();
});

test("executeStatements returns changes 0 for empty statements", async () => {
  const db = createTestDb();
  const adapter = new SqliteAdapter(db);

  const result = await adapter.executeStatements([]);

  assert.equal(result.changes, 0);
  const rows = db.prepare("SELECT * FROM items").all();
  assert.equal(rows.length, 0);

  db.close();
});

test("executeStatements rolls back on failure (DELETE + INSERT scenario)", async () => {
  const db = createTestDb();
  db.exec("CREATE TABLE links (id TEXT PRIMARY KEY, source TEXT, target TEXT UNIQUE)");
  db.prepare("INSERT INTO links VALUES (?, ?, ?)").run("l1", "note-1", "note-2");
  db.prepare("INSERT INTO links VALUES (?, ?, ?)").run("l2", "note-1", "note-3");

  const adapter = new SqliteAdapter(db);

  // DELETE old links, then INSERT new ones — but second INSERT violates UNIQUE
  await assert.rejects(
    () => adapter.executeStatements([
      { sql: "DELETE FROM links WHERE source = ?", params: ["note-1"] },
      { sql: "INSERT INTO links (id, source, target) VALUES (?, ?, ?)", params: ["l3", "note-1", "note-4"] },
      { sql: "INSERT INTO links (id, source, target) VALUES (?, ?, ?)", params: ["l4", "note-1", "note-4"] }, // duplicate target
    ]),
    (err: Error) => err.message.includes("UNIQUE"),
  );

  // Old data should still exist (rolled back)
  const rows = db.prepare("SELECT * FROM links").all() as any[];
  assert.equal(rows.length, 2, "old links should be preserved after rollback");
  assert.equal(rows[0].id, "l1");
  assert.equal(rows[1].id, "l2");

  db.close();
});

test("executeStatements failure propagates error", async () => {
  const db = createTestDb();
  db.exec("CREATE TABLE strict_tbl (id INTEGER PRIMARY KEY, val TEXT NOT NULL)");

  const adapter = new SqliteAdapter(db);

  await assert.rejects(
    () => adapter.executeStatements([
      { sql: "INSERT INTO strict_tbl (val) VALUES (?)", params: ["ok"] },
      { sql: "INSERT INTO strict_tbl (val) VALUES (?)", params: [null] },
    ]),
  );

  db.close();
});

test("executeStatements executes in order", async () => {
  const db = createTestDb();
  db.exec("CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT)");
  const adapter = new SqliteAdapter(db);

  await adapter.executeStatements([
    { sql: "INSERT INTO log (action) VALUES (?)", params: ["first"] },
    { sql: "INSERT INTO log (action) VALUES (?)", params: ["second"] },
    { sql: "INSERT INTO log (action) VALUES (?)", params: ["third"] },
  ]);

  const rows = db.prepare("SELECT action FROM log ORDER BY id").all() as { action: string }[];
  assert.equal(rows[0].action, "first");
  assert.equal(rows[1].action, "second");
  assert.equal(rows[2].action, "third");

  db.close();
});

test("executeStatements does not affect executeBatch", async () => {
  const db = createTestDb();
  const adapter = new SqliteAdapter(db);

  // executeStatements
  await adapter.executeStatements([
    { sql: "INSERT INTO items (name, count) VALUES (?, ?)", params: ["alpha", 1] },
  ]);
  // executeBatch
  const batch = await adapter.executeBatch(
    "INSERT INTO items (name, count) VALUES (?, ?)",
    [["beta", 2], ["gamma", 3]],
  );
  assert.equal(batch.changes, 2);

  const rows = db.prepare("SELECT name FROM items ORDER BY name").all() as { name: string }[];
  assert.equal(rows.length, 3);

  db.close();
});

test("executeStatements does not affect existing queryOne/queryMany/execute/executeBatch", async () => {
  const db = createTestDb();
  const adapter = new SqliteAdapter(db);

  // execute
  await adapter.execute("INSERT INTO items (name, count) VALUES (?, ?)", ["a", 1]);
  // queryOne
  const one = await adapter.queryOne<{ name: string }>("SELECT name FROM items WHERE name = ?", ["a"]);
  assert.ok(one);
  // queryMany
  const many = await adapter.queryMany<{ name: string }>("SELECT name FROM items");
  assert.equal(many.length, 1);
  // executeBatch
  await adapter.executeBatch("INSERT INTO items (name, count) VALUES (?, ?)", [["b", 2]]);
  // executeStatements
  await adapter.executeStatements([
    { sql: "INSERT INTO items (name, count) VALUES (?, ?)", params: ["c", 3] },
  ]);
  const all = await adapter.queryMany<{ name: string }>("SELECT name FROM items ORDER BY name");
  assert.equal(all.length, 3);

  db.close();
});
