/**
 * notebookMembersRepository async 方法行为测试
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-nb-mem-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { notebookMembersRepository } from "../src/repositories/notebookMembersRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-nm";
const NB_ID = "nb-nm";

function seedBase() {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash, email) VALUES (?, ?, ?, ?)").run(USER_ID, USER_ID, "hash", "user@test.com");
  getDb().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NB_ID, USER_ID, "Test NB");
}

function clean() {
  getDb().prepare("DELETE FROM notebook_members").run();
}

test("upsertAsync inserts member", async () => {
  clean();
  seedBase();
  await notebookMembersRepository.upsertAsync({
    id: "nm-1", notebookId: NB_ID, userId: USER_ID, role: "owner", invitedBy: null,
  });
  const row = getDb().prepare("SELECT * FROM notebook_members WHERE notebookId = ? AND userId = ?").get(NB_ID, USER_ID) as any;
  assert.ok(row);
  assert.equal(row.role, "owner");
  assert.equal(row.status, "active");
  clean();
});

test("upsertAsync updates existing member on conflict", async () => {
  clean();
  seedBase();
  await notebookMembersRepository.upsertAsync({
    id: "nm-upsert1", notebookId: NB_ID, userId: USER_ID, role: "viewer", invitedBy: null,
  });
  await notebookMembersRepository.upsertAsync({
    id: "nm-upsert2", notebookId: NB_ID, userId: USER_ID, role: "editor", invitedBy: null,
  });
  const rows = getDb().prepare("SELECT * FROM notebook_members WHERE notebookId = ? AND userId = ?").all(NB_ID, USER_ID);
  assert.equal(rows.length, 1); // only one row
  const row = rows[0] as any;
  assert.equal(row.role, "editor"); // updated
  assert.equal(row.status, "active");
  clean();
});

test("getRoleAsync returns role", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO notebook_members (id, notebookId, userId, role, status) VALUES (?, ?, ?, ?, ?)").run("nm-role", NB_ID, USER_ID, "editor", "active");
  const row = await notebookMembersRepository.getRoleAsync(NB_ID, USER_ID);
  assert.ok(row);
  assert.equal(row.role, "editor");
  clean();
});

test("getRoleAsync returns undefined for removed member", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO notebook_members (id, notebookId, userId, role, status) VALUES (?, ?, ?, ?, ?)").run("nm-removed", NB_ID, USER_ID, "editor", "removed");
  const row = await notebookMembersRepository.getRoleAsync(NB_ID, USER_ID);
  assert.equal(row, undefined);
  clean();
});

test("getRoleAsync returns undefined when not found", async () => {
  clean();
  const row = await notebookMembersRepository.getRoleAsync("no-such-nb", "no-such-user");
  assert.equal(row, undefined);
});

test("updateRoleAsync updates role", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO notebook_members (id, notebookId, userId, role, status) VALUES (?, ?, ?, ?, ?)").run("nm-upd", NB_ID, USER_ID, "viewer", "active");
  await notebookMembersRepository.updateRoleAsync(NB_ID, USER_ID, "editor");
  const row = getDb().prepare("SELECT role FROM notebook_members WHERE notebookId = ? AND userId = ?").get(NB_ID, USER_ID) as any;
  assert.equal(row.role, "editor");
  clean();
});

test("removeAsync soft-deletes member", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO notebook_members (id, notebookId, userId, role, status) VALUES (?, ?, ?, ?, ?)").run("nm-rem", NB_ID, USER_ID, "editor", "active");
  await notebookMembersRepository.removeAsync(NB_ID, USER_ID);
  const row = getDb().prepare("SELECT status FROM notebook_members WHERE notebookId = ? AND userId = ?").get(NB_ID, USER_ID) as any;
  assert.equal(row.status, "removed");
  clean();
});

test("listByNotebookAsync returns active members sorted by role", async () => {
  clean();
  seedBase();
  const user2 = "user-nm2";
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(user2, user2, "hash");
  getDb().prepare("INSERT INTO notebook_members (id, notebookId, userId, role, status) VALUES (?, ?, ?, ?, ?)").run("nm-l1", NB_ID, USER_ID, "owner", "active");
  getDb().prepare("INSERT INTO notebook_members (id, notebookId, userId, role, status) VALUES (?, ?, ?, ?, ?)").run("nm-l2", NB_ID, user2, "viewer", "active");
  const rows = await notebookMembersRepository.listByNotebookAsync(NB_ID);
  assert.ok(rows.length >= 2);
  // owner first (CASE role WHEN 'owner' THEN 0)
  assert.equal(rows[0].role, "owner");
  assert.ok(rows[0].username);
  clean();
});

test("listByNotebookAsync excludes removed members", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO notebook_members (id, notebookId, userId, role, status) VALUES (?, ?, ?, ?, ?)").run("nm-ex", NB_ID, USER_ID, "editor", "removed");
  const rows = await notebookMembersRepository.listByNotebookAsync(NB_ID);
  assert.equal(rows.length, 0);
  clean();
});

test("listByNotebookAsync returns empty for notebook without members", async () => {
  clean();
  const rows = await notebookMembersRepository.listByNotebookAsync("no-such-nb");
  assert.equal(rows.length, 0);
});

test("getByNotebookAndUserAsync returns member with user info", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO notebook_members (id, notebookId, userId, role, status) VALUES (?, ?, ?, ?, ?)").run("nm-gb", NB_ID, USER_ID, "editor", "active");
  const row = await notebookMembersRepository.getByNotebookAndUserAsync(NB_ID, USER_ID);
  assert.ok(row);
  assert.equal(row.role, "editor");
  assert.ok(row.username);
  assert.equal(row.email, "user@test.com");
  clean();
});

test("getByNotebookAndUserAsync returns undefined when not found", async () => {
  clean();
  const row = await notebookMembersRepository.getByNotebookAndUserAsync("no-such-nb", "no-such-user");
  assert.equal(row, undefined);
});
