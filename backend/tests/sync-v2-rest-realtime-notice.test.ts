/**
 * Web → Android realtime regression (bidirectional realtime sync, P0).
 *
 * Reproduces the "Android stays on version 15 while Web is on version 20" report
 * with the real server routes, the real /ws WebSocket transport, the real native
 * SQLite schema and the real MobileSyncEngine:
 *
 *   REST note save → DB trigger → sync_changes_v2 → sync.changed over /ws
 *   → MobileSyncEngine.requestSync → Pull → native SQLite Apply → onApplied
 *
 * Before the fix only Sync V2 Push and knowledge-tree routes emitted sync.changed;
 * an ordinary REST save (and live Yjs persistence) left native devices waiting for
 * the 30 s fallback Pull.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sync-rest-notice-"));
process.env.DB_PATH = path.join(tmpDir, "server.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";
process.env.JWT_SECRET = "rest-realtime-notice-test-secret-2026-11";
Object.assign(globalThis, { window: new EventTarget() });

const USER = "rest-notice-user";
// One CommonJS module graph: routes, notifier and realtime must share state.
const load = createRequire(path.resolve(__dirname, "../package.json"));

type Notice = { recipient: string; notice: Record<string, unknown>; committed: boolean };
let serverDb: Database.Database;
let closeServerDb: () => void;
let httpServer: ReturnType<typeof serve>;
let serverUrl = "";
let token = "";
let stopFlusher: () => void = () => undefined;
let shutdownRealtime: () => Promise<void> = async () => undefined;
let disconnectRealtime: () => void = () => undefined;
let yjs: typeof import("../src/services/yjs");
const realtimeTimers: NodeJS.Timeout[] = [];
const notices: Notice[] = [];
const sockets: WebSocket[] = [];
const engines: MobileSyncEngine[] = [];
const dbs: NativeDatabase[] = [];

// Real native schema extracted from nativeDatabase.ts (same approach as the
// multidevice suite), with serialized transactions like NativeDatabaseImpl.
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

/** An Android device: native SQLite + engine, woken only by real /ws notices. */
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
  const connect = () => new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`);
    sockets.push(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { type: string; sequence?: number };
      if (message.type === "connected") resolve();
      // Same reaction as installMobileSyncRealtime(): a 150 ms coalesced Pull.
      if (message.type === "sync.changed") { realtimeNotices.push(Number(message.sequence)); engine.requestSync(150); }
    });
    socket.on("error", reject);
  });
  /** Wait until an Apply touches noteId and the predicate over native SQLite holds. */
  const waitForNote = async (noteId: string, predicate: (row: Record<string, unknown>) => boolean, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = (await db.query<Record<string, unknown>>("SELECT * FROM notes WHERE id=?", [noteId]))[0];
      if (row && predicate(row)) return row;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`native note ${noteId} did not converge; notices=${JSON.stringify(realtimeNotices)}`);
      await new Promise<void>((resolve) => { waiters.push(resolve); setTimeout(resolve, Math.min(left, 100)); });
    }
  };
  /** Wait until no Pull is running or scheduled, so later convergence needs a fresh wake. */
  const quiesce = async () => {
    const state = engine as unknown as { running: boolean; debounce: unknown };
    for (let idle = 0; idle < 6;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      idle = !state.running && !state.debounce ? idle + 1 : 0;
    }
    applied.length = 0;
  };
  const retire = () => { engine.stop(); for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close(); };
  return { db, profileId, engine, repository, applied, realtimeNotices, connect, waitForNote, quiesce, retire };
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

/** Create a note from the device itself and bootstrap it, as in real first use. */
async function openSharedNote(device: Awaited<ReturnType<typeof androidDevice>>, title: string, content: string) {
  const id = randomUUID();
  await device.repository.createPersonalTreeNote({ id, title, contentFormat: "markdown", content, contentText: content }, null);
  device.engine.start();
  await device.waitForNote(id, () => true);
  for (let i = 0; i < 40 && (await device.db.query("SELECT id FROM sync_outbox WHERE profileId=?", [device.profileId])).length; i++) {
    device.engine.requestSync(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(serverNote(id), "the device's note reached the server");
  return id;
}

/** A Web editor tab: real /ws connection subscribed to the note room. */
async function webEditor(noteId: string, opts: { yjs?: boolean } = {}) {
  const messages: Array<Record<string, unknown>> = [];
  const socket = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      messages.push(message);
      if (message.type === "connected") {
        socket.send(JSON.stringify(opts.yjs ? { type: "y:join", noteId } : { type: "subscribe", room: `note:${noteId}` }));
      }
      if (message.type === (opts.yjs ? "y:sync" : "connected")) setTimeout(resolve, 50);
    });
    socket.on("error", reject);
  });
  const waitFor = async (predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`web editor did not receive the update; got ${JSON.stringify(messages.map((m) => m.type))}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return { socket, messages, waitFor };
}

function yjsText(noteId: string): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(yjs.yJoin(noteId, USER).stateBase64, "base64"));
  yjs.yLeave(noteId);
  return doc.getText("content").toString();
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
  // Fixture identity (production auth is index.ts), then the same global
  // post-commit notice middleware index.ts installs on /api/*.
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
  // The realtime service has no teardown API; record its heartbeat so the test
  // process can exit. Production behaviour is untouched.
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const timer = originalSetInterval(...args); realtimeTimers.push(timer); return timer;
  }) as typeof setInterval;
  try { realtime.attachRealtimeServer(httpServer as unknown as import("http").Server); }
  finally { globalThis.setInterval = originalSetInterval; }
  disconnectRealtime = () => realtime.disconnectUser(USER, "session_revoked");
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
  disconnectRealtime();
  for (const timer of realtimeTimers) clearInterval(timer);
  await shutdownRealtime().catch(() => undefined);
  // fetch() keeps idle keep-alive sockets; close them so the process can exit.
  (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  for (const db of dbs) await db.close().catch(() => undefined);
  closeServerDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Web REST save reaches an open Android note through /ws, Pull and native SQLite without a manual refresh", async () => {
  const android = await androidDevice("android-open-note");
  await android.connect();
  const id = await openSharedNote(android, "双向同步测试 1106", "Android v15 body");
  const before = serverNote(id);
  const local = (await android.db.query<{ version: number }>("SELECT version FROM notes WHERE id=?", [id]))[0];
  assert.equal(local.version, before.version, "both ends start from the same version");
  await android.quiesce();
  const firstNotice = notices.length;

  const startedAt = Date.now();
  let version = before.version;
  // Several consecutive Web saves, as in the 15 → 20 report.
  for (let i = 1; i <= 5; i++) {
    const response = await restSave(id, { title: "双向同步测试 1106", content: `Web body revision ${i}`, contentText: `Web body revision ${i}`, version });
    assert.equal(response.status, 200, await response.clone().text());
    version = serverNote(id).version;
  }
  const committedAt = Date.now();
  // The server stabilizes Markdown (block anchors); converge on its persisted body.
  const row = await android.waitForNote(id, (note) => note.version === version && note.content === serverNote(id).content);
  const visibleAt = Date.now();

  const server = serverNote(id);
  assert.equal(row.version, server.version);
  assert.equal(row.content, server.content);
  assert.equal(row.contentText, server.contentText);
  assert.equal(row.title, server.title);
  assert.ok(server.version >= before.version + 5, `server advanced ${before.version} → ${server.version}`);
  assert.ok(android.applied.some((detail) => detail.noteIds.includes(id)), "the open editor is told which note changed");

  const sent = notices.slice(firstNotice);
  assert.ok(sent.length >= 1, "REST saves emit sync.changed");
  assert.ok(sent.every((entry) => entry.recipient === USER && entry.committed));
  assert.ok(sent.every((entry) => JSON.stringify(Object.keys(entry.notice).sort()) === JSON.stringify(["accessFingerprint", "scopeKey", "sequence", "type"])),
    "notices are metadata-only (no title or body)");
  assert.ok(!JSON.stringify(sent).includes("Web body revision"), "no note body in notices");
  assert.ok(android.realtimeNotices.length >= 1, "the device received the notice over the real WebSocket");

  // The cursor ACK follows the SQLite Apply; allow that last step to land.
  const feedMax = (serverDb.prepare("SELECT MAX(sequence) AS s FROM sync_changes_v2 WHERE userId=?").get(USER) as { s: number }).s;
  const readState = async () => (await android.db.query<{ lastSequence: number; lastError: string | null }>(
    "SELECT lastSequence,lastError FROM sync_state WHERE profileId=? AND scopeKey='personal'", [android.profileId]))[0];
  let state = await readState();
  for (let i = 0; i < 40 && state.lastSequence !== feedMax; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); state = await readState(); }
  assert.equal(state.lastError, null);
  assert.equal(state.lastSequence, feedMax, "the durable cursor reached the server feed");
  console.log("[latency] web→android last-commit→native-applied ms:", visibleAt - committedAt, "total ms:", visibleAt - startedAt);
  android.retire();
});

test("a failed REST write emits no wake-up notice", async () => {
  const android = await androidDevice("android-stale");
  await android.connect();
  const id = await openSharedNote(android, "stale", "stale base");
  const stale = serverNote(id).version;
  assert.equal((await restSave(id, { content: "first", contentText: "first", version: stale })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const count = notices.length;
  const rejected = await restSave(id, { content: "lost update", contentText: "lost update", version: stale });
  assert.equal(rejected.status, 409);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(notices.length, count, "nothing was committed, nothing was announced");
  assert.ok(serverNote(id).content.startsWith("first"));
  android.retire();
});

test("live Yjs persistence (body change without a version bump) is announced and applied to native SQLite", async () => {
  const android = await androidDevice("android-yjs");
  await android.connect();
  const id = await openSharedNote(android, "yjs", "before live edit");
  const before = serverNote(id);
  await android.quiesce();
  // Mirrors persistNoteContent()'s non-bump branch in services/yjs.ts: no HTTP request.
  serverDb.prepare("UPDATE notes SET content=?, contentText=?, updatedAt=datetime('now','+1 second') WHERE id=? AND version=?")
    .run("live collaborative body", "live collaborative body", id, before.version);
  const row = await android.waitForNote(id, (note) => note.content === "live collaborative body");
  assert.equal(row.version, before.version, "same version, newer body");
  assert.ok(android.applied.some((detail) => detail.noteIds.includes(id)));
  android.retire();
});

test("a tag link change reports the affected open note", async () => {
  const android = await androidDevice("android-tags");
  await android.connect();
  const id = await openSharedNote(android, "tags", "tag target");
  const tagId = randomUUID();
  await android.quiesce();
  serverDb.prepare("INSERT INTO tags (id,userId,name,color) VALUES (?,?,?,?)").run(tagId, USER, "realtime", "#58a6ff");
  serverDb.prepare("INSERT INTO note_tags (noteId,tagId) VALUES (?,?)").run(id, tagId);
  const deadline = Date.now() + 4000;
  while (!android.applied.some((detail) => detail.noteIds.includes(id)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(android.applied.some((detail) => detail.noteIds.includes(id)), JSON.stringify(android.applied));
  assert.equal((await android.db.query("SELECT tagId FROM note_tags WHERE noteId=? AND tagId=?", [id, tagId])).length, 1);
  android.retire();
});

test("a full Change Feed page keeps pulling instead of waiting for the next wake-up", async () => {
  const android = await androidDevice("android-paging");
  const first = await openSharedNote(android, "page filler", "filler");
  const second = await openSharedNote(android, "after page", "before");
  // No WebSocket on this device: only the engine's own continuation may fetch page two.
  await android.quiesce();
  const fill = serverDb.prepare("UPDATE notes SET version=version+1, updatedAt=datetime('now') WHERE id=?");
  serverDb.transaction(() => { for (let i = 0; i < 510; i++) fill.run(first); })();
  serverDb.prepare("UPDATE notes SET content='after the first page', contentText='after the first page', version=version+1 WHERE id=?").run(second);
  android.engine.requestSync(0);
  const row = await android.waitForNote(second, (note) => note.content === "after the first page", 8000);
  assert.equal(row.version, serverNote(second).version);
  android.retire();
});

test("Android edit reaches an open Web editor through note:updated and note:list-updated", async () => {
  const android = await androidDevice("android-to-web");
  const id = await openSharedNote(android, "android to web", "server body");
  const web = await webEditor(id);
  await android.quiesce();
  const startedAt = Date.now();
  await android.repository.notes.update(id, { content: "Android typed this", contentText: "Android typed this" });
  android.engine.requestSync(0); // the repository's requestSync hook in production
  const updated = await web.waitFor((message) => message.type === "note:updated" && message.noteId === id
    && message.version === serverNote(id).version && serverNote(id).content.startsWith("Android typed this"));
  const visibleAt = Date.now();
  await web.waitFor((message) => message.type === "note:list-updated"
    && (message.note as { id?: string } | undefined)?.id === id);
  assert.equal("content" in updated, false, "the broadcast carries no body; the editor fetches it");
  // What the Web editor's applyRemoteNoteUpdate() then reads:
  const fetched = await (await fetch(`${serverUrl}/api/notes/${id}`, { headers: { Authorization: `Bearer ${USER}` } })).json() as { content: string; version: number };
  assert.ok(fetched.content.startsWith("Android typed this"));
  assert.equal(fetched.version, updated.version);
  console.log("[latency] android→web local-save→web-notice ms:", visibleAt - startedAt);
  android.retire();
});

test("Android edit replaces persisted Yjs state so a Markdown session never resurrects the old body", async () => {
  const android = await androidDevice("android-yjs-state");
  const id = await openSharedNote(android, "md collab", "collab baseline");
  // A Web Markdown session existed earlier: the note now has Yjs history.
  assert.ok(yjsText(id).startsWith("collab baseline"));
  yjs.yDestroyDoc(id);
  const live = await webEditor(id, { yjs: true });
  await android.quiesce();
  await android.repository.notes.update(id, { content: "Android body", contentText: "Android body" });
  android.engine.requestSync(0);
  await live.waitFor((message) => message.type === "y:update" && message.noteId === id);
  assert.ok(serverNote(id).content.startsWith("Android body"));
  assert.equal(yjsText(id), serverNote(id).content, "active Y.Doc carries the committed Android body");
  live.socket.close();
  yjs.yDestroyDoc(id);
  assert.equal(yjsText(id), serverNote(id).content, "a cold Markdown session loads the Android body too");
  android.retire();
});
