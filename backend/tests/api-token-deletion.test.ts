import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type Database from "better-sqlite3";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-token-deletion-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;

let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let tokens: typeof import("../src/lib/api-tokens.js");

test.before(async () => {
  const schema = await import("../src/db/schema.js");
  db = schema.getDb();
  closeDb = schema.closeDb;
  tokens = await import("../src/lib/api-tokens.js");
  const { initAuditTables } = await import("../src/services/audit.js");
  initAuditTables();
  const { default: router } = await import("../src/routes/tokens.js");
  app = new Hono();
  app.route("/tokens", router);
  for (const user of ["owner", "other"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(user, user);
  }
});

test.after(() => {
  closeDb?.();
  fs.rmSync(directory, { recursive: true, force: true });
});

function seed(revoked = true, expired = false) {
  const id = randomUUID();
  const raw = tokens.generateApiTokenRaw();
  db.prepare(`INSERT INTO api_tokens (id, userId, name, tokenHash, scopes, revokedAt, expiresAt)
    VALUES (?, 'owner', 'Test token', ?, '["notes:read"]', ?, ?)`)
    .run(id, tokens.hashApiToken(raw), revoked ? new Date().toISOString() : null, expired ? "2000-01-01T00:00:00Z" : null);
  db.prepare(`INSERT INTO api_token_resources (id, tokenId, resourceId) VALUES (?, ?, 'notebook')`)
    .run(randomUUID(), id);
  db.prepare("INSERT INTO api_token_usage (tokenId, day, count) VALUES (?, ?, 3)")
    .run(id, new Date().toISOString().slice(0, 10));
  return { id, raw };
}

function exists(table: string, id: string) {
  const column = table === "api_tokens" ? "id" : "tokenId";
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(id));
}

function remove(id: string, user = "owner", authorization?: string) {
  return app.request(`/tokens/${id}/permanent`, {
    method: "DELETE",
    headers: { "X-User-Id": user, ...(authorization ? { Authorization: authorization } : {}) },
  });
}

test("deletes a revoked token, cascades resources and usage, and retains audit history", async () => {
  const target = seed();
  const other = seed();
  db.prepare(`INSERT INTO audit_logs (id, userId, category, action, targetType, targetId)
    VALUES (?, 'owner', 'system', 'api_token_revoked', 'api_token', ?)`)
    .run(randomUUID(), target.id);

  const response = await remove(target.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  for (const table of ["api_tokens", "api_token_resources", "api_token_usage"]) {
    assert.equal(exists(table, target.id), false);
    assert.equal(exists(table, other.id), true);
  }
  assert.equal(tokens.resolveApiToken(db, target.raw), null);
  const history = db.prepare("SELECT action FROM audit_logs WHERE targetId = ? ORDER BY rowid").all(target.id);
  assert.deepEqual(history, [{ action: "api_token_revoked" }, { action: "api_token_deleted" }]);
  const list = await app.request("/tokens", { headers: { "X-User-Id": "owner" } });
  const body = await list.json() as { tokens: Array<{ id: string }> };
  assert.equal(body.tokens.some((item) => item.id === target.id), false);
  const usage = await app.request("/tokens/usage", { headers: { "X-User-Id": "owner" } });
  const stats = await usage.json() as { byToken: Array<{ tokenId: string }> };
  assert.equal(stats.byToken.some((item) => item.tokenId === target.id), false);
});

test("requires revocation first, including expired tokens", async () => {
  for (const expired of [false, true]) {
    const { id } = seed(false, expired);
    assert.equal((await remove(id)).status, 409);
    for (const table of ["api_tokens", "api_token_resources", "api_token_usage"]) {
      assert.equal(exists(table, id), true);
    }
  }
});

test("cannot delete another user's token and does not disclose its existence", async () => {
  const { id } = seed();
  assert.equal((await remove(id, "other")).status, 404);
  assert.equal((await remove("missing", "other")).status, 404);
  assert.equal(exists("api_tokens", id), true);
});

test("requires a login credential instead of an API token", async () => {
  const { id, raw } = seed();
  assert.equal((await remove(id, "owner", `Bearer ${raw}`)).status, 403);
  assert.equal(exists("api_tokens", id), true);
});

test("keeps the existing DELETE endpoint as an idempotent revocation", async () => {
  const { id, raw } = seed(false);
  const revoke = () => app.request(`/tokens/${id}`, { method: "DELETE", headers: { "X-User-Id": "owner" } });
  assert.equal((await revoke()).status, 200);
  assert.equal(exists("api_tokens", id), true);
  assert.equal(tokens.resolveApiToken(db, raw), null);
  assert.deepEqual(await (await revoke()).json(), { success: true, alreadyRevoked: true });
  assert.equal((await remove(id)).status, 200);
  assert.equal((await remove(id)).status, 404);
});

test("rolls back the entire delete when a cascading delete fails", async () => {
  const { id } = seed();
  db.exec(`CREATE TEMP TRIGGER fail_token_usage_delete BEFORE DELETE ON api_token_usage
    BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END;`);
  try {
    app.onError((_error, c) => c.json({ error: "delete failed" }, 500));
    assert.equal((await remove(id)).status, 500);
    for (const table of ["api_tokens", "api_token_resources", "api_token_usage"]) {
      assert.equal(exists(table, id), true);
    }
    assert.equal(db.prepare("SELECT 1 FROM audit_logs WHERE targetId = ? AND action = 'api_token_deleted'").get(id), undefined);
  } finally {
    db.exec("DROP TRIGGER fail_token_usage_delete");
  }
});
