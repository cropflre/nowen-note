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
