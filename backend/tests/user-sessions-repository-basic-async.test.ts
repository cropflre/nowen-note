/**
 * userSessionsRepository 基础 async 方法行为测试（B3-A）
 *
 * 范围：createAsync, findByDeviceAsync, updateLastSeenAsync,
 *       getByIdAndUserAsync, getByIdAsync
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-us-sess-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { userSessionsRepository } from "../src/repositories/userSessionsRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-sess-1";
const USER_ID2 = "user-sess-2";
const SESSION_ID = "sess-001";
const SESSION_ID2 = "sess-002";
const SESSION_ID3 = "sess-003";

function seedUser(id: string) {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(id, id, "hash");
}

function clean() {
  getDb().prepare("DELETE FROM user_sessions").run();
}

// --- createAsync ---

test("createAsync inserts session and returns id", async () => {
  clean();
  seedUser(USER_ID);
  const id = await userSessionsRepository.createAsync({
    id: SESSION_ID,
    userId: USER_ID,
    ip: "127.0.0.1",
    userAgent: "test-agent",
  });
  assert.equal(id, SESSION_ID);
  const row = getDb().prepare("SELECT * FROM user_sessions WHERE id = ?").get(SESSION_ID) as any;
  assert.ok(row);
  assert.equal(row.userId, USER_ID);
  assert.equal(row.ip, "127.0.0.1");
  assert.equal(row.userAgent, "test-agent");
  clean();
});

test("createAsync with deviceLabel and expiresAt", async () => {
  clean();
  seedUser(USER_ID);
  const id = await userSessionsRepository.createAsync({
    id: SESSION_ID,
    userId: USER_ID,
    ip: "10.0.0.1",
    userAgent: "mobile",
    deviceLabel: "iPhone",
    expiresAt: "2099-12-31T23:59:59Z",
  });
  assert.equal(id, SESSION_ID);
  const row = getDb().prepare("SELECT * FROM user_sessions WHERE id = ?").get(SESSION_ID) as any;
  assert.equal(row.deviceLabel, "iPhone");
  assert.equal(row.expiresAt, "2099-12-31T23:59:59Z");
  clean();
});

test("createAsync with empty ip and userAgent defaults to empty string", async () => {
  clean();
  seedUser(USER_ID);
  await userSessionsRepository.createAsync({
    id: SESSION_ID,
    userId: USER_ID,
    ip: "",
    userAgent: "",
  });
  const row = getDb().prepare("SELECT ip, userAgent FROM user_sessions WHERE id = ?").get(SESSION_ID) as any;
  assert.equal(row.ip, "");
  assert.equal(row.userAgent, "");
  clean();
});

// --- getByIdAsync ---

test("getByIdAsync returns session", async () => {
  clean();
  seedUser(USER_ID);
  getDb().prepare(
    "INSERT INTO user_sessions (id, userId, ip, userAgent, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
  ).run(SESSION_ID, USER_ID, "127.0.0.1", "test");
  const row = await userSessionsRepository.getByIdAsync(SESSION_ID);
  assert.ok(row);
  assert.equal(row.id, SESSION_ID);
  assert.equal(row.userId, USER_ID);
  assert.equal(row.revokedAt, null);
  clean();
});

test("getByIdAsync returns undefined for non-existent session", async () => {
  clean();
  const row = await userSessionsRepository.getByIdAsync("no-such-session");
  assert.equal(row, undefined);
});

// --- getByIdAndUserAsync ---

test("getByIdAndUserAsync returns session for correct user", async () => {
  clean();
  seedUser(USER_ID);
  getDb().prepare(
    "INSERT INTO user_sessions (id, userId, ip, userAgent, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
  ).run(SESSION_ID, USER_ID, "127.0.0.1", "test");
  const row = await userSessionsRepository.getByIdAndUserAsync(SESSION_ID, USER_ID);
  assert.ok(row);
  assert.equal(row.id, SESSION_ID);
  assert.equal(row.revokedAt, null);
  clean();
});

test("getByIdAndUserAsync returns undefined for wrong user", async () => {
  clean();
  seedUser(USER_ID);
  seedUser(USER_ID2);
  getDb().prepare(
    "INSERT INTO user_sessions (id, userId, ip, userAgent, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
  ).run(SESSION_ID, USER_ID, "127.0.0.1", "test");
  const row = await userSessionsRepository.getByIdAndUserAsync(SESSION_ID, USER_ID2);
  assert.equal(row, undefined);
  clean();
});

test("getByIdAndUserAsync returns undefined for non-existent session", async () => {
  clean();
  const row = await userSessionsRepository.getByIdAndUserAsync("no-such", USER_ID);
  assert.equal(row, undefined);
});

// --- findByDeviceAsync ---

test("findByDeviceAsync returns active session for device", async () => {
  clean();
  seedUser(USER_ID);
  getDb().prepare(
    `INSERT INTO user_sessions (id, userId, ip, userAgent, deviceLabel, createdAt, lastSeenAt)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(SESSION_ID, USER_ID, "127.0.0.1", "test", "laptop");
  const row = await userSessionsRepository.findByDeviceAsync(USER_ID, "laptop");
  assert.ok(row);
  assert.equal(row.id, SESSION_ID);
  clean();
});

test("findByDeviceAsync returns undefined when no matching device", async () => {
  clean();
  seedUser(USER_ID);
  const row = await userSessionsRepository.findByDeviceAsync(USER_ID, "no-such-device");
  assert.equal(row, undefined);
});

test("findByDeviceAsync skips revoked sessions", async () => {
  clean();
  seedUser(USER_ID);
  getDb().prepare(
    `INSERT INTO user_sessions (id, userId, ip, userAgent, deviceLabel, revokedAt, createdAt, lastSeenAt)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`
  ).run(SESSION_ID, USER_ID, "127.0.0.1", "test", "laptop");
  const row = await userSessionsRepository.findByDeviceAsync(USER_ID, "laptop");
  assert.equal(row, undefined);
  clean();
});

test("findByDeviceAsync skips expired sessions", async () => {
  clean();
  seedUser(USER_ID);
  getDb().prepare(
    `INSERT INTO user_sessions (id, userId, ip, userAgent, deviceLabel, expiresAt, createdAt, lastSeenAt)
     VALUES (?, ?, ?, ?, ?, '2000-01-01T00:00:00Z', datetime('now'), datetime('now'))`
  ).run(SESSION_ID, USER_ID, "127.0.0.1", "test", "laptop");
  const row = await userSessionsRepository.findByDeviceAsync(USER_ID, "laptop");
  assert.equal(row, undefined);
  clean();
});

test("findByDeviceAsync returns most recent session when multiple exist", async () => {
  clean();
  seedUser(USER_ID);
  getDb().prepare(
    `INSERT INTO user_sessions (id, userId, ip, userAgent, deviceLabel, createdAt, lastSeenAt)
     VALUES (?, ?, ?, ?, ?, datetime('now', '-1 hour'), datetime('now', '-1 hour'))`
  ).run(SESSION_ID, USER_ID, "127.0.0.1", "test", "laptop");
  getDb().prepare(
    `INSERT INTO user_sessions (id, userId, ip, userAgent, deviceLabel, createdAt, lastSeenAt)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(SESSION_ID2, USER_ID, "127.0.0.1", "test", "laptop");
  const row = await userSessionsRepository.findByDeviceAsync(USER_ID, "laptop");
  assert.ok(row);
  assert.equal(row.id, SESSION_ID2);
  clean();
});

// --- updateLastSeenAsync ---

test("updateLastSeenAsync updates lastSeenAt only", async () => {
  clean();
  seedUser(USER_ID);
  getDb().prepare(
    "INSERT INTO user_sessions (id, userId, ip, userAgent, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, datetime('now', '-1 hour'), datetime('now', '-1 hour'))"
  ).run(SESSION_ID, USER_ID, "old-ip", "test");
  await userSessionsRepository.updateLastSeenAsync(SESSION_ID);
  const row = getDb().prepare("SELECT lastSeenAt FROM user_sessions WHERE id = ?").get(SESSION_ID) as any;
  assert.ok(row.lastSeenAt);
  clean();
});

test("updateLastSeenAsync updates ip and expiresAt when provided", async () => {
  clean();
  seedUser(USER_ID);
  getDb().prepare(
    "INSERT INTO user_sessions (id, userId, ip, userAgent, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
  ).run(SESSION_ID, USER_ID, "old-ip", "test");
  await userSessionsRepository.updateLastSeenAsync(SESSION_ID, "new-ip", "2099-01-01T00:00:00Z");
  const row = getDb().prepare("SELECT ip, expiresAt FROM user_sessions WHERE id = ?").get(SESSION_ID) as any;
  assert.equal(row.ip, "new-ip");
  assert.equal(row.expiresAt, "2099-01-01T00:00:00Z");
  clean();
});

test("updateLastSeenAsync no-op for non-existent session", async () => {
  clean();
  // should not throw
  await userSessionsRepository.updateLastSeenAsync("no-such-session");
});
