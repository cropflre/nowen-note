/**
 * 拉取只取回变更的实体，不再从库首逐页翻整个知识库（DCC-005）。
 *
 * 旧做法为找一篇改过的笔记，平均要下载半个库的正文；改知识树或附件要翻完全部笔记。
 * 大库、弱网下手机单页 15 秒超时，拉取失败后从头再来，电脑上的修改迟迟到不了手机。
 *
 * 本文件里 getDb() 是服务端库：真实 /api/sync/v2/snapshot 路由 + 真实桌面 SyncRemoteClient
 * + 真实 Android MobileSyncEngine（经真实 HTTP）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { MobileSyncEngine } from "../../frontend/src/lib/mobileSyncEngine";
import { NATIVE_TASK_REPEAT_COLUMNS } from "../../frontend/src/lib/nativeTaskFields";
import { NATIVE_TASK_DELETION_STATEMENTS } from "../../frontend/src/lib/nativeTaskRecurrenceDeletion";
import type { NativeDatabase } from "../../frontend/src/lib/nativeDatabase";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-snapshot-seek-"));
process.env.DB_PATH = path.join(tmpDir, "server.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";
Object.assign(globalThis, { window: new EventTarget() });

const USER = "seek-user";
const NOTE_COUNT = 300;
const load = createRequire(path.resolve(__dirname, "../package.json"));

let serverDb: Database.Database;
let closeServerDb: () => void;
let app: Hono;
let httpServer: ReturnType<typeof serve>;
let serverUrl = "";
let seek: typeof import("../src/sync/snapshotSeek");
let SyncRemoteClient: typeof import("../src/sync/remote").SyncRemoteClient;
let negotiatedEntitySet = "";
const noteIds: string[] = [];
let tagId = "";
const snapshotLog: Array<{ cursor: string | null; deviceId: string | null; items: number; noteIds: string[] }> = [];
const dbs: NativeDatabase[] = [];
const engines: MobileSyncEngine[] = [];

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

function body(index: number): string {
  return `# 笔记 ${index}\n\n${"一段足够长的正文，用来体现整库扫描的下载量。".repeat(60)}`;
}

function desktopClient() {
  return new SyncRemoteClient({ serverUrl: "http://nas.test", token: USER }, {
    fetchImpl: async (url, init) => {
      const target = new URL(url);
      return app.request(`${target.pathname}${target.search}`, { method: init?.method, headers: init?.headers, body: init?.body }) as never;
    },
  });
}

/** 改造前的取法：从库首逐页翻到凑齐为止，只用来对比下载量。 */
async function legacyScan(client: InstanceType<typeof SyncRemoteClient>, wanted: string) {
  let cursor: string | null = null;
  let downloadedNotes = 0;
  do {
    const page = await client.snapshot(cursor, 0, undefined, "personal");
    downloadedNotes += page.items.filter((item) => item.entityType === "note").length;
    if (page.items.some((item) => item.entityType === "note" && item.entityId === wanted)) break;
    cursor = page.nextCursor;
  } while (cursor);
  return downloadedNotes;
}

test.before(async () => {
  const schema = load("./src/db/schema.ts") as typeof import("../src/db/schema");
  const routes = load("./src/routes/sync-v2.ts") as typeof import("../src/routes/sync-v2");
  seek = load("./src/sync/snapshotSeek.ts") as typeof import("../src/sync/snapshotSeek");
  SyncRemoteClient = (load("./src/sync/remote.ts") as typeof import("../src/sync/remote")).SyncRemoteClient;
  negotiatedEntitySet = (load("./src/sync/types.ts") as typeof import("../src/sync/types")).SYNC_V2_NEGOTIATED_ENTITY_TYPES.join(",");
  serverDb = schema.getDb();
  closeServerDb = schema.closeDb;
  serverDb.prepare("INSERT INTO users (id,username,passwordHash,createdAt,updatedAt) VALUES (?,?,'x','now','now')").run(USER, USER);
  const notebookId = randomUUID();
  serverDb.prepare("INSERT INTO notebooks (id,userId,name,createdAt,updatedAt) VALUES (?,?,'大库',datetime('now'),datetime('now'))").run(notebookId, USER);
  const insert = serverDb.prepare(`INSERT INTO notes (id,userId,notebookId,title,content,contentText,contentFormat,version,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,'markdown',1,datetime('now'),datetime('now'))`);
  serverDb.transaction(() => {
    for (let index = 0; index < NOTE_COUNT; index++) {
      const id = randomUUID();
      noteIds.push(id);
      insert.run(id, USER, notebookId, `笔记 ${index}`, body(index), body(index));
    }
  })();
  noteIds.sort();
  tagId = randomUUID();
  serverDb.prepare("INSERT INTO tags (id,userId,name,createdAt) VALUES (?,?,'标签',datetime('now'))").run(tagId, USER);
  serverDb.prepare("INSERT INTO note_tags (noteId,tagId) VALUES (?,?)").run(noteIds[42], tagId);

  app = new Hono();
  app.use("/api/*", async (c, next) => {
    c.req.raw.headers.set("X-User-Id", USER);
    await next();
  });
  app.use("/api/sync/v2/snapshot", async (c, next) => {
    await next();
    const page = await c.res.clone().json() as { items?: Array<{ entityType: string; entityId: string }> };
    snapshotLog.push({
      cursor: c.req.query("cursor") ?? null,
      deviceId: c.req.query("deviceId") ?? null,
      items: page.items?.length ?? 0,
      noteIds: (page.items || []).filter((item) => item.entityType === "note").map((item) => item.entityId),
    });
  });
  app.route("/api/sync/v2", routes.default);
  httpServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const address = httpServer.address(); assert.ok(address && typeof address !== "string");
  serverUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  for (const engine of engines) engine.stop();
  (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  for (const db of dbs) await db.close().catch(() => undefined);
  closeServerDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("DCC-005: a desktop pull fetches one changed note from a 300-note library with a single snapshot request", async () => {
  const client = desktopClient();
  const target = noteIds[200];
  const legacyDownloaded = await legacyScan(client, target);
  assert.ok(legacyDownloaded > 150, `fixture: the old scan downloads most notes (${legacyDownloaded})`);

  snapshotLog.length = 0;
  const found = await seek.fetchSnapshotEntities({
    wanted: [{ entityType: "note", entityId: target }],
    fetchPage: (cursor, limit) => client.snapshot(cursor, 0, limit, "personal"),
  });
  assert.deepEqual(found.map((item) => item.entityId), [target]);
  assert.equal(found[0].payload.content, serverDb.prepare("SELECT content FROM notes WHERE id=?").pluck().get(target));
  assert.equal(snapshotLog.length, 1, "one request");
  assert.deepEqual(snapshotLog[0].noteIds, [target], "no other note body is downloaded");
});

test("DCC-005: seeking finds composite ids and tree nodes, and a deleted entity stays missing so the cursor is not advanced", async () => {
  const deviceId = "seek-desktop";
  serverDb.prepare(`INSERT INTO sync_v2_clients (deviceId,userId,scopeKey,lastSequence,lastSeenAt,entitySet)
    VALUES (?,?, 'personal', 0, datetime('now'), ?)`).run(deviceId, USER, negotiatedEntitySet);
  const subscription = { entityTypes: negotiatedEntitySet.split(",") as never, deviceId };
  const client = desktopClient();
  const removed = noteIds[7];
  serverDb.prepare("DELETE FROM notes WHERE id=?").run(removed);
  const treeId = `note:${noteIds[10]}`;
  assert.ok(serverDb.prepare("SELECT 1 FROM knowledge_tree_nodes WHERE id=?").get(treeId), "fixture has a tree node");

  snapshotLog.length = 0;
  const found = await seek.fetchSnapshotEntities({
    wanted: [
      { entityType: "note_tag", entityId: `${noteIds[42]}:${tagId}` },
      { entityType: "knowledge_tree_node", entityId: treeId },
      { entityType: "note", entityId: removed },
    ],
    fetchPage: (cursor, limit) => client.snapshot(cursor, 0, limit, "personal", subscription),
  });
  assert.deepEqual(found.map((item) => `${item.entityType}:${item.entityId}`).sort(),
    [`knowledge_tree_node:${treeId}`, `note_tag:${noteIds[42]}:${tagId}`].sort());
  assert.ok(!found.some((item) => item.entityId === removed), "deleted note stays missing; the caller refuses to advance");
  assert.ok(snapshotLog.every((entry) => entry.cursor !== null), "never restarts from the beginning of the library");
  const downloadedNotes = snapshotLog.reduce((sum, entry) => sum + entry.noteIds.length, 0);
  assert.ok(downloadedNotes <= NOTE_COUNT, `a missing note costs at most one pass over the note section (${downloadedNotes})`);
});

test("DCC-005: a phone pull of one desktop edit downloads only that note from a large library", async () => {
  const db = openClientDb(path.join(tmpDir, "phone.db"));
  await db.run(`INSERT INTO sync_profiles (id,name,serverUrl,remoteUserId,enabled,createdAt,updatedAt)
    VALUES ('phone','phone',?,?,1,'now','now')`, [serverUrl, USER]);
  await db.run("INSERT INTO sync_devices (profileId,deviceId,platform,createdAt) VALUES ('phone','phone-device','android','now')");
  const engine = new MobileSyncEngine({
    db, attachments: { remove: async () => undefined } as never, profileId: "phone", deviceId: "phone-device",
    serverUrl, token: USER, userId: USER,
  });
  engines.push(engine);
  const state = engine as unknown as { running: boolean; debounce: unknown };
  const idle = async () => {
    for (let quiet = 0; quiet < 4;) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      quiet = !state.running && !state.debounce ? quiet + 1 : 0;
    }
  };
  engine.start(); // 首次下载（Bootstrap）
  await idle();
  const target = noteIds[150];
  const before = (await db.query<{ version: number }>("SELECT version FROM notes WHERE id=?", [target]))[0];
  assert.ok(before, "phone downloaded the library");

  serverDb.prepare("UPDATE notes SET content='电脑上刚改的正文', contentText='电脑上刚改的正文', version=version+1, updatedAt=datetime('now') WHERE id=?").run(target);
  snapshotLog.length = 0;
  engine.requestSync(0); // 等同收到 sync.changed 通知
  await idle();
  const after = (await db.query<{ content: string; version: number }>("SELECT content, version FROM notes WHERE id=?", [target]))[0];
  assert.equal(after.content, "电脑上刚改的正文");
  assert.equal(after.version, before.version + 1);
  const downloaded = snapshotLog.flatMap((entry) => entry.noteIds);
  assert.deepEqual(downloaded, [target], `phone downloaded only the changed note (requests=${snapshotLog.length})`);
});
