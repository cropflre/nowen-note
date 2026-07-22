import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-share-security-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.JWT_SECRET = "test-share-security-secret-308";

let closeDb: () => void;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("capabilities preserve read while enforcing download and reshare flags", async () => {
  const [{ getDb, closeDb: close }, { resolveEffectiveNoteCapabilities }] = await Promise.all([
    import("../src/db/schema"),
    import("../src/services/share-capabilities"),
  ]);
  closeDb = close;
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("owner", "owner", "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("viewer", "viewer", "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run("nb", "owner", "Notebook");
  db.prepare("INSERT INTO notes (id, userId, notebookId, title, content, contentText) VALUES (?, ?, ?, ?, '{}', '')")
    .run("note", "owner", "nb", "Note");
  db.prepare(`INSERT INTO notebook_members
    (id, notebookId, userId, role, status, allowDownload, allowReshare, source)
    VALUES (?, ?, ?, 'viewer', 'active', 0, 1, 'manual')`)
    .run("member", "nb", "viewer");

  const capabilities = resolveEffectiveNoteCapabilities("note", "viewer");
  assert.equal(capabilities.read, true);
  assert.equal(capabilities.write, false);
  assert.equal(capabilities.download, false);
  assert.equal(capabilities.reshare, true);
});

test("share access token credential version invalidates old tokens", async () => {
  const { signShareAccessToken, verifyShareAccessToken } = await import("../src/lib/auth-security");
  const token = signShareAccessToken({ shareId: "share", noteId: "note", credentialVersion: 2 });
  assert.ok(verifyShareAccessToken(token, "share", 2));
  assert.equal(verifyShareAccessToken(token, "share", 3), null);
});

test("single share counts unique sessions and permits an existing session after the limit", async () => {
  const [{ getDb }, access] = await Promise.all([
    import("../src/db/schema"),
    import("../src/services/single-share-access"),
  ]);
  const db = getDb();
  db.prepare(`INSERT INTO shares
    (id, noteId, ownerId, shareToken, permission, maxViews, viewCount, credentialVersion)
    VALUES ('share-session', 'note', 'owner', 'session-token', 'view', 1, 0, 1)`)
    .run();

  const app = new Hono();
  app.get("/count", (c) => {
    const share = access.findSingleShareByToken("session-token")!;
    const auth = access.authorizeSingleShareRequest(c, share);
    if (!auth.ok) return c.json(auth.payload, auth.status);
    return c.json(access.consumeShareViewSession(c, share));
  });

  const first = await app.request("/count", { headers: { "X-Share-Session": "session-one" } });
  assert.equal(first.status, 200);
  assert.equal((await first.json() as any).counted, true);
  const refresh = await app.request("/count", { headers: { "X-Share-Session": "session-one" } });
  assert.equal(refresh.status, 200);
  assert.equal((await refresh.json() as any).counted, false);
  const second = await app.request("/count", { headers: { "X-Share-Session": "session-two" } });
  assert.equal(second.status, 410);
});

test("credential limiter blocks repeated failures and can be reset", async () => {
  const limiter = await import("../src/lib/share-credential-rate-limit");
  limiter.resetShareRateLimitsForTests();
  for (let i = 0; i < 8; i += 1) limiter.recordCredentialFailure("same-key");
  assert.equal(limiter.checkCredentialAttempt("same-key").allowed, false);
  limiter.recordCredentialSuccess("same-key");
  assert.equal(limiter.checkCredentialAttempt("same-key").allowed, true);
});
