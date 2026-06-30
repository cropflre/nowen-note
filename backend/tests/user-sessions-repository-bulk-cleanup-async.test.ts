/**
 * userSessionsRepository 批量吊销 + 过期清理 async 方法行为测试（B3-B2）
 *
 * 范围：revokeAllOtherAsync, revokeAllAsync, cleanupExpiredAsync
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-us-bulk-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { userSessionsRepository } from "../src/repositories/userSessionsRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-bulk-1";
const USER_ID2 = "user-bulk-2";
const SESS_1 = "sess-bulk-001";
const SESS_2 = "sess-bulk-002";
const SESS_3 = "sess-bulk-003";
const SESS_4 = "sess-bulk-004";

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
}) {
  getDb().prepare(
    `INSERT INTO user_sessions (id, userId, ip, userAgent, createdAt, lastSeenAt, revokedAt, revokedReason, expiresAt)
     VALUES (?, ?, '127.0.0.1', 'test', datetime('now'), datetime('now'), ?, ?, ?)`
  ).run(
    opts.id,
    opts.userId,
    opts.revokedAt ?? null,
    opts.revokedReason ?? null,
    opts.expiresAt ?? null,
  );
}

// ============================================================
// revokeAllOtherAsync
// ============================================================

test("revokeAllOtherAsync revokes other sessions for same user", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  insertSession({ id: SESS_2, userId: USER_ID });
  insertSession({ id: SESS_3, userId: USER_ID });
  const changes = await userSessionsRepository.revokeAllOtherAsync(USER_ID, SESS_1);
  assert.equal(changes, 2);
  // SESS_1 should not be revoked
  const s1 = getDb().prepare("SELECT revokedAt FROM user_sessions WHERE id = ?").get(SESS_1) as any;
  assert.equal(s1.revokedAt, null);
  // SESS_2 and SESS_3 should be revoked
  const s2 = getDb().prepare("SELECT revokedAt, revokedReason FROM user_sessions WHERE id = ?").get(SESS_2) as any;
  assert.ok(s2.revokedAt);
  assert.equal(s2.revokedReason, "user_bulk_revoked");
  const s3 = getDb().prepare("SELECT revokedAt FROM user_sessions WHERE id = ?").get(SESS_3) as any;
  assert.ok(s3.revokedAt);
  clean();
});

test("revokeAllOtherAsync does not revoke other user sessions", async () => {
  clean();
  seedUser(USER_ID);
  seedUser(USER_ID2);
  insertSession({ id: SESS_1, userId: USER_ID });
  insertSession({ id: SESS_2, userId: USER_ID2 });
  const changes = await userSessionsRepository.revokeAllOtherAsync(USER_ID, SESS_1);
  assert.equal(changes, 0);
  const s2 = getDb().prepare("SELECT revokedAt FROM user_sessions WHERE id = ?").get(SESS_2) as any;
  assert.equal(s2.revokedAt, null);
  clean();
});

test("revokeAllOtherAsync does not re-revoke already revoked sessions", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  insertSession({ id: SESS_2, userId: USER_ID, revokedAt: "2025-01-01T00:00:00Z", revokedReason: "old" });
  const changes = await userSessionsRepository.revokeAllOtherAsync(USER_ID, SESS_1);
  assert.equal(changes, 0, "already revoked sessions should not be counted");
  const s2 = getDb().prepare("SELECT revokedReason FROM user_sessions WHERE id = ?").get(SESS_2) as any;
  assert.equal(s2.revokedReason, "old", "should not change existing revokedReason");
  clean();
});

test("revokeAllOtherAsync returns 0 when no other sessions", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  const changes = await userSessionsRepository.revokeAllOtherAsync(USER_ID, SESS_1);
  assert.equal(changes, 0);
  clean();
});

test("revokeAllOtherAsync returns 0 for user with no sessions", async () => {
  clean();
  const changes = await userSessionsRepository.revokeAllOtherAsync("no-such-user", SESS_1);
  assert.equal(changes, 0);
});

// ============================================================
// revokeAllAsync
// ============================================================

test("revokeAllAsync revokes all active sessions for user", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  insertSession({ id: SESS_2, userId: USER_ID });
  insertSession({ id: SESS_3, userId: USER_ID });
  const changes = await userSessionsRepository.revokeAllAsync(USER_ID);
  assert.equal(changes, 3);
  const rows = getDb().prepare("SELECT revokedAt, revokedReason FROM user_sessions WHERE userId = ?").all(USER_ID) as any[];
  for (const row of rows) {
    assert.ok(row.revokedAt);
    assert.equal(row.revokedReason, "user_bulk_revoked");
  }
  clean();
});

test("revokeAllAsync does not revoke other user sessions", async () => {
  clean();
  seedUser(USER_ID);
  seedUser(USER_ID2);
  insertSession({ id: SESS_1, userId: USER_ID });
  insertSession({ id: SESS_2, userId: USER_ID2 });
  const changes = await userSessionsRepository.revokeAllAsync(USER_ID);
  assert.equal(changes, 1);
  const s2 = getDb().prepare("SELECT revokedAt FROM user_sessions WHERE id = ?").get(SESS_2) as any;
  assert.equal(s2.revokedAt, null);
  clean();
});

test("revokeAllAsync does not re-revoke already revoked sessions", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  insertSession({ id: SESS_2, userId: USER_ID, revokedAt: "2025-01-01T00:00:00Z", revokedReason: "old" });
  const changes = await userSessionsRepository.revokeAllAsync(USER_ID);
  assert.equal(changes, 1, "only the active session should be counted");
  clean();
});

test("revokeAllAsync returns 0 when no active sessions", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID, revokedAt: "2025-01-01T00:00:00Z" });
  const changes = await userSessionsRepository.revokeAllAsync(USER_ID);
  assert.equal(changes, 0);
  clean();
});

test("revokeAllAsync returns 0 for user with no sessions", async () => {
  clean();
  const changes = await userSessionsRepository.revokeAllAsync("no-such-user");
  assert.equal(changes, 0);
});

// ============================================================
// cleanupExpiredAsync
// ============================================================

test("cleanupExpiredAsync deletes expired sessions", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID, expiresAt: "2000-01-01T00:00:00Z" });
  insertSession({ id: SESS_2, userId: USER_ID });
  const changes = await userSessionsRepository.cleanupExpiredAsync(USER_ID);
  assert.equal(changes, 1);
  const remaining = getDb().prepare("SELECT id FROM user_sessions WHERE userId = ?").all(USER_ID) as any[];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, SESS_2);
  clean();
});

test("cleanupExpiredAsync deletes revoked sessions", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID, revokedAt: "2025-01-01T00:00:00Z" });
  insertSession({ id: SESS_2, userId: USER_ID });
  const changes = await userSessionsRepository.cleanupExpiredAsync(USER_ID);
  assert.equal(changes, 1);
  const remaining = getDb().prepare("SELECT id FROM user_sessions WHERE userId = ?").all(USER_ID) as any[];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, SESS_2);
  clean();
});

test("cleanupExpiredAsync does not delete active sessions with null expiresAt", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID, expiresAt: null });
  const changes = await userSessionsRepository.cleanupExpiredAsync(USER_ID);
  assert.equal(changes, 0);
  clean();
});

test("cleanupExpiredAsync does not delete active sessions with future expiresAt", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID, expiresAt: "2099-12-31T23:59:59Z" });
  const changes = await userSessionsRepository.cleanupExpiredAsync(USER_ID);
  assert.equal(changes, 0);
  clean();
});

test("cleanupExpiredAsync does not affect other user sessions", async () => {
  clean();
  seedUser(USER_ID);
  seedUser(USER_ID2);
  insertSession({ id: SESS_1, userId: USER_ID, expiresAt: "2000-01-01T00:00:00Z" });
  insertSession({ id: SESS_2, userId: USER_ID2, expiresAt: "2000-01-01T00:00:00Z" });
  const changes = await userSessionsRepository.cleanupExpiredAsync(USER_ID);
  assert.equal(changes, 1);
  const s2 = getDb().prepare("SELECT id FROM user_sessions WHERE id = ?").get(SESS_2);
  assert.ok(s2, "other user session should not be deleted");
  clean();
});

test("cleanupExpiredAsync returns 0 when nothing to clean", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID });
  const changes = await userSessionsRepository.cleanupExpiredAsync(USER_ID);
  assert.equal(changes, 0);
  clean();
});

test("cleanupExpiredAsync returns 0 for user with no sessions", async () => {
  clean();
  const changes = await userSessionsRepository.cleanupExpiredAsync("no-such-user");
  assert.equal(changes, 0);
});

test("cleanupExpiredAsync handles mixed expired, revoked, and active sessions", async () => {
  clean();
  seedUser(USER_ID);
  insertSession({ id: SESS_1, userId: USER_ID }); // active
  insertSession({ id: SESS_2, userId: USER_ID, revokedAt: "2025-01-01T00:00:00Z" }); // revoked
  insertSession({ id: SESS_3, userId: USER_ID, expiresAt: "2000-01-01T00:00:00Z" }); // expired
  insertSession({ id: SESS_4, userId: USER_ID, expiresAt: "2099-12-31T23:59:59Z" }); // active future
  const changes = await userSessionsRepository.cleanupExpiredAsync(USER_ID);
  assert.equal(changes, 2, "should delete revoked + expired");
  const remaining = getDb().prepare("SELECT id FROM user_sessions WHERE userId = ? ORDER BY id").all(USER_ID) as any[];
  assert.equal(remaining.length, 2);
  assert.equal(remaining[0].id, SESS_1);
  assert.equal(remaining[1].id, SESS_4);
  clean();
});
