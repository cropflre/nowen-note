import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { getDb } from "../src/db/schema";
import auth from "../src/routes/auth";
import users from "../src/routes/users";

function addUser(username: string, password: string, role: "admin" | "user") {
  const id = uuid();
  getDb().prepare(`
    INSERT INTO users (id, username, passwordHash, role, tokenVersion, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(id, username, bcrypt.hashSync(password, 10), role);
  return id;
}

function account(id: string) {
  return getDb().prepare(`
    SELECT passwordHash, tokenVersion, failedLoginAttempts, lockedUntil FROM users WHERE id = ?
  `).get(id) as { passwordHash: string; tokenVersion: number; failedLoginAttempts: number; lockedUntil: string | null };
}

function resetPassword(actorId: string, targetId: string, newPassword: string) {
  return users.request(`/${targetId}/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": actorId },
    body: JSON.stringify({ newPassword }),
  });
}

function postAuth(path: string, body: unknown, headers: Record<string, string> = {}) {
  return auth.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function loginToken(username: string, password: string, headers: Record<string, string> = {}) {
  const response = await postAuth("/login", { username, password }, headers);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { token: string }).token;
}

test("admin resets another user's password without second verification and signs that user out", async () => {
  const adminId = addUser("reset_admin", "admin-pass-reset", "admin");
  const memberId = addUser("reset_member", "member-old-pass", "user");
  getDb().prepare("UPDATE users SET failedLoginAttempts = 5, lockedUntil = ? WHERE id = ?")
    .run(new Date(Date.now() + 60_000).toISOString(), memberId);

  const response = await resetPassword(adminId, memberId, "member-new-pass");

  assert.equal(response.status, 200, await response.clone().text());
  const member = account(memberId);
  assert.equal(bcrypt.compareSync("member-new-pass", member.passwordHash), true);
  assert.equal(member.tokenVersion, 1);
  assert.equal(member.failedLoginAttempts, 0);
  assert.equal(member.lockedUntil, null);
});

test("user management cannot reset the signed-in admin's own password", async () => {
  const adminId = addUser("reset_self_admin", "admin-pass-reset", "admin");
  const before = account(adminId);

  const response = await resetPassword(adminId, adminId, "admin-new-pass");

  assert.equal(response.status, 400);
  assert.deepEqual(account(adminId), before);
});

test("non-admin users still cannot reset passwords", async () => {
  const adminId = addUser("reset_target_admin", "admin-pass-reset", "admin");
  const memberId = addUser("reset_actor_member", "member-pass-reset", "user");
  const before = account(adminId);

  const response = await resetPassword(memberId, adminId, "taken-over-pass");

  assert.equal(response.status, 403);
  assert.deepEqual(account(adminId), before);
});

test("other accounts' failed logins do not block the admin's second verification", async () => {
  addUser("sudo_admin", "admin-pass-sudo", "admin");
  addUser("sudo_member", "member-new-pass", "user");
  // 默认 docker-compose 直连端口，没有代理头：所有客户端落在同一个匿名 IP 计数里。
  const token = await loginToken("sudo_admin", "admin-pass-sudo");
  for (let attempt = 0; attempt < 12; attempt++) {
    await postAuth("/login", { username: "sudo_member", password: "member-old-pass" });
  }

  const response = await postAuth("/sudo", { password: "admin-pass-sudo" }, { Authorization: `Bearer ${token}` });

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(typeof (await response.json() as { sudoToken?: unknown }).sudoToken, "string");
});

test("second verification stays rate limited, but only for the user guessing the password", async () => {
  addUser("sudo_guess_admin", "admin-pass-guess", "admin");
  addUser("sudo_other_admin", "admin-pass-other", "admin");
  const network = { "X-Forwarded-For": "198.51.100.23" };
  const guessing = await loginToken("sudo_guess_admin", "admin-pass-guess", network);
  const other = await loginToken("sudo_other_admin", "admin-pass-other", network);

  for (let attempt = 0; attempt < 10; attempt++) {
    const wrong = await postAuth("/sudo", { password: `wrong-${attempt}` }, { ...network, Authorization: `Bearer ${guessing}` });
    assert.equal(wrong.status, 403);
  }
  const blocked = await postAuth("/sudo", { password: "admin-pass-guess" }, { ...network, Authorization: `Bearer ${guessing}` });
  assert.equal(blocked.status, 429);

  const allowed = await postAuth("/sudo", { password: "admin-pass-other" }, { ...network, Authorization: `Bearer ${other}` });
  assert.equal(allowed.status, 200, await allowed.clone().text());
});
