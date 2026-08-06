import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tokens-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.DB_DRIVER = "sqlite";

const USER_ID = "tokens-route-user";
let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

function db() {
  return getDb();
}

async function requestJson(
  method: string,
  url: string,
  body?: unknown,
  authorization?: string,
): Promise<{ status: number; json: any }> {
  const response = await app.request(url, {
    method,
    headers: {
      "X-User-Id": USER_ID,
      ...(authorization ? { Authorization: authorization } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test.before(async () => {
  const [routeModule, schemaModule, tokenLib, auditService] = await Promise.all([
    import("../src/routes/tokens"),
    import("../src/db/schema"),
    import("../src/lib/api-tokens"),
    import("../src/services/audit"),
  ]);

  app = new Hono();
  app.route("/tokens", routeModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  tokenLib.initApiTokensTable(db());
  auditService.initAuditTables();
  db()
    .prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");

  db().prepare(
    `INSERT INTO api_tokens (id, userId, name, tokenHash, scopes)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("old-token", USER_ID, "Old", "old-token-hash", "[]");
  db().prepare(
    "INSERT INTO api_token_usage (tokenId, day, count) VALUES (?, ?, ?)",
  ).run("old-token", "2020-01-01", 9);
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("token routes use async repositories while preserving maintenance, usage and revoke semantics", async () => {
  const initialList = await requestJson("GET", "/tokens");
  assert.equal(initialList.status, 200);
  assert.equal(
    db().prepare("SELECT count FROM api_token_usage WHERE tokenId = ?").get("old-token"),
    undefined,
    "the first token request should prune usage older than 90 days",
  );

  const created = await requestJson("POST", "/tokens", {
    name: "CLI",
    scopes: ["notes:read", "notes:read", "notes:write"],
    expiresInDays: 30,
  });
  assert.equal(created.status, 201);
  assert.match(created.json.token, /^nkn_/);
  assert.deepEqual(created.json.scopes, ["notes:read", "notes:write"]);

  const stored = db()
    .prepare("SELECT tokenHash, scopes, revokedAt FROM api_tokens WHERE id = ?")
    .get(created.json.id) as { tokenHash: string; scopes: string; revokedAt: string | null };
  assert.ok(stored);
  assert.notEqual(stored.tokenHash, created.json.token);
  assert.deepEqual(JSON.parse(stored.scopes), ["notes:read", "notes:write"]);
  assert.equal(stored.revokedAt, null);

  const selfReplication = await requestJson(
    "POST",
    "/tokens",
    { name: "Blocked" },
    `Bearer ${created.json.token}`,
  );
  assert.equal(selfReplication.status, 403);

  const listed = await requestJson("GET", "/tokens");
  assert.equal(listed.status, 200);
  const listedToken = listed.json.tokens.find((item: any) => item.id === created.json.id);
  assert.ok(listedToken);
  assert.equal("token" in listedToken, false);
  assert.equal("tokenHash" in listedToken, false);
  assert.deepEqual(listedToken.scopes, ["notes:read", "notes:write"]);

  const today = new Date().toISOString().slice(0, 10);
  db().prepare(
    "INSERT INTO api_token_usage (tokenId, day, count) VALUES (?, ?, ?)",
  ).run(created.json.id, today, 5);

  const usage = await requestJson("GET", "/tokens/usage?days=1");
  assert.equal(usage.status, 200);
  assert.equal(usage.json.days, 1);
  assert.equal(usage.json.total, 5);
  assert.equal(usage.json.series[0].day, today);
  assert.equal(usage.json.series[0].count, 5);
  assert.equal(usage.json.byToken[0].tokenId, created.json.id);
  assert.equal(usage.json.byToken[0].count, 5);

  const revoked = await requestJson("DELETE", `/tokens/${created.json.id}`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.success, true);

  const revokedAgain = await requestJson("DELETE", `/tokens/${created.json.id}`);
  assert.equal(revokedAgain.status, 200);
  assert.equal(revokedAgain.json.alreadyRevoked, true);
});
