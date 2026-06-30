/**
 * workspaceMembersRepository async 方法行为测试
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ws-mem-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { workspaceMembersRepository } from "../src/repositories/workspaceMembersRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-wm";
const USER_ID2 = "user-wm2";
const WS_ID = "ws-wm";
const WS_ID2 = "ws-wm2";

function seedBase() {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash, email) VALUES (?, ?, ?, ?)").run(USER_ID, USER_ID, "hash", "user@test.com");
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash, email) VALUES (?, ?, ?, ?)").run(USER_ID2, USER_ID2, "hash", "user2@test.com");
  getDb().prepare("INSERT OR IGNORE INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)").run(WS_ID, "Test WS", USER_ID);
  getDb().prepare("INSERT OR IGNORE INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)").run(WS_ID2, "Test WS 2", USER_ID);
}

function clean() {
  getDb().prepare("DELETE FROM workspace_members").run();
}

// --- createAsync ---

test("createAsync inserts member", async () => {
  clean();
  seedBase();
  await workspaceMembersRepository.createAsync(WS_ID, USER_ID, "owner");
  const row = getDb().prepare("SELECT * FROM workspace_members WHERE workspaceId = ? AND userId = ?").get(WS_ID, USER_ID) as any;
  assert.ok(row);
  assert.equal(row.role, "owner");
  clean();
});

// --- getRoleAsync ---

test("getRoleAsync returns role", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "admin");
  const row = await workspaceMembersRepository.getRoleAsync(WS_ID, USER_ID);
  assert.ok(row);
  assert.equal(row.role, "admin");
  clean();
});

test("getRoleAsync returns undefined when not found", async () => {
  clean();
  const row = await workspaceMembersRepository.getRoleAsync("no-such-ws", "no-such-user");
  assert.equal(row, undefined);
});

test("getRoleAsync returns undefined for wrong workspace", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "editor");
  const row = await workspaceMembersRepository.getRoleAsync(WS_ID2, USER_ID);
  assert.equal(row, undefined);
  clean();
});

test("getRoleAsync returns undefined for wrong user", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "editor");
  const row = await workspaceMembersRepository.getRoleAsync(WS_ID, "no-such-user");
  assert.equal(row, undefined);
  clean();
});

// --- updateRoleAsync ---

test("updateRoleAsync updates role", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "viewer");
  await workspaceMembersRepository.updateRoleAsync(WS_ID, USER_ID, "editor");
  const row = getDb().prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?").get(WS_ID, USER_ID) as any;
  assert.equal(row.role, "editor");
  clean();
});

// --- deleteAsync ---

test("deleteAsync removes member", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "editor");
  await workspaceMembersRepository.deleteAsync(WS_ID, USER_ID);
  const row = getDb().prepare("SELECT * FROM workspace_members WHERE workspaceId = ? AND userId = ?").get(WS_ID, USER_ID);
  assert.equal(row, undefined);
  clean();
});

test("deleteAsync no-op when not found", async () => {
  clean();
  await workspaceMembersRepository.deleteAsync("no-such-ws", "no-such-user");
});

// --- countByWorkspaceAsync ---

test("countByWorkspaceAsync returns count", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "owner");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID2, "editor");
  const count = await workspaceMembersRepository.countByWorkspaceAsync(WS_ID);
  assert.equal(count, 2);
  clean();
});

test("countByWorkspaceAsync returns 0 for empty workspace", async () => {
  clean();
  const count = await workspaceMembersRepository.countByWorkspaceAsync("no-such-ws");
  assert.equal(count, 0);
});

// --- countByUserAsync ---

test("countByUserAsync returns count", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "owner");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID2, USER_ID, "owner");
  const count = await workspaceMembersRepository.countByUserAsync(USER_ID);
  assert.equal(count, 2);
  clean();
});

test("countByUserAsync returns 0 for user with no workspaces", async () => {
  clean();
  const count = await workspaceMembersRepository.countByUserAsync("no-such-user");
  assert.equal(count, 0);
});

// --- listWorkspaceIdsByUserAsync ---

test("listWorkspaceIdsByUserAsync returns workspace IDs", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "owner");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID2, USER_ID, "owner");
  const ids = await workspaceMembersRepository.listWorkspaceIdsByUserAsync(USER_ID);
  assert.equal(ids.length, 2);
  assert.ok(ids.includes(WS_ID));
  assert.ok(ids.includes(WS_ID2));
  clean();
});

test("listWorkspaceIdsByUserAsync returns empty for user with no workspaces", async () => {
  clean();
  const ids = await workspaceMembersRepository.listWorkspaceIdsByUserAsync("no-such-user");
  assert.equal(ids.length, 0);
});

// --- transferOwnershipAsync ---

test("transferOwnershipAsync transfers members", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "owner");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID2, USER_ID, "owner");
  const changes = await workspaceMembersRepository.transferOwnershipAsync(USER_ID, USER_ID2);
  assert.equal(changes, 2);
  const rows = getDb().prepare("SELECT * FROM workspace_members WHERE userId = ?").all(USER_ID2) as any[];
  assert.equal(rows.length, 2);
  const oldRows = getDb().prepare("SELECT * FROM workspace_members WHERE userId = ?").all(USER_ID) as any[];
  assert.equal(oldRows.length, 0);
  clean();
});

test("transferOwnershipAsync returns 0 when no members to transfer", async () => {
  clean();
  const changes = await workspaceMembersRepository.transferOwnershipAsync("no-such-user", USER_ID2);
  assert.equal(changes, 0);
});

// --- listCommonWorkspacesAsync ---

test("listCommonWorkspacesAsync returns common workspaces", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "owner");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID2, "editor");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID2, USER_ID, "owner");
  const ids = await workspaceMembersRepository.listCommonWorkspacesAsync(USER_ID, USER_ID2);
  assert.equal(ids.length, 1);
  assert.ok(ids.includes(WS_ID));
  clean();
});

test("listCommonWorkspacesAsync returns empty when no common workspaces", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "owner");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID2, USER_ID2, "owner");
  const ids = await workspaceMembersRepository.listCommonWorkspacesAsync(USER_ID, USER_ID2);
  assert.equal(ids.length, 0);
  clean();
});

// --- listByWorkspaceWithUserAsync ---

test("listByWorkspaceWithUserAsync returns members sorted by role", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "owner");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID2, "viewer");
  const rows = await workspaceMembersRepository.listByWorkspaceWithUserAsync(WS_ID);
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].role, "owner");
  assert.ok(rows[0].username);
  assert.ok(rows[0].joinedAt);
  clean();
});

test("listByWorkspaceWithUserAsync returns empty for workspace without members", async () => {
  clean();
  const rows = await workspaceMembersRepository.listByWorkspaceWithUserAsync("no-such-ws");
  assert.equal(rows.length, 0);
});

test("listByWorkspaceWithUserAsync returns user fields from JOIN", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "admin");
  const rows = await workspaceMembersRepository.listByWorkspaceWithUserAsync(WS_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].username, USER_ID);
  assert.ok(rows[0].joinedAt);
  clean();
});

test("listByWorkspaceWithUserAsync sorts roles: owner > admin > editor > commenter > viewer", async () => {
  clean();
  seedBase();
  const user3 = "user-wm3";
  const user4 = "user-wm4";
  const user5 = "user-wm5";
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(user3, user3, "hash");
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(user4, user4, "hash");
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(user5, user5, "hash");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, user5, "viewer");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID, "owner");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, user3, "editor");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, user4, "commenter");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS_ID, USER_ID2, "admin");
  const rows = await workspaceMembersRepository.listByWorkspaceWithUserAsync(WS_ID);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].role, "owner");
  assert.equal(rows[1].role, "admin");
  assert.equal(rows[2].role, "editor");
  assert.equal(rows[3].role, "commenter");
  assert.equal(rows[4].role, "viewer");
  clean();
});
