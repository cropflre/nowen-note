import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { getDb } from "../src/db/schema";
import auth from "../src/routes/auth";

const secret = "test-desktop-secret-for-bootstrap-787";
process.env.ELECTRON_LOCAL_ACCOUNT_SECRET = secret;

function desktop() {
  return getDb().prepare(`
    SELECT id, role, isDisabled, passwordHash, tokenVersion, lockedUntil
    FROM users WHERE username = 'desktop'
  `).get() as {
    id: string;
    role: string;
    isDisabled: number;
    passwordHash: string;
    tokenVersion: number;
    lockedUntil: string | null;
  } | undefined;
}

async function bootstrap(header = secret, allowCreate = false) {
  return auth.request("/desktop/bootstrap-local", {
    method: "POST",
    headers: {
      "X-Nowen-Desktop-Secret": header,
      "X-Nowen-Desktop-Allow-Create": allowCreate ? "1" : "0",
    },
  });
}

test("desktop bootstrap creates only a missing account and never changes an existing password", async () => {
  const db = getDb();
  db.prepare("DELETE FROM users WHERE username = 'desktop'").run();

  assert.equal((await bootstrap("wrong-secret", true)).status, 403);
  assert.equal(desktop(), undefined);

  const oldDataDirectory = await bootstrap();
  assert.equal(oldDataDirectory.status, 409);
  assert.equal((await oldDataDirectory.json() as any).code, "LOCAL_ACCOUNT_NOT_FOUND");
  assert.equal(desktop(), undefined);

  const first = await bootstrap(secret, true);
  assert.equal(first.status, 200);
  assert.equal((await first.json() as any).user.role, "admin");
  const created = desktop()!;
  assert.equal(bcrypt.compareSync(secret, created.passwordHash), true);

  const second = await bootstrap();
  assert.equal(second.status, 200);
  assert.equal(desktop()?.id, created.id);
  assert.equal(desktop()?.passwordHash, created.passwordHash);
  assert.equal(desktop()?.tokenVersion, created.tokenVersion);

  const customPassword = "user-changed-desktop-password-787";
  const customHash = bcrypt.hashSync(customPassword, 10);
  db.prepare("UPDATE users SET passwordHash = ?, tokenVersion = 7 WHERE id = ?")
    .run(customHash, created.id);

  const mismatch = await bootstrap();
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json() as any).code, "LOCAL_ACCOUNT_REQUIRES_MANUAL_LOGIN");
  assert.equal(desktop()?.passwordHash, customHash);
  assert.equal(desktop()?.tokenVersion, 7);

  const manualLogin = await auth.request("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "desktop", password: customPassword }),
  });
  assert.equal(manualLogin.status, 200);

  const forbiddenChange = await auth.request("/change-password", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${(await manualLogin.json() as any).token}`,
    },
    body: JSON.stringify({ currentPassword: customPassword, newPassword: "another-password-787" }),
  });
  assert.equal(forbiddenChange.status, 409);
  assert.equal((await forbiddenChange.json() as any).code, "DESKTOP_ACCOUNT_MANAGED");
  assert.equal(desktop()?.passwordHash, customHash);

  // Recovery is a separate explicit endpoint, not part of startup bootstrap.
  const recovery = await auth.request("/desktop/reset-local", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Nowen-Desktop-Secret": secret,
    },
    body: JSON.stringify({ username: "desktop", password: secret }),
  });
  assert.equal(recovery.status, 200);
  assert.equal(desktop()?.id, created.id);
  assert.equal(bcrypt.compareSync(secret, desktop()!.passwordHash), true);
  assert.equal(desktop()?.tokenVersion, 8);
});

test("desktop bootstrap leaves disabled and locked accounts unchanged", async () => {
  const db = getDb();
  const before = desktop()!;
  db.prepare("UPDATE users SET isDisabled = 1 WHERE id = ?").run(before.id);
  assert.equal((await bootstrap()).status, 403);
  assert.equal(desktop()?.passwordHash, before.passwordHash);

  const lockedUntil = new Date(Date.now() + 60_000).toISOString();
  db.prepare("UPDATE users SET isDisabled = 0, lockedUntil = ? WHERE id = ?")
    .run(lockedUntil, before.id);
  assert.equal((await bootstrap()).status, 423);
  assert.equal(desktop()?.passwordHash, before.passwordHash);
  assert.equal(desktop()?.lockedUntil, lockedUntil);

  db.prepare("UPDATE users SET lockedUntil = NULL, role = 'user' WHERE id = ?")
    .run(before.id);
  assert.equal((await bootstrap()).status, 409);
  assert.equal(desktop()?.role, "user");
  assert.equal(desktop()?.passwordHash, before.passwordHash);
});
