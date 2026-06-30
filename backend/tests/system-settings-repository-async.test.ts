/**
 * systemSettingsRepository async 方法行为测试
 *
 * 重点：setManyAsync 使用 executeBatch 事务
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sys-set-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { systemSettingsRepository } from "../src/repositories/systemSettingsRepository";
import { getDb } from "../src/db/schema";

function clean() {
  getDb().prepare("DELETE FROM system_settings").run();
}

// ============================================================
// setAsync (existing, regression)
// ============================================================

test("setAsync upserts a single setting", async () => {
  clean();
  await systemSettingsRepository.setAsync("theme", "dark");
  const row = getDb().prepare("SELECT key, value FROM system_settings WHERE key = ?").get("theme") as any;
  assert.equal(row.key, "theme");
  assert.equal(row.value, "dark");
  clean();
});

// ============================================================
// setManyAsync
// ============================================================

test("setManyAsync inserts multiple settings", async () => {
  clean();
  await systemSettingsRepository.setManyAsync([
    { key: "theme", value: "dark" },
    { key: "lang", value: "en" },
    { key: "fontSize", value: "14" },
  ]);
  const rows = getDb().prepare("SELECT key, value FROM system_settings ORDER BY key").all() as any[];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].key, "fontSize");
  assert.equal(rows[0].value, "14");
  assert.equal(rows[1].key, "lang");
  assert.equal(rows[1].value, "en");
  assert.equal(rows[2].key, "theme");
  assert.equal(rows[2].value, "dark");
  clean();
});

test("setManyAsync updates existing settings", async () => {
  clean();
  await systemSettingsRepository.setAsync("theme", "light");
  await systemSettingsRepository.setManyAsync([
    { key: "theme", value: "dark" },
    { key: "lang", value: "zh" },
  ]);
  const theme = getDb().prepare("SELECT value FROM system_settings WHERE key = ?").get("theme") as any;
  assert.equal(theme.value, "dark");
  const lang = getDb().prepare("SELECT value FROM system_settings WHERE key = ?").get("lang") as any;
  assert.equal(lang.value, "zh");
  clean();
});

test("setManyAsync with empty array is no-op", async () => {
  clean();
  await systemSettingsRepository.setAsync("theme", "dark");
  await systemSettingsRepository.setManyAsync([]);
  const rows = getDb().prepare("SELECT * FROM system_settings").all() as any[];
  assert.equal(rows.length, 1);
  clean();
});

test("setManyAsync results are readable via getAsync", async () => {
  clean();
  await systemSettingsRepository.setManyAsync([
    { key: "a", value: "1" },
    { key: "b", value: "2" },
  ]);
  const a = await systemSettingsRepository.getAsync("a");
  assert.ok(a);
  assert.equal(a.value, "1");
  const b = await systemSettingsRepository.getAsync("b");
  assert.ok(b);
  assert.equal(b.value, "2");
  clean();
});

test("setManyAsync results are readable via getManyAsync", async () => {
  clean();
  await systemSettingsRepository.setManyAsync([
    { key: "x", value: "10" },
    { key: "y", value: "20" },
    { key: "z", value: "30" },
  ]);
  const results = await systemSettingsRepository.getManyAsync(["x", "z"]);
  assert.equal(results.length, 2);
  clean();
});

test("setManyAsync sets updatedAt", async () => {
  clean();
  await systemSettingsRepository.setManyAsync([{ key: "test", value: "val" }]);
  const row = getDb().prepare("SELECT updatedAt FROM system_settings WHERE key = ?").get("test") as any;
  assert.ok(row.updatedAt, "updatedAt should be set");
  clean();
});
