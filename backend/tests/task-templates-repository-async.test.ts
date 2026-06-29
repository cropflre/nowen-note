/**
 * taskTemplatesRepository async 方法行为测试
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-tpl-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { taskTemplatesRepository } from "../src/repositories/taskTemplatesRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-tpl";

function seedBase() {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
}

function clean() {
  getDb().prepare("DELETE FROM task_templates").run();
}

test("createAsync inserts template", async () => {
  clean();
  seedBase();
  await taskTemplatesRepository.createAsync({
    id: "tpl-1", userId: USER_ID, workspaceId: null,
    name: "My Template", description: "desc", icon: "📝", color: "#fff",
    items: [{ title: "Step 1" }],
  });
  const row = getDb().prepare("SELECT * FROM task_templates WHERE id = ?").get("tpl-1") as any;
  assert.ok(row);
  assert.equal(row.name, "My Template");
  assert.equal(JSON.parse(row.items).length, 1);
  clean();
});

test("listByUserAsync returns user templates", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO task_templates (id, userId, workspaceId, name, items) VALUES (?, ?, ?, ?, ?)").run("t1", USER_ID, null, "A", "[]");
  getDb().prepare("INSERT INTO task_templates (id, userId, workspaceId, name, items, createdAt) VALUES (?, ?, ?, ?, ?, datetime('now', '-10 seconds'))").run("t2", USER_ID, null, "B", "[]");
  const rows = await taskTemplatesRepository.listByUserAsync(USER_ID, null);
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].id, "t1"); // 最新在前
  clean();
});

test("getByIdAsync returns template", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO task_templates (id, userId, workspaceId, name, items) VALUES (?, ?, ?, ?, ?)").run("tpl-find", USER_ID, null, "Found", "[]");
  const row = await taskTemplatesRepository.getByIdAsync("tpl-find");
  assert.ok(row);
  assert.equal(row.name, "Found");
  clean();
});

test("getByIdAsync returns undefined when not found", async () => {
  clean();
  const row = await taskTemplatesRepository.getByIdAsync("nonexistent");
  assert.equal(row, undefined);
});

test("updateAsync updates template", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO task_templates (id, userId, workspaceId, name, items) VALUES (?, ?, ?, ?, ?)").run("tpl-upd", USER_ID, null, "Old", "[]");
  await taskTemplatesRepository.updateAsync("tpl-upd", { name: "New", items: [{ title: "Updated" }] });
  const row = getDb().prepare("SELECT name, items FROM task_templates WHERE id = ?").get("tpl-upd") as any;
  assert.equal(row.name, "New");
  assert.equal(JSON.parse(row.items)[0].title, "Updated");
  clean();
});

test("deleteAsync removes template", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO task_templates (id, userId, workspaceId, name, items) VALUES (?, ?, ?, ?, ?)").run("tpl-del", USER_ID, null, "Del", "[]");
  await taskTemplatesRepository.deleteAsync("tpl-del");
  const row = getDb().prepare("SELECT id FROM task_templates WHERE id = ?").get("tpl-del");
  assert.equal(row, undefined);
});
