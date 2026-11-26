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

test('concurrent local downloads cannot mutate the same migration or persist rejected credentials', async () => {
  let release!: (response: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered=resolve; });
  globalThis.fetch = (async () => { entered(); return new Promise<Response>(resolve => { release=resolve; }); }) as typeof fetch;
  const request = () => app.request('/api/sync/local/lite-migration', {
    method:'POST',headers:{'Content-Type':'application/json','X-User-Id':'local-user'},
    body:JSON.stringify({serverUrl:'https://migration.test',token:'rejected-token'}),
  });
  const first=request(); await started;
  const second=await request();
  assert.equal(second.status,409);
  release(Response.json({code:'TOKEN_INVALID'},{status:401}));
  assert.equal((await first).status,500);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM sync_profiles').get() as {count:number}).count,0);
  globalThis.fetch=originalFetch;
});

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

test("DCC-003: Sync V2 持久化 refreshToken，在 15 分钟 Access Token 过期后自动续期并保持数据与连接不中断", async () => {
  const {
    createRemoteClientForProfile,
    createBlobClientForProfile,
    saveRemoteCredential,
  } = await import("../src/sync/credentials");
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile");
  const { SyncRealtimeSubscription } = await import("../src/sync/realtime");

  let refreshCount = 0;
  let currentValidToken = "access-token-v1";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.endsWith("/api/auth/login")) {
      return Response.json({
        token: "access-token-v1",
        refreshToken: "refresh-token-30d",
        user: { id: "remote-refresh-user", username: "bob" },
      });
    }
    if (url.endsWith("/api/auth/refresh")) {
      const body = JSON.parse(String(init?.body || "{}")) as { refreshToken?: string };
      if (body.refreshToken !== "refresh-token-30d") {
        return Response.json({ code: "REFRESH_TOKEN_INVALID" }, { status: 401 });
      }
      refreshCount += 1;
      currentValidToken = "access-token-v2";
      return Response.json({ token: currentValidToken });
    }
    if (headers.get("Authorization") !== `Bearer ${currentValidToken}`) {
      return Response.json({ code: "TOKEN_INVALID" }, { status: 401 });
    }
    if (url.includes("/api/sync/v2/scopes")) {
      return Response.json({ items: [{ scopeKey: "personal", workspaceId: null, workspaceName: null, role: null, canWrite: true, accessFingerprint: "fp" }] });
    }
    if (url.includes("/api/sync/v2/blob/")) {
      return new Response(null, { status: 200 });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;

  const res = await login({
    serverUrl: "https://refresh-sync.example.com",
    username: "bob",
    password: "bob-password",
  });
  assert.equal(res.response.status, 200);
  const profileId = res.json.profile.id as string;
  assert.equal(getRemoteCredential(profileId)?.token, "access-token-v1");
  assert.equal((getRemoteCredential(profileId) as any)?.refreshToken, "refresh-token-30d");

  // 模拟 15 分钟后 access-token-v1 过期
  currentValidToken = "access-token-v2";
  const remoteClient = createRemoteClientForProfile(profileId, "https://refresh-sync.example.com")!;
  const blobClient = createBlobClientForProfile(profileId, "https://refresh-sync.example.com")!;

  // 并发触发 remote + blob 401：应合并为 1 次 /api/auth/refresh 且两端都无感成功
  const [scopes, exists] = await Promise.all([
    remoteClient.listScopes(),
    blobClient.exists("att-1"),
  ]);
  assert.equal(scopes.length, 1);
  assert.equal(exists, true);
  assert.equal(refreshCount, 1, "并发 401 应只发一次 refresh 请求");
  assert.equal(getRemoteCredential(profileId)?.token, "access-token-v2");

  // Realtime 重连时应拿到刷新后的新 token
  const seenWsUrls: string[] = [];
  class FakeWebSocket {
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(url: string) { seenWsUrls.push(url); }
    close() { this.readyState = 3; }
  }
  const rt = new SyncRealtimeSubscription({
    serverUrl: "https://refresh-sync.example.com",
    token: "access-token-v1",
    getToken: () => getRemoteCredential(profileId)?.token ?? null,
    onNotice: () => {},
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
  rt.start();
  rt.stop();
  assert.match(seenWsUrls[0], /token=access-token-v2/, "WebSocket 重连必须使用续期后的最新 token");

  // Refresh 期间网络抖动应归类为可重试 NETWORK_UNAVAILABLE，绝不误判为 AUTH_EXPIRED 踢出登录
  const p2 = createProfile(getDb(), { name: "NetFlaky", serverUrl: "https://flaky.example.com" });
  switchActiveProfile(getDb(), p2.id);
  saveRemoteCredential({
    profileId: p2.id,
    serverUrl: "https://flaky.example.com",
    token: "stale-token",
    refreshToken: "valid-refresh",
  } as any);
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/auth/refresh")) throw new TypeError("Tailscale DERP timeout");
    return Response.json({ code: "TOKEN_INVALID" }, { status: 401 });
  }) as typeof fetch;
  const flakyClient = createRemoteClientForProfile(p2.id, "https://flaky.example.com")!;
  await assert.rejects(
    () => flakyClient.listScopes(),
    (error: any) => error?.code === "NETWORK_UNAVAILABLE",
    "刷新凭据时的网络超时不得误判为 AUTH_EXPIRED",
  );

  // Refresh Token 本身被服务端拒绝（401）时，才应明确上报 AUTH_EXPIRED 要求重新登录
  globalThis.fetch = (async () => Response.json({ code: "REFRESH_TOKEN_EXPIRED" }, { status: 401 })) as typeof fetch;
  await assert.rejects(
    () => flakyClient.listScopes(),
    (error: any) => error?.code === "AUTH_EXPIRED",
    "Refresh Token 已失效时应返回 AUTH_EXPIRED",
  );
  globalThis.fetch = originalFetch;
});

test("Lite 首次下载续期后拒绝不同账号，重试时可保存原账号的新凭据", async (t) => {
  const { stopSyncEngine } = await import("../src/sync/runtime");
  t.after(() => {
    stopSyncEngine();
    globalThis.fetch = originalFetch;
  });
  const serverUrl = "https://migration-refresh.test";
  let renewedUser = "other-nas-user";
  let renewedPlanCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const route = new URL(String(input)).pathname;
    const auth = new Headers(init?.headers).get("Authorization");
    if (route === "/api/me") {
      return Response.json({ id: auth === "Bearer renewed" ? renewedUser : "original-nas-user" });
    }
    if (route === "/api/auth/refresh") {
      return Response.json({ token: "renewed", refreshToken: "renewed-refresh" });
    }
    if (auth !== "Bearer renewed") return Response.json({}, { status: 401 });
    if (route === "/api/sync/v2/plan") {
      renewedPlanCalls++;
      return Response.json({ serverSequence: 0, notebookCount: 0, noteCount: 0, tagCount: 0 });
    }
    if (route === "/api/sync/v2/snapshot") {
      return Response.json({ snapshotSequence: 0, items: [], hasMore: false, nextCursor: null });
    }
    if (route === "/api/sync/v2/changes") {
      return Response.json({ items: [], nextSequence: 0, serverSequence: 0, hasMore: false });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const request = () => app.request("/api/sync/local/lite-migration", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": "local-user" },
    body: JSON.stringify({ serverUrl, token: "initial", refreshToken: "initial-refresh" }),
  });

  const refused = await (await request()).json() as { stage: string; errorCode: string };
  assert.equal(refused.stage, "auth_required");
  assert.equal(refused.errorCode, "AUTH_EXPIRED");
  assert.equal(renewedPlanCalls, 0);
  assert.equal(getDb().prepare("SELECT 1 FROM sync_profiles WHERE serverUrl=?").get(serverUrl), undefined);

  renewedUser = "original-nas-user";
  const completed = await (await request()).json() as { stage: string; profileId: string };
  assert.equal(completed.stage, "complete");
  assert.equal(getRemoteCredential(completed.profileId)?.token, "renewed");
  assert.equal(getRemoteCredential(completed.profileId)?.refreshToken, "renewed-refresh");
  assert.equal(getRemoteCredential(completed.profileId)?.remoteUserId, "original-nas-user");
});
