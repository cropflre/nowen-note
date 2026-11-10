import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { closeDb, getDb } from "../src/db/schema";
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

  // An upgraded portable database must keep its identity and notes after a backend restart.
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run("issue-787-notebook", created.id, "旧版笔记本");
  db.prepare("INSERT INTO notes (id, userId, notebookId, title, contentText) VALUES (?, ?, ?, ?, ?)")
    .run("issue-787-note", created.id, "issue-787-notebook", "旧版笔记", "keep this note");
  closeDb();
  assert.equal(desktop()?.id, created.id);

  const mismatch = await bootstrap();
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json() as any).code, "LOCAL_ACCOUNT_REQUIRES_MANUAL_LOGIN");
  assert.equal(desktop()?.passwordHash, customHash);
  assert.equal(desktop()?.tokenVersion, 7);
  assert.deepEqual(
    getDb().prepare("SELECT userId, title, contentText FROM notes WHERE id = ?").get("issue-787-note"),
    { userId: created.id, title: "旧版笔记", contentText: "keep this note" },
  );

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
  assert.equal(
    (getDb().prepare("SELECT contentText FROM notes WHERE id = ?").get("issue-787-note") as { contentText: string }).contentText,
    "keep this note",
  );
  closeDb();
  assert.equal((await bootstrap()).status, 200);
  assert.equal(desktop()?.id, created.id);
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

test("desktop recovery re-enables, unlocks and re-promotes the managed account without touching notes", async () => {
  const db = getDb();
  const id = desktop()!.id;
  const recover = () => auth.request("/desktop/reset-local", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Nowen-Desktop-Secret": secret },
    body: JSON.stringify({ username: "desktop", password: secret }),
  });
  const normalize = () => db.prepare(`
    UPDATE users SET role = 'admin', isDisabled = 0, mustChangePassword = 0,
      failedLoginAttempts = 0, lastFailedLoginAt = NULL, lockedUntil = NULL WHERE id = ?
  `).run(id);
  const row = () => db.prepare("SELECT role, isDisabled, failedLoginAttempts, lockedUntil FROM users WHERE id = ?").get(id) as
    { role: string; isDisabled: number; failedLoginAttempts: number; lockedUntil: string | null };
  const expectRecovered = async (label: string) => {
    assert.equal((await recover()).status, 200, label);
    assert.deepEqual(row(), { role: "admin", isDisabled: 0, failedLoginAttempts: 0, lockedUntil: null }, label);
    assert.equal((await bootstrap()).status, 200, `${label}: startup bootstrap works again`);
  };

  normalize();
  db.prepare("UPDATE users SET isDisabled = 1 WHERE id = ?").run(id);
  const disabled = await bootstrap();
  assert.equal(disabled.status, 403);
  assert.equal((await disabled.json() as any).code, "LOCAL_ACCOUNT_DISABLED");
  await expectRecovered("disabled");

  db.prepare("UPDATE users SET failedLoginAttempts = 5, lastFailedLoginAt = datetime('now'), lockedUntil = ? WHERE id = ?")
    .run(new Date(Date.now() + 60_000).toISOString(), id);
  const locked = await bootstrap();
  assert.equal(locked.status, 423);
  assert.equal((await locked.json() as any).code, "ACCOUNT_LOCKED");
  await expectRecovered("locked");

  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(id);
  const demoted = await bootstrap();
  assert.equal(demoted.status, 409);
  assert.equal((await demoted.json() as any).code, "LOCAL_ACCOUNT_REQUIRES_MANUAL_LOGIN");
  await expectRecovered("demoted");

  assert.equal(
    (getDb().prepare("SELECT contentText FROM notes WHERE id = ?").get("issue-787-note") as { contentText: string }).contentText,
    "keep this note",
  );
});
