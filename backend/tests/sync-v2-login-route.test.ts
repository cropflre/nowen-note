import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sync-v2-login-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";

let app: Hono;
let closeDb: () => void;
let getDb: typeof import("../src/db/schema").getDb;
let getRemoteCredential: typeof import("../src/sync/credentials").getRemoteCredential;
const originalFetch = globalThis.fetch;

test.before(async () => {
  const [routes, schema, credentials] = await Promise.all([
    import("../src/routes/sync-local"),
    import("../src/db/schema"),
    import("../src/sync/credentials"),
  ]);
  closeDb = schema.closeDb;
  getDb = schema.getDb;
  getRemoteCredential = credentials.getRemoteCredential;
  app = new Hono();
  app.route("/api/sync/local", routes.default);
});

test.after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function login(body: Record<string, unknown>) {
  const response = await app.request("/api/sync/local/settings/server/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": "local-user" },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json() as any };
}

test("远端账号登录支持 2FA，并只持久化 Token 后建立授权 Profile", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.endsWith("/api/auth/login")) {
      return Response.json({ requires2FA: true, ticket: "ticket-1", username: "alice" });
    }
    return Response.json({
      token: "remote-access-token",
      user: { id: "remote-user-1", username: "alice" },
    });
  }) as typeof fetch;

  const first = await login({
    serverUrl: "https://notes.example.com/",
    username: "alice",
    password: "top-secret-password",
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.json.requiresTwoFactor, true);
  assert.equal(first.json.ticket, "ticket-1");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM sync_profiles").get().count, 0);

  const second = await login({
    serverUrl: "https://notes.example.com",
    ticket: first.json.ticket,
    code: "123456",
  });
  assert.equal(second.response.status, 200);
  assert.equal(second.json.authorized, true);
  assert.equal(second.json.bootstrapRequired, true);
  assert.equal(second.json.engineRunning, false);

  const profile = getDb().prepare(`
    SELECT id, serverUrl, remoteUserId, enabled FROM sync_profiles WHERE enabled = 1
  `).get() as { id: string; serverUrl: string; remoteUserId: string; enabled: number };
  assert.equal(profile.serverUrl, "https://notes.example.com");
  assert.equal(profile.remoteUserId, "remote-user-1");
  assert.equal(getRemoteCredential(profile.id)?.token, "remote-access-token");

  const stored = fs.readFileSync(path.join(tmpDir, ".sync_credentials.json"), "utf8");
  assert.equal(stored.includes("top-secret-password"), false, "密码不得写入本地凭据文件");
  assert.deepEqual(requests.map((item) => item.url), [
    "https://notes.example.com/api/auth/login",
    "https://notes.example.com/api/auth/2fa/verify",
  ]);
  assert.deepEqual(requests[0].body, { username: "alice", password: "top-secret-password" });
  assert.deepEqual(requests[1].body, { ticket: "ticket-1", code: "123456" });

  const settings = await app.request("/api/sync/local/settings", {
    headers: { "X-User-Id": "local-user" },
  });
  const settingsJson = await settings.json() as any;
  assert.equal(settingsJson.authorized, true);
  assert.equal(settingsJson.authorizationState, "ready");
});
