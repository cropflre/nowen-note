/**
 * userSessionsRepository revoke + listActiveByUser async 方法行为测试（B3-B1）
 *
 * 范围：revokeAsync, listActiveByUserAsync
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-us-revoke-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { userSessionsRepository } from "../src/repositories/userSessionsRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-rv-1";
const USER_ID2 = "user-rv-2";
const SESS_1 = "sess-rv-001";
const SESS_2 = "sess-rv-002";
const SESS_3 = "sess-rv-003";
const SESS_4 = "sess-rv-004";
const SESS_5 = "sess-rv-005";

function seedUser(id: string) {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(id, id, "hash");
}

function clean() {
  getDb().prepare("DELETE FROM user_sessions").run();
}

function insertSession(opts: {
  id: string;
  userId: string;
  revokedAt?: string | null;
  revokedReason?: string | null;
  expiresAt?: string | null;
  lastSeenOffset?: string;
}) {
  getDb().prepare(
    `INSERT INTO user_sessions (id, userId, ip, userAgent, deviceLabel, createdAt, lastSeenAt, revokedAt, revokedReason, expiresAt)
     VALUES (?, ?, '127.0.0.1', 'test', ?, datetime('now', ?), datetime('now', ?), ?, ?, ?)`
  ).run(
    opts.id,
    opts.userId,
    null,
    opts.lastSeenOffset || "-0 seconds",
    opts.lastSeenOffset || "-0 seconds",
    opts.revokedAt ?? null,
    opts.revokedReason ?? null,
    opts.expiresAt ?? null,
  );
}

// ============================================================
// revokeAsync
// ============================================================

test("revokeAsync revokes an active session", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  await userSessionsRepository.revokeAsync(SESS_1);
  const row = getDb().prepare("SELECT revokedAt, revokedReason FROM user_sessions WHERE id = ?").get(SESS_1) as any;
  assert.ok(row.revokedAt, "revokedAt should be set");
  assert.equal(row.revokedReason, null);
  clean();
});

test("revokeAsync sets revokedReason when provided", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  await userSessionsRepository.revokeAsync(SESS_1, "user_logout");
  const row = getDb().prepare("SELECT revokedAt, revokedReason FROM user_sessions WHERE id = ?").get(SESS_1) as any;
  assert.ok(row.revokedAt);
  assert.equal(row.revokedReason, "user_logout");
  clean();
});

test("revokeAsync does not re-revoke already revoked session", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID, revokedAt: "2025-01-01T00:00:00Z", revokedReason: "old_reason" });
  await userSessionsRepository.revokeAsync(SESS_1, "new_reason");
  const row = getDb().prepare("SELECT revokedAt, revokedReason FROM user_sessions WHERE id = ?").get(SESS_1) as any;
  assert.equal(row.revokedAt, "2025-01-01T00:00:00Z", "revokedAt should not change");
  assert.equal(row.revokedReason, "old_reason", "revokedReason should not change");
  clean();
});

test("revokeAsync no-op for non-existent session", async () => {
  clean();
  // should not throw
  await userSessionsRepository.revokeAsync("no-such-session");
});

test("revokeAsync does not affect other sessions", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  insertSession({ id: SESS_2, userId: USER_ID });
  await userSessionsRepository.revokeAsync(SESS_1);
  const row = getDb().prepare("SELECT revokedAt FROM user_sessions WHERE id = ?").get(SESS_2) as any;
  assert.equal(row.revokedAt, null, "other session should not be revoked");
  clean();
});

// ============================================================
// listActiveByUserAsync
// ============================================================

test("listActiveByUserAsync returns active sessions", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  insertSession({ id: SESS_2, userId: USER_ID });
  const rows = await userSessionsRepository.listActiveByUserAsync(USER_ID);
  assert.equal(rows.length, 2);
  clean();
});

test("listActiveByUserAsync excludes revoked sessions", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  insertSession({ id: SESS_2, userId: USER_ID, revokedAt: "2025-01-01T00:00:00Z" });
  const rows = await userSessionsRepository.listActiveByUserAsync(USER_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, SESS_1);
  clean();
});

test("listActiveByUserAsync excludes expired sessions", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  insertSession({ id: SESS_2, userId: USER_ID, expiresAt: "2000-01-01T00:00:00Z" });
  const rows = await userSessionsRepository.listActiveByUserAsync(USER_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, SESS_1);
  clean();
});

test("listActiveByUserAsync includes sessions with null expiresAt", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID, expiresAt: null });
  const rows = await userSessionsRepository.listActiveByUserAsync(USER_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, SESS_1);
  clean();
});

test("listActiveByUserAsync includes sessions with future expiresAt", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID, expiresAt: "2099-12-31T23:59:59Z" });
  const rows = await userSessionsRepository.listActiveByUserAsync(USER_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, SESS_1);
  clean();
});

test("listActiveByUserAsync does not return other user sessions", async () => {
  clean();
  seedUser(USER_ID);
  seedUser(USER_ID2);
  insertSession({ id: SESS_1, userId: USER_ID });
  insertSession({ id: SESS_2, userId: USER_ID2 });
  const rows = await userSessionsRepository.listActiveByUserAsync(USER_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, SESS_1);
  clean();
});

test("listActiveByUserAsync sorts by lastSeenAt DESC", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID, lastSeenOffset: "-2 hours" });
  insertSession({ id: SESS_2, userId: USER_ID, lastSeenOffset: "-0 seconds" });
  insertSession({ id: SESS_3, userId: USER_ID, lastSeenOffset: "-1 hour" });
  const rows = await userSessionsRepository.listActiveByUserAsync(USER_ID);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, SESS_2, "most recent first");
  assert.equal(rows[1].id, SESS_3);
  assert.equal(rows[2].id, SESS_1, "oldest last");
  clean();
});

test("listActiveByUserAsync returns empty array for user with no sessions", async () => {
  clean();
  const rows = await userSessionsRepository.listActiveByUserAsync("no-such-user");
  assert.equal(rows.length, 0);
});

test("listActiveByUserAsync returns correct fields", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  const rows = await userSessionsRepository.listActiveByUserAsync(USER_ID);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, SESS_1);
  assert.ok(row.createdAt);
  assert.ok(row.lastSeenAt);
  assert.ok(row.ip !== undefined);
  assert.ok(row.userAgent !== undefined);
  // deviceLabel may be null
  clean();
});

test("listActiveByUserAsync returns empty when all sessions revoked or expired", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID, revokedAt: "2025-01-01T00:00:00Z" });
  insertSession({ id: SESS_2, userId: USER_ID, expiresAt: "2000-01-01T00:00:00Z" });
  const rows = await userSessionsRepository.listActiveByUserAsync(USER_ID);
  assert.equal(rows.length, 0);
  clean();
});
