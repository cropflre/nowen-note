/**
 * 电脑端编辑后手机端看不到 / 出现冲突（1.6.2 用户反馈）的回归用例。
 *
 * 本文件里 getDb() 是桌面端内嵌后端的本机库：真实的笔记 REST 路由、真实的 SyncEngine、
 * 真实的 Yjs 房间与本机笔记联动（installLocalNoteSyncHooks）。服务端是另一份 SQLite，
 * 推送用真实的 applyMutation 落库，Change Feed 直接读它自己的 sync_changes_v2。
 *
 * 覆盖的三处根因：
 *   1. 本机保存后要等 60 秒周期才推送，手机这段时间打开的都是旧内容；
 *   2. 合并推送确认把本机版本号改成服务端版本号后，打开的富文本编辑器下一次保存被判 409；
 *   3. Markdown 由本机 Yjs 房间落盘：确认改号后房间基线过期，之后的输入不再写入 notes、也不再同步；
 *      拉到其他设备的修改也不会进入打开着的房间。
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import * as Y from "yjs";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-desktop-phone-"));
process.env.DB_PATH = path.join(tmpDir, "desktop.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";

const USER = "desktop-phone-user";
const DEVICE = "desktop-device";

let getDb: () => Database.Database;
let closeDb: () => void;
let sync: typeof import("../src/sync/index.js");
let bridge: typeof import("../src/sync/localNoteBridge");
let yjs: typeof import("../src/services/yjs");
let applyMutation: typeof import("../src/sync/apply").applyMutation;
let installLocalNoteSyncHooks: () => void;
let notesApp: Hono;
let serverDb: Database.Database;
let profileId = "";
let notebookId = "";
const engines: Array<{ stop(): void }> = [];

/** 遵循真实协议语义的服务端：推送经 applyMutation 落库，Feed 与 Snapshot 读服务端库。 */
class ServerSim {
  cycles = 0;
  pushCalls: Array<Array<Record<string, any>>> = [];
  snapshotRequests: Array<{ cursor: string | null; limit?: number }> = [];
  failWith: Error | null = null;

  private sequence(): number {
    return Number((serverDb.prepare("SELECT MAX(sequence) AS s FROM sync_changes_v2").get() as { s: number | null }).s || 0);
  }

  async listScopes() {
    this.cycles += 1;
    if (this.failWith) throw this.failWith;
    return [{ scopeKey: "personal", workspaceId: null, workspaceName: null, role: "owner", canWrite: true, accessFingerprint: "personal:owner" }];
  }

  async plan(_after: number, _scopeKey?: string, subscription?: unknown) {
    if (this.failWith) throw this.failWith;
    // 不协商知识树订阅的旧服务器：知识树条目留在 Outbox，用来验证它们不会让引擎空转。
    if (subscription) throw new sync.SyncError("INVALID_PAYLOAD", "当前同步协议不支持请求的实体集合");
    return { serverSequence: this.sequence(), minAvailableSequence: 0, resetRequired: false, notebookCount: 0, noteCount: 0, tagCount: 0 };
  }

  async push(deviceId: string, mutations: Array<Record<string, any>>) {
    if (this.failWith) throw this.failWith;
    this.pushCalls.push(mutations);
    const results = mutations.map((m) => {
      try {
        return serverDb.transaction(() => applyMutation(serverDb, { ...m, userId: USER, deviceId } as never))();
      } catch (error) {
        const code = (error as { code?: string }).code || "SERVER_ERROR";
        const server = serverDb.prepare("SELECT * FROM notes WHERE id=?").get(m.entityId) as Record<string, unknown> | undefined;
        return { mutationId: m.mutationId, status: "conflict", code, serverVersion: server?.version, serverPayload: server };
      }
    });
    return { scopeKey: "personal", accessFingerprint: "personal:owner", serverSequence: this.sequence(), results };
  }

  async changes(after: number) {
    if (this.failWith) throw this.failWith;
    const items = serverDb.prepare(`SELECT sequence, entityType, entityId, operation, version FROM sync_changes_v2
      WHERE sequence > ? AND entityType IN ('notebook','tag','note','note_tag','favorite','attachment','task','task_reminder','diary','mindmap')
      ORDER BY sequence`).all(after);
    const serverSequence = this.sequence();
    return { scopeKey: "personal", accessFingerprint: "personal:owner", serverSequence, nextSequence: serverSequence, hasMore: false, resetRequired: false, items };
  }

  /** 与 routes/sync-v2.ts 相同的游标语义：`<类型>:<id>` 之后按 id 升序，跨类型首尾相接。 */
  async snapshot(cursor: string | null, _sequence: number, limit = 200, _scopeKey?: string, subscription?: unknown) {
    if (this.failWith) throw this.failWith;
    if (subscription) throw new sync.SyncError("INVALID_PAYLOAD", "当前同步协议不支持请求的实体集合");
    this.snapshotRequests.push({ cursor, limit });
    const order = ["notebook", "tag", "note"];
    const separator = cursor ? cursor.indexOf(":") : -1;
    let typeIndex = separator > 0 ? Math.max(0, order.indexOf(cursor!.slice(0, separator))) : 0;
    let afterId = separator > 0 ? cursor!.slice(separator + 1) : "";
    const items: Array<{ entityType: string; entityId: string; payload: Record<string, unknown> }> = [];
    let nextCursor: string | null = null;
    while (typeIndex < order.length && items.length < limit) {
      const type = order[typeIndex];
      const rows = type === "note"
        ? serverDb.prepare(`SELECT id, userId, notebookId, title, content, contentText, contentFormat, isPinned, isFavorite,
            isLocked, isArchived, isTrashed, trashedAt, version, sortOrder, createdAt, updatedAt, workspaceId
            FROM notes WHERE userId=? AND id > ? ORDER BY id LIMIT ?`).all(USER, afterId, limit - items.length) as Array<Record<string, unknown>>
        : [];
      for (const row of rows) items.push({ entityType: type, entityId: String(row.id), payload: row });
      if (items.length >= limit) { nextCursor = `${type}:${items.at(-1)!.entityId}`; break; }
      typeIndex += 1;
      afterId = "";
    }
    return { scopeKey: "personal", accessFingerprint: "personal:owner", snapshotSequence: this.sequence(), hasMore: nextCursor !== null, nextCursor, items };
  }

  async ack(_deviceId: string, sequence: number) { return { lastSequence: sequence }; }
}

function createEngine(server: ServerSim, options: { intervalMs?: number; localChangePollMs?: number; localChangeDelayMs?: number } = {}) {
  const engine = new sync.SyncEngine({
    db: getDb(), profileId, deviceId: DEVICE, userId: USER,
    client: server as unknown as import("../src/sync/index.js").SyncRemoteClient,
    intervalMs: options.intervalMs ?? 0,
    localChangePollMs: options.localChangePollMs,
    localChangeDelayMs: options.localChangeDelayMs,
  });
  engines.push(engine);
  return engine;
}

async function rest(method: string, pathname: string, body?: unknown) {
  const response = await notesApp.request(pathname, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function doc(text: string): string {
  return JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
}

async function createSyncedNote(engine: InstanceType<typeof sync.SyncEngine>, title: string, contentFormat = "tiptap-json", content = doc(title)) {
  const created = await rest("POST", "/", { notebookId, title, content, contentText: title, contentFormat });
  assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created.body));
  await engine.syncOnce();
  const server = serverDb.prepare("SELECT version FROM notes WHERE id=?").get(created.body.id) as { version: number } | undefined;
  assert.ok(server, "note reached the server");
  return created.body as { id: string; version: number; title: string };
}

function localNote(id: string) {
  return getDb().prepare("SELECT version, content, title FROM notes WHERE id=?").get(id) as { version: number; content: string; title: string };
}

function noteConflicts(id: string): number {
  return sync.listUnresolvedConflicts(getDb(), profileId).filter((row) => row.entityType === "note" && row.entityId === id).length;
}

function serverNote(id: string) {
  return serverDb.prepare("SELECT version, content, title FROM notes WHERE id=?").get(id) as { version: number; content: string; title: string };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 模拟打开中的 Markdown 编辑器：加入本机 Yjs 房间并键入（与 y-codemirror 发出的 update 相同）。 */
function openMarkdownRoom(noteId: string) {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Buffer.from(yjs.yJoin(noteId, USER).stateBase64, "base64"));
  return {
    type(chunk: string) {
      const before = Y.encodeStateVector(ydoc);
      const text = ydoc.getText("content");
      text.insert(text.length, chunk);
      assert.equal(yjs.yApplyUpdate(noteId, Buffer.from(Y.encodeStateAsUpdate(ydoc, before)).toString("base64"), USER), "ok");
    },
    roomText() {
      const probe = new Y.Doc();
      Y.applyUpdate(probe, Buffer.from(yjs.yJoin(noteId, USER).stateBase64, "base64"));
      yjs.yLeave(noteId);
      return probe.getText("content").toString();
    },
    close() { yjs.yLeave(noteId); ydoc.destroy(); },
  };
}

test.before(async () => {
  const schema = await import("../src/db/schema");
  getDb = schema.getDb;
  closeDb = schema.closeDb;
  sync = await import("../src/sync/index.js");
  bridge = await import("../src/sync/localNoteBridge");
  yjs = await import("../src/services/yjs");
  applyMutation = (await import("../src/sync/apply")).applyMutation;
  installLocalNoteSyncHooks = (await import("../src/services/localNoteSyncHooks")).installLocalNoteSyncHooks;
  const noteRoutes = (await import("../src/routes/notes")).default;
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash, createdAt, updatedAt) VALUES (?, ?, 'x', datetime('now'), datetime('now'))").run(USER, USER);
  notebookId = randomUUID();
  db.prepare("INSERT INTO notebooks (id, userId, name, createdAt, updatedAt) VALUES (?, ?, '电脑手机同步', datetime('now'), datetime('now'))").run(notebookId, USER);

  // 同一份 schema 与目录的服务端库（在开启同步前复制，避免服务端带上本机的同步 Profile）。
  const serverPath = path.join(tmpDir, "server.db");
  await db.backup(serverPath);
  serverDb = new Database(serverPath);
  serverDb.pragma("foreign_keys = ON");
  (await import("../src/lib/searchIndex")).ensureNormalizedSearchFts(serverDb);
  serverDb.exec("DELETE FROM sync_changes_v2");

  const profile = sync.createProfile(db, { name: "NAS", serverUrl: "http://nas.test" });
  profileId = profile.id;
  sync.switchActiveProfile(db, profileId);
  db.prepare(`INSERT INTO sync_workspace_scopes (profileId, scopeKey, workspaceId, workspaceName, role, canWrite, accessFingerprint, accessStatus, updatedAt)
    VALUES (?, 'personal', NULL, NULL, 'owner', 1, 'personal:owner', 'active', datetime('now'))`).run(profileId);
  db.prepare(`INSERT INTO sync_state (profileId, scopeKey, lastSequence, accessFingerprint, accessStatus, accessChangedAt)
    VALUES (?, 'personal', 0, 'personal:owner', 'active', datetime('now'))`).run(profileId);
  sync.ensureDevice(db, { profileId, platform: "darwin" });
  sync.markBootstrapReady(db, profileId, 0);

  notesApp = new Hono();
  notesApp.use("*", async (c, next) => { c.req.raw.headers.set("X-User-Id", USER); await next(); });
  notesApp.route("/", noteRoutes);
});

test.afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  bridge.setLocalNoteHooks(null);
  bridge.resetNoteVersionRebasesForTests();
});

test.after(() => {
  serverDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("DCC-002: a desktop save reaches the server within seconds instead of waiting for the 60-second sync interval", async () => {
  const server = new ServerSim();
  const setup = createEngine(server);
  const note = await createSyncedNote(setup, "电脑上新建");
  setup.stop();

  // 生产默认：60 秒周期；本地新写入检测改用很短的间隔，便于在测试里观察。
  const engine = createEngine(server, { intervalMs: 60_000, localChangePollMs: 20, localChangeDelayMs: 20 });
  engine.start();
  await waitFor(() => server.cycles >= 2 && engine.getStatus().state !== "syncing", 2000, "first cycle");
  const pushesBefore = server.pushCalls.length;

  const saved = await rest("PUT", `/${note.id}`, { title: note.title, content: doc("电脑上刚改完"), contentText: "电脑上刚改完", version: note.version, contentFormat: "tiptap-json" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const savedAt = Date.now();
  await waitFor(() => serverNote(note.id).content.includes("电脑上刚改完"), 2000, "desktop edit reaches the server");
  assert.ok(Date.now() - savedAt < 2000, "无需等 60 秒周期");
  assert.ok(server.pushCalls.length > pushesBefore);
});

test("DCC-003: early pushes keep the offline backoff and do not loop on outbox rows the engine cannot send yet", async () => {
  const server = new ServerSim();
  const setup = createEngine(server);
  const note = await createSyncedNote(setup, "退避与空转");
  setup.stop();

  const engine = createEngine(server, { intervalMs: 60_000, localChangePollMs: 20, localChangeDelayMs: 20 });
  engine.start();
  await waitFor(() => server.cycles >= 2 && engine.getStatus().state !== "syncing", 2000, "first cycle");
  // 旧服务器不协商知识树：知识树条目推不出去，会一直留在 Outbox。
  const beforeUnsendable = server.cycles;
  sync.enqueueMutation(getDb(), {
    entityType: "knowledge_tree_node", entityId: `note:${note.id}`, operation: "upsert",
    deviceId: DEVICE, profileId, payload: { id: `note:${note.id}`, parentId: null, sortOrder: 9 },
  });
  // 新入队的条目带来一轮尝试；之后它已是已知条目，不再触发。
  await waitFor(() => server.cycles === beforeUnsendable + 1 && engine.getStatus().state !== "syncing", 2000, "one attempt");
  const settled = server.cycles;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(server.cycles, settled, "推不出去的条目最多带来一轮，引擎不空转");
  assert.ok(sync.countPendingMutations(getDb(), profileId) > 0, "the unsendable row stays queued");

  server.failWith = new sync.SyncError("NETWORK_UNAVAILABLE", "offline");
  engine.notifyNetworkOnline();
  await waitFor(() => engine.getStatus().state === "offline", 2000, "offline");
  const offlineCycles = server.cycles;
  const saved = await rest("PUT", `/${note.id}`, { title: note.title, content: doc("离线时的修改"), contentText: "离线时的修改", version: note.version, contentFormat: "tiptap-json" });
  assert.equal(saved.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(server.cycles, offlineCycles, "离线时新写入不提前重试，仍按退避节奏");
  assert.ok(getDb().prepare("SELECT 1 FROM sync_outbox WHERE profileId=? AND entityType='note' AND entityId=?").get(profileId, note.id), "offline edit stays queued");
  getDb().prepare("DELETE FROM sync_outbox WHERE profileId=? AND entityType='knowledge_tree_node'").run(profileId);
});

test("DCC-004: a coalesced push ACK keeps the open editor's version usable while a stale editor still gets 409", async () => {
  const server = new ServerSim();
  const engine = createEngine(server);
  const note = await createSyncedNote(engine, "合并推送改号");
  const rebases: Array<{ noteId: string; fromVersion: number; toVersion: number }> = [];
  bridge.setLocalNoteHooks({ flushNote: () => undefined, announceAppliedNotes: () => undefined, announceVersionRebase: (rebase) => rebases.push(rebase) });

  // 编辑器连续自动保存三次：本机版本 +3，推送时合并成一条，服务端只 +1。
  let editorVersion = localNote(note.id).version;
  for (const text of ["第一段", "第二段", "第三段"]) {
    const saved = await rest("PUT", `/${note.id}`, { title: note.title, content: doc(text), contentText: text, version: editorVersion, contentFormat: "tiptap-json", writeSource: "live-autosave" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    editorVersion = saved.body.version;
  }
  await engine.syncOnce();
  const afterAck = localNote(note.id).version;
  assert.equal(afterAck, serverNote(note.id).version, "本机版本号与服务端一致");
  assert.ok(afterAck < editorVersion, "fixture reproduces the lowered local version");

  // 改号通知送达前，编辑器仍带旧版本号保存：同一份正文，必须放行，不能只存进草稿。
  const continued = await rest("PUT", `/${note.id}`, { title: note.title, content: doc("推送后继续写"), contentText: "推送后继续写", version: editorVersion, contentFormat: "tiptap-json", writeSource: "live-autosave" });
  assert.equal(continued.status, 200, JSON.stringify(continued.body));
  assert.deepEqual(rebases, [{ noteId: note.id, fromVersion: editorVersion, toVersion: afterAck }], "编辑器收到改号通知");
  // 笔记之后已被改过：同一个旧版本号再次提交就是过期写入，仍然拒绝。
  const stale = await rest("PUT", `/${note.id}`, { title: note.title, content: doc("过期编辑器"), contentText: "过期编辑器", version: editorVersion, contentFormat: "tiptap-json" });
  assert.equal(stale.status, 409);
  assert.equal(localNote(note.id).content.includes("推送后继续写"), true);

  await engine.syncOnce();
  assert.ok(serverNote(note.id).content.includes("推送后继续写"), "继续写的内容同步到服务端");
  assert.equal(noteConflicts(note.id), 0);
});

test("DCC-002: Markdown typed after a push confirmation keeps saving and syncing through the desktop Yjs room", async () => {
  installLocalNoteSyncHooks();
  const server = new ServerSim();
  const engine = createEngine(server);
  const note = await createSyncedNote(engine, "MD 同步", "markdown", "起始");
  const room = openMarkdownRoom(note.id);
  try {
    for (const round of [1, 2, 3, 4]) {
      room.type(` 第${round}轮`);
      yjs.yFlush(note.id);
      assert.ok(localNote(note.id).content.includes(`第${round}轮`), `round ${round} is written to the local note`);
      await engine.syncOnce();
      assert.ok(serverNote(note.id).content.includes(`第${round}轮`), `round ${round} reaches the server`);
    }
    assert.equal(noteConflicts(note.id), 0);
  } finally {
    room.close();
  }
});

test("DCC-004: pulling another device's edit flushes unsaved desktop Yjs typing first and keeps both versions", async () => {
  installLocalNoteSyncHooks();
  const server = new ServerSim();
  const engine = createEngine(server);
  const note = await createSyncedNote(engine, "并发编辑", "markdown", "共同起点");
  const room = openMarkdownRoom(note.id);
  try {
    const base = serverNote(note.id).version;
    serverDb.transaction(() => applyMutation(serverDb, {
      mutationId: randomUUID(), deviceId: "phone", userId: USER, entityType: "note", entityId: note.id, operation: "upsert",
      baseVersion: base, payload: { notebookId, title: note.title, content: "手机上的修改", contentText: "手机上的修改", contentFormat: "markdown" },
    } as never))();
    room.type(" 电脑上尚未落盘的输入"); // 仍在 1.5 秒防抖里，没有进 Outbox
    await engine.syncOnce();
    const conflicts = sync.listUnresolvedConflicts(getDb(), profileId).filter((row) => row.entityId === note.id);
    assert.equal(conflicts.length, 1, "两端都改了：登记冲突而不是覆盖");
    assert.ok(localNote(note.id).content.includes("电脑上尚未落盘的输入"), "本机输入已落盘，没有被拉取覆盖");
    assert.ok(String(conflicts[0].remotePayload).includes("手机上的修改"), "服务端版本保留在冲突里");
  } finally {
    room.close();
  }
});

test("DCC-004: another device's edit replaces the open desktop Markdown room so typing continues without conflicts", async () => {
  installLocalNoteSyncHooks();
  const server = new ServerSim();
  const engine = createEngine(server);
  const note = await createSyncedNote(engine, "手机改完电脑接着写", "markdown", "电脑写的开头");
  const room = openMarkdownRoom(note.id);
  try {
    const base = serverNote(note.id).version;
    serverDb.transaction(() => applyMutation(serverDb, {
      mutationId: randomUUID(), deviceId: "phone", userId: USER, entityType: "note", entityId: note.id, operation: "upsert",
      baseVersion: base, payload: { notebookId, title: note.title, content: "手机改过的正文", contentText: "手机改过的正文", contentFormat: "markdown" },
    } as never))();
    await engine.syncOnce();
    assert.equal(localNote(note.id).content, "手机改过的正文");
    assert.equal(room.roomText(), "手机改过的正文", "打开着的房间换成了手机的修改");

    const editor = openMarkdownRoom(note.id); // 编辑器收到房间更新后继续输入
    try {
      editor.type(" + 电脑接着写");
      yjs.yFlush(note.id);
      await engine.syncOnce();
    } finally {
      editor.close();
    }
    assert.equal(serverNote(note.id).content, "手机改过的正文 + 电脑接着写");
    assert.equal(noteConflicts(note.id), 0);
  } finally {
    room.close();
  }
});
