import assert from "node:assert/strict";
import test from "node:test";

test("SQLite 自托管运行 PRAGMA（WAL、temp_store=MEMORY、cache_size=-16000、busy_timeout>=5000）生效", async () => {
  const { getDb } = await import("../src/db/schema.js");
  const db = getDb();

  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(db.pragma("temp_store", { simple: true }), 2); // MEMORY
  assert.equal(db.pragma("cache_size", { simple: true }), -16000);
  assert.ok(Number(db.pragma("busy_timeout", { simple: true })) >= 5000);
});
