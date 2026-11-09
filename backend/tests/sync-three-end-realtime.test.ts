/**
 * 三端实时双向同步：Web / PC（Electron 同一份前端）/ Android。
 *
 * 全部走真实链路，不 mock 业务层：
 *   - 真实 Hono 路由（/api/notes、/api/sync/v2）
 *   - 真实 /ws 服务（Yjs 房间 + note 房间 + sync.changed 通知）
 *   - 真实 native SQLite schema 与真实 MobileSyncEngine（Android 侧的 Outbox/Pull/Push）
 *
 * 覆盖：实时输入互达、保存后跨端到达、Yjs 持久化回落 Android、高频输入不丢字、
 * 旧版本写入被拒、双端并发编辑保留两端正文。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import WebSocket from "ws";
import * as Y from "yjs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { NativeLocalRepository } from "../../frontend/src/lib/nativeLocalRepository";
import { MobileSyncEngine } from "../../frontend/src/lib/mobileSyncEngine";
import { NATIVE_TASK_REPEAT_COLUMNS } from "../../frontend/src/lib/nativeTaskFields";
import { NATIVE_TASK_DELETION_STATEMENTS } from "../../frontend/src/lib/nativeTaskRecurrenceDeletion";
import type { NativeDatabase } from "../../frontend/src/lib/nativeDatabase";
import type { MobileSyncAppliedDetail } from "../../frontend/src/lib/mobileSyncStatus";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sync-three-end-"));
process.env.DB_PATH = path.join(tmpDir, "server.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";
process.env.JWT_SECRET = "three-end-realtime-secret-2026-11";
Object.assign(globalThis, { window: new EventTarget() });

const USER = "three-end-user";
const load = createRequire(path.resolve(__dirname, "../package.json"));

type Notice = { recipient: string; notice: Record<string, unknown>; committed: boolean };
let serverDb: Database.Database;
let closeServerDb: () => void;
let httpServer: ReturnType<typeof serve>;
let serverUrl = "";
let token = "";
let stopFlusher: () => void = () => undefined;
let shutdownRealtime: () => Promise<void> = async () => undefined;
let yjs: typeof import("../src/services/yjs");
const realtimeTimers: NodeJS.Timeout[] = [];
const notices: Notice[] = [];
const sockets: WebSocket[] = [];
const engines: MobileSyncEngine[] = [];
const dbs: NativeDatabase[] = [];

// ---------------------------------------------------------------------------
// Native SQLite（真 schema，从 nativeDatabase.ts 抽取）
// ---------------------------------------------------------------------------
function openClientDb(file: string): NativeDatabase {
  const raw = new Database(file);
  raw.pragma("foreign_keys = ON");
  const source = fs.readFileSync(path.resolve(__dirname, "../../frontend/src/lib/nativeDatabase.ts"), "utf8");
  const scopeCheck = source.match(/const SCOPE_CHECK = `([\s\S]*?)`;/)![1];
  const entityTypes = source.match(/const ENTITY_TYPE_CHECK = `([\s\S]*?)`;/)![1];
  for (const [, sql] of source.matchAll(/`(CREATE TABLE IF NOT EXISTS [\s\S]*?)`/g)) {
    raw.exec(sql.replaceAll("${SCOPE_CHECK}", scopeCheck).replaceAll("${ENTITY_TYPE_CHECK}", entityTypes));
  }
  const taskColumns = new Set((raw.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name));
  for (const [field, type] of Object.entries(NATIVE_TASK_REPEAT_COLUMNS)) {
    if (!taskColumns.has(field)) raw.exec(`ALTER TABLE tasks ADD COLUMN ${field} ${type}`);
  }
  for (const statement of NATIVE_TASK_DELETION_STATEMENTS) raw.exec(statement);
  let queue = Promise.resolve();
  const schedule = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  const tx: NativeDatabase = {
    async run(sql, values = []) { return { changes: raw.prepare(sql).run(...values).changes }; },
    async query<T>(sql: string, values: unknown[] = []) { return raw.prepare(sql).all(...values) as T[]; },
    async transaction(work) { return work(tx); },
    async close() { raw.close(); },
  };
  const db: NativeDatabase = {
    run: (sql, values) => schedule(() => tx.run(sql, values)),
    query: <T>(sql: string, values?: unknown[]) => schedule(() => tx.query<T>(sql, values)),
    transaction: (work) => schedule(async () => {
      raw.exec("BEGIN IMMEDIATE");
      try { const result = await work(tx); raw.exec("COMMIT"); return result; }
      catch (error) { raw.exec("ROLLBACK"); throw error; }
    }),
    close: () => schedule(() => tx.close()),
  };
  dbs.push(db);
  return db;
}

/** Android 端：native SQLite + 真实 MobileSyncEngine，只靠真实 /ws 通知唤醒。 */
async function androidDevice(name: string) {
  const db = openClientDb(path.join(tmpDir, `${name}.db`));
  const profileId = `profile-${name}`;
  await db.run(`INSERT INTO sync_profiles (id,name,serverUrl,remoteUserId,enabled,createdAt,updatedAt)
    VALUES (?,?,?,?,1,'now','now')`, [profileId, name, serverUrl, USER]);
  await db.run("INSERT INTO sync_devices (profileId,deviceId,platform,createdAt) VALUES (?,?,'android','now')", [profileId, name]);
  const applied: MobileSyncAppliedDetail[] = [];
  const waiters: Array<() => void> = [];
  const engine = new MobileSyncEngine({
    db, attachments: { remove: async () => undefined } as never, profileId, deviceId: name, serverUrl, token, userId: USER,
    onApplied: (detail) => { applied.push(detail); for (const wake of waiters.splice(0)) wake(); },
  });
  engines.push(engine);
  const repository = new NativeLocalRepository({ db, attachments: {} as never, accountId: name, userId: USER, getScopeKey: () => "personal" });
  const realtimeNotices: number[] = [];
  let socket: WebSocket | null = null;
  const connect = async () => {
    socket = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name}: ws connect timeout`)), 5000);
      socket!.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; sequence?: number };
        if (message.type === "connected") { clearTimeout(timer); resolve(); }
        if (message.type === "sync.changed") { realtimeNotices.push(Number(message.sequence)); engine.requestSync(150); }
      });
      socket!.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
  };
  await connect();
  const disconnect = () => { socket?.terminate(); socket = null; };
  const waitForNote = async (noteId: string, predicate: (row: Record<string, unknown>) => boolean, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = (await db.query<Record<string, unknown>>("SELECT * FROM notes WHERE id=?", [noteId]))[0];
      if (row && predicate(row)) return row;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`${name}: note ${noteId} 未收敛；notices=${JSON.stringify(realtimeNotices)}`);
      await new Promise<void>((resolve) => { waiters.push(resolve); setTimeout(resolve, Math.min(left, 100)); });
    }
  };
  const quiesce = async () => {
    const state = engine as unknown as { running: boolean; debounce: unknown };
    for (let idle = 0; idle < 6;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      idle = !state.running && !state.debounce ? idle + 1 : 0;
    }
    applied.length = 0;
  };
  const retire = () => { engine.stop(); if (socket && socket.readyState === WebSocket.OPEN) socket.close(); };
  return { db, profileId, engine, repository, applied, realtimeNotices, waitForNote, quiesce, connect, disconnect, retire };
}

/** Web / PC 端：真实 /ws 连接 + 本地 Y.Doc，模拟编辑器输入与接收。 */
async function editingClient(name: string, noteId: string) {
  const messages: Array<Record<string, unknown>> = [];
  const doc = new Y.Doc();
  const received: number[] = [];
  let ready = false;
  const socket = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: ws connect timeout`)), 5000);
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      messages.push(message);
      if (message.type === "connected") {
        socket.send(JSON.stringify({ type: "subscribe", room: `note:${noteId}` }));
        socket.send(JSON.stringify({ type: "y:join", noteId }));
      }
      if (message.type === "y:sync") { Y.applyUpdate(doc, Buffer.from(String(message.state), "base64")); ready = true; clearTimeout(timer); resolve(); }
      if (message.type === "y:update") { received.push(Date.now()); Y.applyUpdate(doc, Buffer.from(String(message.update), "base64")); }
      if (message.type === "error") { console.warn(`[${name}] server error`, message); }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
  const text = () => doc.getText("content").toString();
  /** 本地键入一个字符并广播；生产环境由 y-prosemirror / y-codemirror 触发同样的 update。 */
  const type = (chunk: string) => {
    if (!ready) throw new Error(`${name}: y:sync not arrived`);
    doc.getText("content").insert(text().length, chunk);
    socket.send(JSON.stringify({ type: "y:update", noteId, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") }));
  };
  const waitFor = async (predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${name} 未收到预期消息；types=${JSON.stringify(messages.map((m) => m.type))}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const waitForText = async (expected: string, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (text() === expected) return Date.now(); await new Promise((resolve) => setTimeout(resolve, 20)); }
    throw new Error(`${name} 正文未收敛：got=${JSON.stringify(text())} want=${JSON.stringify(expected)}`);
  };
  const retire = () => { try { socket.close(); } catch { /* already closed */ } doc.destroy(); };
  return { socket, doc, messages, received, text, type, waitFor, waitForText, retire };
}

function serverNote(id: string) {
  return serverDb.prepare("SELECT id,title,content,contentText,version,updatedAt FROM notes WHERE id=?").get(id) as
    { id: string; title: string; content: string; contentText: string; version: number; updatedAt: string };
}

async function restSave(id: string, body: Record<string, unknown>) {
  return fetch(`${serverUrl}/api/notes/${id}`, {
    method: "PUT", headers: { Authorization: `Bearer ${USER}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

/** 用 Android 设备真实创建一篇共享笔记并推到服务端（两端初始 version 一致）。 */
async function createSharedNote(device: Awaited<ReturnType<typeof androidDevice>>, title: string, content: string) {
  const id = randomUUID();
  await device.repository.createPersonalTreeNote({ id, title, contentFormat: "markdown", content, contentText: content }, null);
  device.engine.start();
  await device.waitForNote(id, () => true);
  for (let i = 0; i < 40 && (await device.db.query("SELECT id FROM sync_outbox WHERE profileId=?", [device.profileId])).length; i++) {
    device.engine.requestSync(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(serverNote(id), "初始笔记已到达服务端");
  return id;
}

test.before(async () => {
  const schema = load("./src/db/schema.ts") as typeof import("../src/db/schema");
  const auth = load("./src/lib/auth-security.ts") as typeof import("../src/lib/auth-security");
  const realtime = load("./src/services/realtime.ts") as typeof import("../src/services/realtime");
  const notify = load("./src/sync/notify.ts") as typeof import("../src/sync/notify");
  const feed = load("./src/sync/feedNotifier.ts") as typeof import("../src/sync/feedNotifier");
  const syncRoutes = load("./src/routes/sync-v2.ts") as typeof import("../src/routes/sync-v2");
  const noteRoutes = load("./src/routes/notes.ts") as typeof import("../src/routes/notes");
  yjs = load("./src/services/yjs.ts") as typeof import("../src/services/yjs");
  serverDb = schema.getDb(); closeServerDb = schema.closeDb;
  serverDb.prepare("INSERT INTO users (id,username,passwordHash,createdAt,updatedAt) VALUES (?,?,'x','now','now')").run(USER, USER);
  token = auth.signLoginToken({ userId: USER, username: USER, tokenVersion: 0 });
  shutdownRealtime = realtime.shutdownRealtime;

  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    const bearer = c.req.header("Authorization")?.replace("Bearer ", "") || "";
    c.req.raw.headers.set("X-User-Id", bearer === USER || bearer === token ? USER : bearer);
    await next();
  });
  app.use("/api/*", feed.syncChangeNoticeMiddleware);
  app.route("/api/sync/v2", syncRoutes.default);
  app.route("/api/notes", noteRoutes.default);
  httpServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const address = httpServer.address(); assert.ok(address && typeof address !== "string");
  serverUrl = `http://127.0.0.1:${address.port}`;

  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const timer = originalSetInterval(...args); realtimeTimers.push(timer); return timer;
  }) as typeof setInterval;
  try { realtime.attachRealtimeServer(httpServer as unknown as import("http").Server); }
  finally { globalThis.setInterval = originalSetInterval; }
  notify.setSyncBroadcaster((recipient, notice) => {
    notices.push({ recipient, notice: notice as Record<string, unknown>, committed: !serverDb.inTransaction });
    realtime.broadcastToUser(recipient, notice as never);
  });
  stopFlusher = feed.startSyncChangeNoticeFlusher(serverDb, 50);
});

test.after(async () => {
  stopFlusher();
  for (const engine of engines) engine.stop();
  for (const socket of sockets) socket.terminate();
  for (const timer of realtimeTimers) clearInterval(timer);
  await shutdownRealtime().catch(() => undefined);
  (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  for (const db of dbs) await db.close().catch(() => undefined);
  closeServerDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Web 键入 → PC 端实时可见（Yjs），端到端延迟", async () => {
  const android = await androidDevice("t1-android");
  const id = await createSharedNote(android, "三端实时 T1", "line one\n");
  const web = await editingClient("web-t1", id);
  const pc = await editingClient("pc-t1", id);
  await android.quiesce();
  const baseline = pc.text();

  const sentAt = Date.now();
  web.type("WEB");
  const arrivedAt = await pc.waitForText(baseline + "WEB");
  const latency = arrivedAt - sentAt;
  assert.equal(web.text(), baseline + "WEB");
  assert.ok(latency < 1000, `Web→PC 延迟 ${latency}ms 超过 1s`);
  console.log(`[latency] Web 键入 → PC 可见: ${latency}ms`);

  // 服务端收到的是同一份 Yjs 状态（PC、Web 都基于服务端同步的 doc）
  assert.equal(pc.received.length >= 1, true, "PC 至少收到一条 y:update");
  web.retire(); pc.retire(); android.retire();
});

test("PC 键入 → Web 端实时可见（反向）", async () => {
  const android = await androidDevice("t2-android");
  const id = await createSharedNote(android, "三端实时 T2", "seed\n");
  const web = await editingClient("web-t2", id);
  const pc = await editingClient("pc-t2", id);
  await android.quiesce();
  const baseline = web.text();

  const sentAt = Date.now();
  pc.type("PC!");
  const arrivedAt = await web.waitForText(baseline + "PC!");
  const latency = arrivedAt - sentAt;
  assert.ok(latency < 1000, `PC→Web 延迟 ${latency}ms 超过 1s`);
  console.log(`[latency] PC 键入 → Web 可见: ${latency}ms`);
  web.retire(); pc.retire(); android.retire();
});

test("Web 键入 → Yjs 持久化 → Android native SQLite 自动收敛（无需手动刷新）", async () => {
  const android = await androidDevice("t3-android");
  const id = await createSharedNote(android, "三端实时 T3", "android base\n");
  const web = await editingClient("web-t3", id);
  await android.quiesce();
  const startedAt = Date.now();

  web.type("web-live-edit");
  // Android 侧只在收到 sync.changed 时 Pull；这里验证它确实被唤醒并落库
  const row = await android.waitForNote(id, (note) => String(note.content || "").includes("web-live-edit"), 12000);
  const latency = Date.now() - startedAt;
  assert.ok(String(row.content).includes("web-live-edit"));
  assert.ok(android.realtimeNotices.length >= 1, "Android 收到了实时通知");
  console.log(`[latency] Web 键入 → Android 落库: ${latency}ms (notices=${android.realtimeNotices.length})`);
  web.retire(); android.retire();
});

test("Android 保存 → Web 与 PC 同时收到 note:updated", async () => {
  const android = await androidDevice("t4-android");
  const id = await createSharedNote(android, "三端实时 T4", "server body");
  const web = await editingClient("web-t4", id);
  const pc = await editingClient("pc-t4", id);
  await android.quiesce();

  const startedAt = Date.now();
  await android.repository.notes.update(id, { content: "Android typed this", contentText: "Android typed this" });
  android.engine.requestSync(0);
  const webAt = await web.waitFor((message) => message.type === "note:updated" && message.noteId === id).then(() => Date.now());
  const pcAt = await pc.waitFor((message) => message.type === "note:updated" && message.noteId === id).then(() => Date.now());
  const version = serverNote(id).version;

  assert.ok(serverNote(id).content.includes("Android typed this"));
  assert.ok(String(web.messages.find((m) => m.type === "note:updated")?.version) === String(version));
  console.log(`[latency] Android 保存 → Web ${webAt - startedAt}ms / PC ${pcAt - startedAt}ms`);
  assert.ok(webAt - startedAt < 3000 && pcAt - startedAt < 3000, "两端都应在 3s 内收到更新");
  web.retire(); pc.retire(); android.retire();
});

test("Web 连续键入 40 个字符，PC 端最终正文逐字一致（不丢字、不乱序）", async () => {
  const android = await androidDevice("t5-android");
  const id = await createSharedNote(android, "三端实时 T5", "");
  const web = await editingClient("web-t5", id);
  const pc = await editingClient("pc-t5", id);
  await android.quiesce();

  const chunk = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
  for (const ch of chunk) { web.type(ch); await new Promise((resolve) => setTimeout(resolve, 8)); }
  const expected = web.text();
  await pc.waitForText(expected, 8000);
  assert.equal(pc.text(), expected);
  assert.equal(pc.text().length, chunk.length, "字符数不能丢");
  console.log(`[result] 连续键入 ${chunk.length} 字符，PC 端收敛一致（${pc.received.length} 条 y:update）`);
  web.retire(); pc.retire(); android.retire();
});

test("Web 用旧 version 保存被拒 409，PC 的新正文不被覆盖", async () => {
  const android = await androidDevice("t6-android");
  const id = await createSharedNote(android, "三端实时 T6", "base");
  const staleVersion = serverNote(id).version;

  const first = await restSave(id, { title: "三端实时 T6", content: "first writer", contentText: "first writer", version: staleVersion });
  assert.equal(first.status, 200, await first.clone().text());
  const second = await restSave(id, { title: "三端实时 T6", content: "stale writer", contentText: "stale writer", version: staleVersion });
  assert.equal(second.status, 409, "旧 version 必须被拒绝");

  const final = serverNote(id);
  assert.ok(final.content.startsWith("first writer"), `不能被旧版本写入覆盖；实际=${final.content}`);
  android.retire();
});

test("Android 未推送的编辑 + Web 保存 → 冲突保留两端正文", async () => {
  const android = await androidDevice("t7-android");
  const id = await createSharedNote(android, "三端实时 T7", "shared base");
  await android.quiesce();
  const baseVersion = serverNote(id).version;

  // Android 本地编辑但不 push（模拟离线/尚未同步）
  android.engine.stop();
  await android.repository.notes.update(id, { content: "Android offline edit", contentText: "Android offline edit" });

  // Web 在此期间保存
  const webSave = await restSave(id, { title: "三端实时 T7", content: "Web online edit", contentText: "Web online edit", version: baseVersion });
  assert.equal(webSave.status, 200);

  // Android 恢复同步 → Push 应判冲突
  android.engine.start();
  for (let i = 0; i < 30; i++) {
    android.engine.requestSync(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const conflicts = await android.db.query("SELECT id FROM sync_conflicts WHERE entityId=? AND status='unresolved'", [id]);
    if (conflicts.length) break;
  }
  const conflicts = await android.db.query<{ localPayload: string; remotePayload: string }>(
    "SELECT localPayload,remotePayload FROM sync_conflicts WHERE entityId=? AND status='unresolved'", [id]);
  assert.equal(conflicts.length, 1, "必须产生一条未解决冲突");
  const local = String(conflicts[0].localPayload || "");
  const remote = String(conflicts[0].remotePayload || "");
  assert.ok(local.includes("Android offline edit"), `冲突里保留本地正文：${local.slice(0, 120)}`);
  assert.ok(remote.includes("Web online edit"), `冲突里保留服务器正文：${remote.slice(0, 120)}`);
  assert.ok(serverNote(id).content.startsWith("Web online edit"), "服务器保持 Web 的正文，等待用户选择");
  console.log("[result] 冲突记录 local/remote 双份正文均保留");
  android.retire();
});

test("Web 与 PC 同时键入：两端 CRDT 收敛一致，不丢任何一方输入", async () => {
  const android = await androidDevice("t9-android");
  const id = await createSharedNote(android, "三端实时 T9", "");
  const web = await editingClient("web-t9", id);
  const pc = await editingClient("pc-t9", id);
  await android.quiesce();

  web.type("AAA");
  pc.type("BBB");
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(web.text(), pc.text(), "两端最终正文必须一致");
  assert.equal(web.text().length, 6, "两段输入都不能丢");
  assert.ok(web.text().includes("AAA") && web.text().includes("BBB"));
  console.log(`[result] 并发键入收敛: ${JSON.stringify(web.text())}`);
  web.retire(); pc.retire(); android.retire();
});

test("Android 断线期间 Web 保存：重连后是否自动补齐（实时缺口诊断）", async () => {
  const android = await androidDevice("t8-android");
  const id = await createSharedNote(android, "三端实时 T8", "before offline");
  await android.quiesce();

  android.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const version = serverNote(id).version;
  const saved = await restSave(id, { title: "三端实时 T8", content: "saved while android offline", contentText: "saved while android offline", version });
  assert.equal(saved.status, 200);
  const committedAt = Date.now();

  // 真实客户端重连后只恢复房间订阅，不会主动 Pull；这里不发任何手动唤醒。
  await android.connect();
  const deadline = Date.now() + 8000;
  let convergedAt = 0;
  while (Date.now() < deadline) {
    const row = (await android.db.query<{ content: string }>("SELECT content FROM notes WHERE id=?", [id]))[0];
    if (row && String(row.content).includes("saved while android offline")) { convergedAt = Date.now(); break; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (convergedAt) {
    console.log(`[latency] 断线重连 → Android 补齐: ${convergedAt - committedAt}ms`);
  } else {
    // 数据本身没丢，只是没有主动唤醒：手动唤醒一次证明服务端与本地都能收敛。
    console.log("[gap] 断线重连后 8s 内未自动补齐（重连不触发 Pull）");
    android.engine.requestSync(0);
    const row = await android.waitForNote(id, (note) => String(note.content || "").includes("saved while android offline"), 5000);
    assert.ok(String(row.content).includes("saved while android offline"), "手动唤醒后收敛");
    console.log("[gap] 手动唤醒后立即收敛：数据完好，缺的是重连时的主动补齐");
  }
  android.retire();
});

test("Web 连续 10 次保存：Android 不卡在中间版本，最终收敛到最新正文", async () => {
  const android = await androidDevice("t10-android");
  const id = await createSharedNote(android, "三端实时 T10", "v0");
  await android.quiesce();

  const startedAt = Date.now();
  let version = serverNote(id).version;
  for (let i = 1; i <= 10; i++) {
    const response = await restSave(id, { title: "三端实时 T10", content: `revision ${i}`, contentText: `revision ${i}`, version });
    assert.equal(response.status, 200, await response.clone().text());
    version = serverNote(id).version;
  }
  const committedAt = Date.now();
  const row = await android.waitForNote(id, (note) => String(note.content || "").startsWith("revision 10") && Number(note.version) === version, 12000);
  const latency = Date.now() - committedAt;
  assert.equal(Number(row.version), version);
  assert.ok(String(row.content).startsWith("revision 10"), `最终必须是最后一版，实际=${row.content}`);
  console.log(`[latency] 10 次保存 → Android 收敛到 v${version}: ${latency}ms（提交耗时 ${committedAt - startedAt}ms）`);
  android.retire();
});
