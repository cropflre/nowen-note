import assert from "node:assert/strict";
import test from "node:test";

import { getDb } from "../src/db/schema";
import { signLoginToken } from "../src/lib/auth-security";
import { userSessionsRepository } from "../src/repositories/userSessionsRepository";
import auth from "../src/routes/auth";

const USER_ID = "verify-session-user";
const SESSION_ID = "verify-session-revoked";

test("auth verify rejects a revoked device session", async () => {
  const db = getDb();
  db.prepare("DELETE FROM user_sessions WHERE userId = ?").run(USER_ID);
  db.prepare("DELETE FROM users WHERE id = ?").run(USER_ID);
  db.prepare(`
    INSERT INTO users (id, username, passwordHash, role, tokenVersion)
    VALUES (?, ?, ?, 'user', 0)
  `).run(USER_ID, "verify-session-user", "test-hash");
  userSessionsRepository.create({
    id: SESSION_ID,
    userId: USER_ID,
    ip: "127.0.0.1",
    userAgent: "test",
  });
  const token = signLoginToken({
    userId: USER_ID,
    username: "verify-session-user",
    tokenVersion: 0,
    jti: SESSION_ID,
  });

  const active = await auth.request("/verify", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(active.status, 200);

  userSessionsRepository.revoke(SESSION_ID, "test");
  const revoked = await auth.request("/verify", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).code, "TOKEN_INVALID");
});
