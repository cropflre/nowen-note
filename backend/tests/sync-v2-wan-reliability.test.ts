import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Hono } from "hono";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sync-v2-wan-"));
process.env.DB_PATH = path.join(temp, "server.db");
process.env.ELECTRON_USER_DATA = temp;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";

const USER = "wan-reliability-user";
const openDbs: Database.Database[] = [];

test.after(async () => {
  for (const db of openDbs) db.close();
  (await import("../src/db/schema")).closeDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test("SyncRealtimeSubscription 发送保活 ping 心跳，并在握手前 401 断连时触发 refreshToken 续期", async () => {
  const { SyncRealtimeSubscription } = await import("../src/sync/realtime");

  const sent: string[] = [];
  const seenUrls: string[] = [];
  const timers: Array<{ id: number; delay: number; fn: () => void; cleared: boolean; fired: boolean }> = [];
  let nextTimerId = 1;
  const scheduler = {
    setTimeout(fn: () => void, ms: number) {
      const entry = { id: nextTimerId++, delay: ms, fn, cleared: false, fired: false };
      timers.push(entry);
      return entry;
    },
    clearTimeout(handle: unknown) {
      const entry = handle as { cleared?: boolean } | null;
      if (entry) entry.cleared = true;
    },
  };

  let lastSocket: FakeWebSocket | null = null;
  class FakeWebSocket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(url: string) {
      seenUrls.push(url);
      lastSocket = this;
    }
    send(data: string) { sent.push(data); }
    close() { this.readyState = 3; }
  }

  let currentToken = "expired-token";
  let refreshCalls = 0;
  let noticeCount = 0;
  const rt = new SyncRealtimeSubscription({
    serverUrl: "https://nas.tailnet.ts.net:3001",
    token: currentToken,
    getToken: () => currentToken,
    refreshToken: async () => {
      refreshCalls += 1;
      currentToken = "fresh-token";
      return currentToken;
    },
    heartbeatIntervalMs: 25_000,
    onNotice: () => { noticeCount += 1; },
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    scheduler,
  });

  // 1. 首次握手即失败（模拟 15 分钟 Access Token 过期导致的 WS 401）
  rt.start();
  assert.match(seenUrls[0], /token=expired-token/);
  lastSocket!.onclose?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(refreshCalls, 1, "握手失败时应主动触发一次 refreshToken");

  // 触发重连定时器，应使用续期后的新 token
  const reconnectTimer = timers.find((t) => !t.cleared && !t.fired && t.delay < 25_000);
  assert.ok(reconnectTimer, "续期后应排程重连");
  reconnectTimer.fired = true;
  reconnectTimer.fn();
  assert.match(seenUrls[1], /token=fresh-token/);

  // 2. 握手成功后应按 25s 周期发送 ping，防止服务端 60s 误踢
  lastSocket!.readyState = 1;
  lastSocket!.onopen?.();
  assert.equal(noticeCount, 1);
  const hbTimer = timers.find((t) => !t.cleared && !t.fired && t.delay === 25_000);
  assert.ok(hbTimer, "连接打开后应启动 25s 心跳定时器");
  hbTimer.fired = true;
  hbTimer.fn();
  assert.deepEqual(sent, [JSON.stringify({ type: "ping" })]);

  // 3. stop() 应清理所有未触发的心跳与重连定时器
  rt.stop();
  assert.equal(timers.filter((t) => !t.cleared && !t.fired).length, 0);
});

test("SyncRemoteClient 将 HTTP 408/429 归类为可重试错误，且 setAbortSignal 可立即中止在途请求", async () => {
  const { SyncRemoteClient } = await import("../src/sync/remote");

  const client408 = new SyncRemoteClient(
    { serverUrl: "https://nas.example.test", token: "tok" },
    { fetchImpl: async () => new Response("timeout", { status: 408 }) as any },
  );
  await assert.rejects(
    () => client408.listScopes(),
    (err: any) => err?.code === "NETWORK_UNAVAILABLE" && err?.retryable === true,
  );

  const client429 = new SyncRemoteClient(
    { serverUrl: "https://nas.example.test", token: "tok" },
    { fetchImpl: async () => new Response("slow down", { status: 429 }) as any },
  );
  await assert.rejects(
    () => client429.listScopes(),
    (err: any) => err?.code === "SERVER_ERROR" && err?.retryable === true,
  );

  let seenAbort = false;
  const abortableClient = new SyncRemoteClient(
    { serverUrl: "https://nas.example.test", token: "tok" },
    {
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          seenAbort = true;
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    },
  );
  const ac = new AbortController();
  abortableClient.setAbortSignal(ac.signal);
  const pending = abortableClient.listScopes();
  ac.abort();
  await assert.rejects(
    () => pending,
    (err: any) => err?.code === "NETWORK_UNAVAILABLE" && err?.diagnostic?.reason === "ENGINE_STOPPED",
  );
  assert.equal(seenAbort, true);
});

test("快照响应头已到达但正文停滞时仍会超时", async () => {
  const { SyncRemoteClient } = await import("../src/sync/remote");
  const client = new SyncRemoteClient({ serverUrl: "https://nas.example.test", token: "fixture" }, {
    timeoutMs: 20,
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    }),
  });
  await assert.rejects(
    () => client.snapshot(null, 0),
    (err: any) => err?.code === "NETWORK_UNAVAILABLE" && err?.diagnostic?.reason === "REQUEST_TIMEOUT",
  );
});

test("重启已绑定的 SyncEngine 不应重复拉取全量 Snapshot，大体积 Outbox 应按字节拆批并支持 413 自适应缩批", async () => {
  const { getDb } = await import("../src/db/schema");
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile");
  const { ensureDevice } = await import("../src/sync/device");
  const { SyncEngine } = await import("../src/sync/engine");
  const { SyncRemoteClient } = await import("../src/sync/remote");
  const { enqueueMutation, countPendingMutations } = await import("../src/sync/outbox");
  const { default: routes } = await import("../src/routes/sync-v2");

  const server = getDb();
  server.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'x')").run(USER, USER);
  server.prepare("INSERT INTO notebooks(id,userId,name) VALUES ('nb-wan',?,'WAN')").run(USER);
  await server.backup(path.join(temp, "desktop.db"));
  // 写入 3 篇各约 900KB 的长文，测试服务端 /snapshot 2MB 字节预算分页不漏数据
  const bigBody = "甲".repeat(300_000); // ~900KB UTF-8
  for (let i = 1; i <= 3; i++) {
    server.prepare(`
      INSERT INTO notes(id,userId,notebookId,title,content,contentText,version)
      VALUES (?,?,?,?,?,?,1)
    `).run(`srv-big-${i}`, USER, "nb-wan", `大文${i}`, bigBody, bigBody);
  }

  server.prepare("INSERT INTO users(id,username,passwordHash) VALUES ('other-user','other-user','x')").run();
  server.prepare("INSERT INTO notebooks(id,userId,name) VALUES ('other-nb','other-user','private')").run();
  server.prepare("INSERT INTO notes(id,userId,notebookId,title,content) VALUES ('private-note','other-user','other-nb','private','private')").run();

  const local = new Database(path.join(temp, "desktop.db"));
  openDbs.push(local);
  local.pragma("foreign_keys=ON");
  (await import("../src/lib/searchIndex")).ensureNormalizedSearchFts(local);

  const profile = createProfile(local, { name: "Tailscale NAS", serverUrl: "http://wan-sync.test" });
  switchActiveProfile(local, profile.id);
  local.prepare("UPDATE sync_profiles SET remoteUserId=?, localUserId=?, bootstrapStatus='ready' WHERE id=?")
    .run(USER, USER, profile.id);
  const device = ensureDevice(local, { profileId: profile.id });

  const app = new Hono();
  app.use("*", async (c, next) => {
    if (c.req.header("Authorization") === "Bearer fixture") c.req.raw.headers.set("X-User-Id", USER);
    await next();
  });
  app.route("/api/sync/v2", routes);
  assert.equal((await app.request("/api/sync/v2/snapshot")).status, 401);

  let snapshotCalls = 0;
  let pushBatchSizes: number[] = [];
  let rejectMultiNotePushes = false;
  const remote = new SyncRemoteClient({ serverUrl: "http://wan-sync.test", token: "fixture" }, {
    fetchImpl: async (url, init) => {
      if (url.includes("/snapshot?")) snapshotCalls += 1;
      if (url.includes("/push?")) {
        const body = JSON.parse(String(init?.body || "{}")) as { mutations?: unknown[] };
        const count = body.mutations?.length ?? 0;
        pushBatchSizes.push(count);
        if (rejectMultiNotePushes && count > 1) {
          return new Response("Payload Too Large", { status: 413 }) as any;
        }
      }
      return app.request(url, init) as any;
    },
  });

  // 1. 首次同步：绑定 12 实体（/snapshot 因 2MB 软字节预算自动拆成多页，但全部数据完整落地）
  const engine1 = new SyncEngine({
    db: local, profileId: profile.id, deviceId: device.id, userId: USER,
    client: remote, intervalMs: 0, scheduler: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  const first = await engine1.syncOnce();
  assert.equal(first.lastError, null, JSON.stringify(first));
  assert.ok(snapshotCalls >= 3, `3 篇长文应触发 /snapshot 字节分页（实际 ${snapshotCalls} 页）`);
  for (let i = 1; i <= 3; i++) {
    const note = local.prepare("SELECT content FROM notes WHERE id=?").get(`srv-big-${i}`) as { content: string };
    assert.equal(note.content === bigBody, true, "跨页下载必须保留完整正文");
  }
  assert.equal(local.prepare("SELECT 1 FROM notes WHERE id='private-note'").get(), undefined);
  engine1.stop();

  // 2. 重启新建 SyncEngine 实例：已绑定状态下不得再拉全量 Snapshot！
  const snapshotsBeforeRestart = snapshotCalls;
  const engine2 = new SyncEngine({
    db: local, profileId: profile.id, deviceId: device.id, userId: USER,
    client: remote, intervalMs: 0, scheduler: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  const afterRestart = await engine2.syncOnce();
  assert.equal(afterRestart.lastError, null, JSON.stringify(afterRestart));
  assert.equal(snapshotCalls, snapshotsBeforeRestart, "重启后已绑定设备不应重复拉取全量 Snapshot");

  // 3. 写入 4 篇大体积 Outbox（每篇 ~400KB，合计 ~1.6MB > 1MB 预算）：应自动拆批推送并全部清空
  const mediumBody = "乙".repeat(135_000); // ~405KB UTF-8
  for (let i = 1; i <= 4; i++) {
    const id = `local-big-${i}`;
    enqueueMutation(local, {
      entityType: "note",
      entityId: id,
      operation: "upsert",
      deviceId: device.id,
      profileId: profile.id,
      payload: {
        id,
        notebookId: "nb-wan",
        title: `本地长文${i}`,
        content: mediumBody,
        contentText: "",
        contentFormat: "markdown",
      },
    });
  }
  pushBatchSizes = [];
  rejectMultiNotePushes = true;

  // 第一轮命中 413 → 自动缩批并标为可重试 SERVER_ERROR，不卡死在 INVALID_PAYLOAD
  const hit413 = await engine2.syncOnce();
  assert.equal(hit413.lastError, "SERVER_ERROR", "多条批量撞 413 应转为可重试并自动缩批");
  assert.equal(countPendingMutations(local, profile.id), 4);
  assert.ok(pushBatchSizes[0] < 4, `1MB 字节预算应先截断首批（实际首批 ${pushBatchSizes[0]} 条）`);

  // 后续轮次按缩小后的批次全部推完
  for (let round = 0; round < 6 && countPendingMutations(local, profile.id) > 0; round++) {
    const st = await engine2.syncOnce();
    assert.equal(st.lastError, null, JSON.stringify(st));
  }
  assert.equal(countPendingMutations(local, profile.id), 0, "所有大体积待同步条目应分批成功清空");
  const serverCount = (server.prepare("SELECT COUNT(*) AS count FROM notes WHERE id LIKE 'local-big-%'").get() as { count: number }).count;
  assert.equal(serverCount, 4);
  engine2.stop();
});

test("SyncRemoteClient 保留安全底层网络错误码（如 ECONNRESET），且不泄露敏感 URL 或错误原文", async () => {
  const { SyncRemoteClient } = await import("../src/sync/remote");

  const makeClient = (err: unknown) => new SyncRemoteClient(
    { serverUrl: "http://100.111.97.52:34597", token: "secret-token" },
    { fetchImpl: async () => { throw err; } },
  );

  const resetErr = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET 100.111.97.52"), { code: "ECONNRESET" }),
  });
  await assert.rejects(
    () => makeClient(resetErr).snapshot(null, 0),
    (err: any) => err?.code === "NETWORK_UNAVAILABLE"
      && err?.diagnostic?.step === "http.get/snapshot"
      && err?.diagnostic?.reason === "ECONNRESET",
  );

  const unsafeCodeErr = Object.assign(new Error("boom http://100.111.97.52"), {
    code: "http://100.111.97.52/secret",
  });
  await assert.rejects(
    () => makeClient(unsafeCodeErr).listScopes(),
    (err: any) => err?.code === "NETWORK_UNAVAILABLE" && err?.diagnostic?.reason === "NETWORK_ERROR",
  );
});

test("Snapshot 连续网络断流时客户端可逐次缩页到 limit=1 并最终完成重建", async () => {
  const { SyncEngine } = await import("../src/sync/engine");
  const { SyncRemoteClient } = await import("../src/sync/remote");
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile");
  const { ensureDevice } = await import("../src/sync/device");

  const localDbPath = path.join(temp, "snapshot-shrink.db");
  fs.copyFileSync(path.join(temp, "desktop.db"), localDbPath);
  const local = new Database(localDbPath);
  openDbs.push(local);
  local.pragma("foreign_keys=ON");
  (await import("../src/lib/searchIndex")).ensureNormalizedSearchFts(local);

  const profile = createProfile(local, { name: "Shrink NAS", serverUrl: "http://shrink-nas.test" });
  switchActiveProfile(local, profile.id);
  local.prepare("UPDATE sync_profiles SET remoteUserId=?, localUserId=?, bootstrapStatus='ready' WHERE id=?")
    .run(USER, USER, profile.id);
  const device = ensureDevice(local, { profileId: profile.id });

  const seenLimits: number[] = [];
  let acked = false;
  const client = new SyncRemoteClient({ serverUrl: "http://shrink-nas.test", token: "fixture" }, {
    fetchImpl: async (url) => {
      if (url.includes("/scopes")) {
        return new Response(JSON.stringify({
          items: [{ scopeKey: "personal", workspaceId: null, accessFingerprint: "fp-shrink", assetOrganization: "personal-v1" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } }) as any;
      }
      if (url.includes("/plan?")) {
        return new Response(JSON.stringify({
          scopeKey: "personal", accessFingerprint: "fp-shrink", assetOrganization: "personal-v1",
          entityTypes: ["notebook", "tag", "note", "note_tag", "favorite", "attachment", "task", "task_reminder", "diary", "mindmap", "attachment_organization", "knowledge_tree_node"],
          serverSequence: 1, minAvailableSequence: 0, resetRequired: !acked, notebookCount: 0, noteCount: 0, tagCount: 0,
        }), { status: 200, headers: { "Content-Type": "application/json" } }) as any;
      }
      if (url.includes("/snapshot?")) {
        const limit = Number(new URL(url).searchParams.get("limit") || "0");
        seenLimits.push(limit);
        if (limit > 1) {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        }
        return new Response(JSON.stringify({
          scopeKey: "personal", accessFingerprint: "fp-shrink", snapshotSequence: 1, hasMore: false, nextCursor: null, items: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } }) as any;
      }
      if (url.includes("/changes?")) {
        return new Response(JSON.stringify({
          scopeKey: "personal", accessFingerprint: "fp-shrink", serverSequence: 1, nextSequence: 1, hasMore: false, resetRequired: false, items: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } }) as any;
      }
      if (url.includes("/ack?")) {
        acked = true;
        return new Response(JSON.stringify({ lastSequence: 1, accessFingerprint: "fp-shrink" }), { status: 200, headers: { "Content-Type": "application/json" } }) as any;
      }
      return new Response("not found", { status: 404 }) as any;
    },
  });

  const engine = new SyncEngine({
    db: local, profileId: profile.id, deviceId: device.id, userId: USER,
    client, intervalMs: 0, scheduler: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  let status = await engine.syncOnce();
  for (let i = 0; i < 16 && status.lastError; i++) {
    status = await engine.syncOnce();
  }
  assert.equal(status.lastError, null, JSON.stringify(status));
  assert.ok(seenLimits.includes(1), `应允许一直缩页到 1，实际序列: ${JSON.stringify(seenLimits)}`);
  engine.stop();
});
