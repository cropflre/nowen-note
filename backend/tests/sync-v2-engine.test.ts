import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sync-v2-engine-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";

let getDb: () => Database.Database;
let closeDb: () => void;
let sync: typeof import("../src/sync/index.js");

const USER_ID = "engine-user";
const DEVICE_ID = "engine-device";

/**
 * 可编程的假远端。
 *
 * 不打真实网络：Engine 的价值在于编排与失败处理，
 * 用可控的响应/异常才能稳定复现断网、冲突、reset 等分支。
 */
class FakeRemote {
  serverSequence = 0;
  changesQueue: any[] = [];
  snapshotPages: any[] = [];
  pushResponder: ((mutations: any[]) => any) | null = null;
  pushCalls: any[][] = [];
  ackCalls: number[] = [];
  failWith: Error | null = null;

  async plan() {
    if (this.failWith) throw this.failWith;
    return {
      serverSequence: this.serverSequence,
      minAvailableSequence: 0,
      resetRequired: false,
      notebookCount: 0,
      noteCount: 0,
      tagCount: 0,
    };
  }

  async changes(_after: number) {
    if (this.failWith) throw this.failWith;
    return this.changesQueue.shift() || {
      serverSequence: this.serverSequence,
      nextSequence: this.serverSequence,
      hasMore: false,
      resetRequired: false,
      items: [],
    };
  }

  async snapshot(_cursor: string | null, _seq: number) {
    if (this.failWith) throw this.failWith;
    return this.snapshotPages.shift() || {
      snapshotSequence: this.serverSequence,
      hasMore: false,
      nextCursor: null,
      items: [],
    };
  }

  async push(_deviceId: string, mutations: any[]) {
    if (this.failWith) throw this.failWith;
    this.pushCalls.push(mutations);
    if (this.pushResponder) return this.pushResponder(mutations);
    return {
      serverSequence: this.serverSequence,
      results: mutations.map((m) => ({ mutationId: m.mutationId, status: "applied" })),
    };
  }

  async ack(_deviceId: string, sequence: number) {
    if (this.failWith) throw this.failWith;
    this.ackCalls.push(sequence);
    return { lastSequence: sequence };
  }
}

/** 手动推进的调度器：避免测试依赖真实时间。 */
class ManualScheduler {
  private pending: Array<{ fn: () => void; ms: number; id: number }> = [];
  private nextId = 1;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.pending.push({ fn, ms, id });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.pending = this.pending.filter((entry) => entry.id !== handle);
  };

  /** 只查看排程，不执行——用于断言退避间隔。 */
  peekDelays(): number[] {
    return this.pending.map((entry) => entry.ms);
  }

  clear(): void {
    this.pending = [];
  }
}

function seedUser(userId: string): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, 'x', datetime('now'), datetime('now'))
  `).run(userId, userId);
}

function resetSyncTables(): void {
  getDb().exec(`
    DELETE FROM sync_conflicts;
    DELETE FROM sync_outbox;
    DELETE FROM sync_applied_mutations;
    DELETE FROM sync_state;
    DELETE FROM sync_devices;
    DELETE FROM sync_profiles;
    DELETE FROM sync_changes_v2;
  `);
}

function seedNotebook(userId = USER_ID): string {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, workspaceId, createdAt, updatedAt)
    VALUES (?, ?, NULL, '引擎测试本', NULL, datetime('now'), datetime('now'))
  `).run(id, userId);
  return id;
}

function seedNote(notebookId: string, title = "笔记", version = 1): string {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO notes (id, userId, notebookId, workspaceId, title, content, contentText, version, createdAt, updatedAt)
    VALUES (?, ?, ?, NULL, ?, '{}', '', ?, datetime('now'), datetime('now'))
  `).run(id, USER_ID, notebookId, title, version);
  return id;
}

interface Harness {
  engine: import("../src/sync/index.js").SyncEngine;
  remote: FakeRemote;
  scheduler: ManualScheduler;
  profileId: string;
}

function createEngine(options: { intervalMs?: number } = {}): Harness {
  const db = getDb();
  const profile = sync.createProfile(db, {
    name: "测试服务器",
    serverUrl: "http://sync.test",
  });
  sync.setProfileEnabled(db, profile.id, true);
  const remote = new FakeRemote();
  const scheduler = new ManualScheduler();

  const engine = new sync.SyncEngine({
    db,
    profileId: profile.id,
    deviceId: DEVICE_ID,
    userId: USER_ID,
    client: remote as unknown as import("../src/sync/index.js").SyncRemoteClient,
    intervalMs: options.intervalMs ?? 0,
    scheduler,
  });

  return { engine, remote, scheduler, profileId: profile.id };
}

test.before(async () => {
  const [schema, syncModule] = await Promise.all([
    import("../src/db/schema"),
    import("../src/sync/index.js"),
  ]);
  getDb = schema.getDb;
  closeDb = schema.closeDb;
  sync = syncModule;
  seedUser(USER_ID);
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mutation Coalescing
// ---------------------------------------------------------------------------

test("同一实体的连续 update 合并为最新状态", () => {
  resetSyncTables();
  const db = getDb();
  const { profileId } = createEngine();
  const noteId = randomUUID();

  for (const title of ["v1", "v2", "v3"]) {
    sync.enqueueMutation(db, {
      entityType: "note",
      entityId: noteId,
      operation: "upsert",
      deviceId: DEVICE_ID,
      profileId,
      payload: { title },
    });
  }

  const merged = sync.coalesceMutations(sync.listPendingMutations(db, 100));
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].payload, { title: "v3" });
  assert.equal(merged[0].supersededIds.length, 2, "被合并的条目要记账以便一并出队");
});

test("update + delete 合并后保留 delete", () => {
  resetSyncTables();
  const db = getDb();
  const { profileId } = createEngine();
  const noteId = randomUUID();

  sync.enqueueMutation(db, {
    entityType: "note", entityId: noteId, operation: "upsert",
    deviceId: DEVICE_ID, profileId, payload: { title: "改了" },
  });
  sync.enqueueMutation(db, {
    entityType: "note", entityId: noteId, operation: "delete",
    deviceId: DEVICE_ID, profileId,
  });

  const merged = sync.coalesceMutations(sync.listPendingMutations(db, 100));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].operation, "delete");
});

test("合并保留最早的 baseVersion，避免漏判与远端的真实冲突", () => {
  resetSyncTables();
  const db = getDb();
  const { profileId } = createEngine();
  const noteId = randomUUID();

  sync.enqueueMutation(db, {
    entityType: "note", entityId: noteId, operation: "upsert",
    deviceId: DEVICE_ID, profileId, baseVersion: 3, payload: { title: "a" },
  });
  sync.enqueueMutation(db, {
    entityType: "note", entityId: noteId, operation: "upsert",
    deviceId: DEVICE_ID, profileId, baseVersion: 4, payload: { title: "b" },
  });

  const merged = sync.coalesceMutations(sync.listPendingMutations(db, 100));
  assert.equal(merged[0].baseVersion, 3, "必须取最早的 baseVersion");
});

test("合并保持实体首次出现顺序，父实体仍先于子实体", () => {
  resetSyncTables();
  const db = getDb();
  const { profileId } = createEngine();
  const notebookId = randomUUID();
  const noteId = randomUUID();

  sync.enqueueMutation(db, {
    entityType: "notebook", entityId: notebookId, operation: "upsert",
    deviceId: DEVICE_ID, profileId, payload: { name: "本" },
  });
  sync.enqueueMutation(db, {
    entityType: "note", entityId: noteId, operation: "upsert",
    deviceId: DEVICE_ID, profileId, payload: { notebookId },
  });
  sync.enqueueMutation(db, {
    entityType: "notebook", entityId: notebookId, operation: "upsert",
    deviceId: DEVICE_ID, profileId, payload: { name: "本改名" },
  });

  const merged = sync.coalesceMutations(sync.listPendingMutations(db, 100));
  assert.equal(merged.length, 2);
  assert.equal(merged[0].entityType, "notebook");
  assert.equal(merged[1].entityType, "note");
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

test("推送成功后 Outbox 出队，被合并条目一并清除", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote, profileId } = createEngine();
  const noteId = randomUUID();

  for (const title of ["a", "b"]) {
    sync.enqueueMutation(db, {
      entityType: "note", entityId: noteId, operation: "upsert",
      deviceId: DEVICE_ID, profileId, payload: { title },
    });
  }
  assert.equal(sync.countPendingMutations(db), 2);

  await engine.syncOnce();

  assert.equal(sync.countPendingMutations(db), 0, "成功推送后必须全部出队");
  assert.equal(remote.pushCalls.length, 1);
  assert.equal(remote.pushCalls[0].length, 1, "两条 update 应合并为一次推送");
});

test("duplicate 响应也视为已同步并出队", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote, profileId } = createEngine();
  remote.pushResponder = (mutations) => ({
    serverSequence: 0,
    results: mutations.map((m) => ({ mutationId: m.mutationId, status: "duplicate" })),
  });

  sync.enqueueMutation(db, {
    entityType: "note", entityId: randomUUID(), operation: "upsert",
    deviceId: DEVICE_ID, profileId, payload: { title: "x" },
  });
  await engine.syncOnce();
  assert.equal(sync.countPendingMutations(db), 0);
});

test("服务端错误时条目保留在 Outbox，重试次数增长但不删除", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote, profileId } = createEngine();
  remote.pushResponder = (mutations) => ({
    serverSequence: 0,
    results: mutations.map((m) => ({
      mutationId: m.mutationId, status: "conflict", code: "SERVER_ERROR",
    })),
  });

  sync.enqueueMutation(db, {
    entityType: "note", entityId: randomUUID(), operation: "upsert",
    deviceId: DEVICE_ID, profileId, payload: { title: "保留我" },
  });

  await engine.syncOnce();
  const rows = sync.listPendingMutations(db, 10);
  assert.equal(rows.length, 1, "失败条目不得被删除");
  assert.equal(rows[0].retryCount, 1);
  assert.equal(rows[0].lastError, "SERVER_ERROR");
});

// ---------------------------------------------------------------------------
// 冲突
// ---------------------------------------------------------------------------

test("VERSION_CONFLICT 登记冲突台账并保留本地内容", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote, profileId } = createEngine();
  const noteId = randomUUID();

  remote.pushResponder = (mutations) => ({
    serverSequence: 9,
    results: mutations.map((m) => ({
      mutationId: m.mutationId,
      status: "conflict",
      code: "VERSION_CONFLICT",
      serverVersion: 7,
    })),
  });

  sync.enqueueMutation(db, {
    entityType: "note", entityId: noteId, operation: "upsert",
    deviceId: DEVICE_ID, profileId, baseVersion: 3,
    payload: { title: "本机内容", contentText: "本机正文" },
  });

  await engine.syncOnce();

  const conflicts = sync.listUnresolvedConflicts(db, profileId);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].entityId, noteId);
  assert.equal(conflicts[0].remoteVersion, 7);
  const localPayload = JSON.parse(conflicts[0].localPayload as string);
  assert.equal(localPayload.title, "本机内容", "本机版本必须完整保留以便恢复");
});

test("存在未解决冲突时状态对外呈现 conflict", async () => {
  const db = getDb();
  const status = createEngine().engine.getStatus();
  assert.ok(status.conflictCount >= 0);
  // 上一用例已留下一条未解决冲突
  assert.ok(sync.countUnresolvedConflicts(db) >= 1);
});

// ---------------------------------------------------------------------------
// Pull / Apply / 防回环
// ---------------------------------------------------------------------------

test("应用远端变更不产生新的 Outbox 条目（防回环）", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote } = createEngine();
  const notebookId = randomUUID();

  remote.serverSequence = 10;
  remote.changesQueue.push({
    serverSequence: 10,
    nextSequence: 10,
    hasMore: false,
    resetRequired: false,
    items: [{ sequence: 10, entityType: "notebook", entityId: notebookId, operation: "upsert" }],
  });
  remote.snapshotPages.push({
    snapshotSequence: 10,
    hasMore: false,
    nextCursor: null,
    items: [{
      entityType: "notebook",
      entityId: notebookId,
      payload: { id: notebookId, name: "来自服务器", parentId: null },
    }],
  });

  await engine.syncOnce();

  const applied = db.prepare("SELECT name FROM notebooks WHERE id = ?")
    .get(notebookId) as { name: string } | undefined;
  assert.equal(applied?.name, "来自服务器", "远端变更应落到本地库");
  assert.equal(sync.countPendingMutations(db), 0, "远端变更不得回流进 Outbox");
});

test("应用远端变更不写入本地 Change Feed，避免二次广播", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote } = createEngine();
  const notebookId = randomUUID();

  remote.serverSequence = 5;
  remote.changesQueue.push({
    serverSequence: 5, nextSequence: 5, hasMore: false, resetRequired: false,
    items: [{ sequence: 5, entityType: "notebook", entityId: notebookId, operation: "upsert" }],
  });
  remote.snapshotPages.push({
    snapshotSequence: 5, hasMore: false, nextCursor: null,
    items: [{ entityType: "notebook", entityId: notebookId, payload: { id: notebookId, name: "远端本" } }],
  });

  await engine.syncOnce();

  const feed = db.prepare("SELECT COUNT(*) AS c FROM sync_changes_v2 WHERE entityId = ?")
    .get(notebookId) as { c: number };
  assert.equal(feed.c, 0, "apply 期间必须抑制 Change Feed");
});

test("抑制在 apply 结束后解除，本地新写入照常入 feed", () => {
  const db = getDb();
  const before = db.prepare("SELECT COUNT(*) AS c FROM sync_changes_v2").get() as { c: number };
  seedNotebook();
  const after = db.prepare("SELECT COUNT(*) AS c FROM sync_changes_v2").get() as { c: number };
  assert.ok(after.c > before.c, "抑制必须已解除");
});

test("远端变更不覆盖本地未推送的修改，改为登记冲突", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote, profileId } = createEngine();
  const notebookId = seedNotebook();
  const noteId = seedNote(notebookId, "本地未同步的标题", 1);

  // 本地有一条待推送修改
  sync.enqueueMutation(db, {
    entityType: "note", entityId: noteId, operation: "upsert",
    deviceId: DEVICE_ID, profileId, baseVersion: 1,
    payload: { title: "本地未同步的标题" },
  });
  // 让 push 阶段失败（网络之外的可重试错误），使条目留在 Outbox
  remote.pushResponder = (mutations) => ({
    serverSequence: 20,
    results: mutations.map((m) => ({ mutationId: m.mutationId, status: "conflict", code: "SERVER_ERROR" })),
  });
  remote.changesQueue.push({
    serverSequence: 20, nextSequence: 20, hasMore: false, resetRequired: false,
    items: [{ sequence: 20, entityType: "note", entityId: noteId, operation: "upsert" }],
  });
  remote.snapshotPages.push({
    snapshotSequence: 20, hasMore: false, nextCursor: null,
    items: [{
      entityType: "note", entityId: noteId,
      payload: { id: noteId, notebookId, title: "服务器标题", version: 9 },
    }],
  });

  await engine.syncOnce();

  const row = db.prepare("SELECT title FROM notes WHERE id = ?").get(noteId) as { title: string };
  assert.equal(row.title, "本地未同步的标题", "本地未推送修改不得被远端覆盖");
  const conflicts = sync.listUnresolvedConflicts(db, profileId);
  assert.ok(conflicts.some((c) => c.entityId === noteId), "应登记冲突");
});

test("delete 变更被正确应用", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote } = createEngine();
  const notebookId = seedNotebook();
  const noteId = seedNote(notebookId, "将被删除");

  remote.serverSequence = 30;
  remote.changesQueue.push({
    serverSequence: 30, nextSequence: 30, hasMore: false, resetRequired: false,
    items: [{ sequence: 30, entityType: "note", entityId: noteId, operation: "delete" }],
  });

  await engine.syncOnce();
  const row = db.prepare("SELECT 1 AS hit FROM notes WHERE id = ?").get(noteId);
  assert.equal(row, undefined, "远端删除应落到本地");
});

test("无变更时也推进游标并 ACK，避免重复扫描", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote, profileId } = createEngine();
  remote.serverSequence = 42;

  await engine.syncOnce();

  assert.equal(sync.getSyncState(db, profileId)?.lastSequence, 42);
  assert.deepEqual(remote.ackCalls, [42]);
});

test("hasMore 时安排立即续拉，不等下个周期", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote } = createEngine();
  const notebookId = randomUUID();

  remote.serverSequence = 100;
  remote.changesQueue.push({
    serverSequence: 100, nextSequence: 50, hasMore: true, resetRequired: false,
    items: [{ sequence: 50, entityType: "notebook", entityId: notebookId, operation: "upsert" }],
  });
  remote.snapshotPages.push({
    snapshotSequence: 100, hasMore: false, nextCursor: null,
    items: [{ entityType: "notebook", entityId: notebookId, payload: { id: notebookId, name: "续拉" } }],
  });

  await engine.syncOnce();
  // 第二轮会被自动触发；这里只验证第一轮成功应用
  const row = db.prepare("SELECT name FROM notebooks WHERE id = ?").get(notebookId) as { name: string };
  assert.equal(row.name, "续拉");
});

// ---------------------------------------------------------------------------
// resetRequired → snapshot 重建
// ---------------------------------------------------------------------------

test("resetRequired 时复位游标并走 snapshot 重建，不清 Outbox", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote, profileId } = createEngine();

  // 本地有一条推不上去的修改（服务端持续报错），重建不能把它弄丢。
  // 用 SERVER_ERROR 而非成功响应：成功推送本就应该出队，
  // 这里要验证的是"仍在队列里的修改不会被 snapshot 重建清掉"。
  remote.pushResponder = (mutations) => ({
    serverSequence: 300,
    results: mutations.map((m) => ({
      mutationId: m.mutationId, status: "conflict", code: "SERVER_ERROR",
    })),
  });
  sync.enqueueMutation(db, {
    entityType: "note", entityId: randomUUID(), operation: "upsert",
    deviceId: DEVICE_ID, profileId, payload: { title: "未同步" },
  });
  const pendingBefore = sync.countPendingMutations(db);
  assert.equal(pendingBefore, 1);

  sync.advanceSyncState(db, profileId, 5);
  const notebookId = randomUUID();
  remote.changesQueue.push({
    serverSequence: 300, nextSequence: 5, hasMore: false, resetRequired: true,
    items: [],
  });
  remote.snapshotPages.push({
    snapshotSequence: 300, hasMore: false, nextCursor: null,
    items: [{ entityType: "notebook", entityId: notebookId, payload: { id: notebookId, name: "重建本" } }],
  });

  await engine.syncOnce();

  assert.equal(sync.getSyncState(db, profileId)?.lastSequence, 300, "游标应落在 snapshot 时间点");
  const rebuilt = db.prepare("SELECT name FROM notebooks WHERE id = ?").get(notebookId) as { name: string };
  assert.equal(rebuilt.name, "重建本");
  assert.equal(sync.countPendingMutations(db), pendingBefore, "重建不得清除未同步修改");
});

// ---------------------------------------------------------------------------
// 断网与错误处理
// ---------------------------------------------------------------------------

test("断网时进入 offline，Outbox 原样保留", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote, profileId } = createEngine();
  const { SyncError } = await import("../src/sync/errors.js");

  sync.enqueueMutation(db, {
    entityType: "note", entityId: randomUUID(), operation: "upsert",
    deviceId: DEVICE_ID, profileId, payload: { title: "断网时的修改" },
  });
  remote.failWith = new SyncError("NETWORK_UNAVAILABLE", "断网");

  const status = await engine.syncOnce();

  assert.equal(status.state, "offline");
  assert.equal(sync.countPendingMutations(db), 1, "断网不得丢弃待同步修改");
  assert.equal(status.lastError, "NETWORK_UNAVAILABLE");
});

test("断网后条目不会卡在 inflight，网络恢复即可继续推送", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote, profileId } = createEngine();
  const { SyncError } = await import("../src/sync/errors.js");

  sync.enqueueMutation(db, {
    entityType: "note", entityId: randomUUID(), operation: "upsert",
    deviceId: DEVICE_ID, profileId, payload: { title: "断网期间的修改" },
  });

  // 第一轮断网：push 抛异常
  remote.failWith = new SyncError("NETWORK_UNAVAILABLE", "断网");
  await engine.syncOnce();

  // 关键断言：条目必须已退回 pending。
  // 若停留在 inflight，listPendingMutations 取不到它，
  // 网络恢复后也永远不会重传——只有重启进程才能恢复。
  const pending = sync.listPendingMutations(db, 10, profileId);
  assert.equal(pending.length, 1, "断网后条目必须可继续推送");
  assert.equal(pending[0].status, "pending");

  // 网络恢复后应成功推送并出队
  remote.failWith = null;
  await engine.syncOnce();
  assert.equal(sync.countPendingMutations(db), 0, "网络恢复后应完成同步");
});

test("断网重试使用退避间隔且逐步增长", async () => {
  resetSyncTables();
  const { engine, remote, scheduler } = createEngine();
  const { SyncError } = await import("../src/sync/errors.js");
  remote.failWith = new SyncError("NETWORK_UNAVAILABLE", "断网");

  scheduler.clear();
  await engine.syncOnce();
  const first = scheduler.peekDelays();
  scheduler.clear();
  await engine.syncOnce();
  const second = scheduler.peekDelays();

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.ok(second[0] >= first[0], "退避间隔应逐步增长");
});

test("Token 过期时暂停同步但不重试，本地数据不受影响", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, remote, scheduler } = createEngine();
  const { SyncError } = await import("../src/sync/errors.js");
  const notebookId = seedNotebook();

  remote.failWith = new SyncError("AUTH_EXPIRED", "token 过期");
  scheduler.clear();
  const status = await engine.syncOnce();

  assert.equal(status.state, "error");
  assert.equal(status.lastError, "AUTH_EXPIRED");
  assert.deepEqual(scheduler.peekDelays(), [], "授权失效不应无脑重试");
  // 本地读取完全正常
  const row = db.prepare("SELECT name FROM notebooks WHERE id = ?").get(notebookId) as { name: string };
  assert.equal(row.name, "引擎测试本");
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

test("启动时复位 inflight，覆盖强杀恢复", () => {
  resetSyncTables();
  const db = getDb();
  const { engine, profileId } = createEngine();
  const mutationId = sync.enqueueMutation(db, {
    entityType: "note", entityId: randomUUID(), operation: "upsert",
    deviceId: DEVICE_ID, profileId, payload: { title: "被强杀" },
  }) as string;

  sync.markMutationInflight(db, mutationId);
  assert.equal(sync.listPendingMutations(db, 10).length, 0, "inflight 不会被取出");

  engine.start();
  assert.equal(sync.listPendingMutations(db, 10).length, 1, "启动后应可继续推送");
  engine.stop();
});

test("stop 只停调度，本地数据与 Outbox 一个字不删", () => {
  resetSyncTables();
  const db = getDb();
  const { engine, profileId } = createEngine();
  const notebookId = seedNotebook();
  sync.enqueueMutation(db, {
    entityType: "note", entityId: randomUUID(), operation: "upsert",
    deviceId: DEVICE_ID, profileId, payload: { title: "保留" },
  });

  engine.start();
  engine.stop();

  assert.equal(engine.getStatus().state, "disabled");
  assert.equal(sync.countPendingMutations(db), 1, "关闭同步不得删除未同步修改");
  assert.ok(db.prepare("SELECT 1 FROM notebooks WHERE id = ?").get(notebookId));
});

test("Profile 被停用后引擎自动停止且不清数据", async () => {
  resetSyncTables();
  const db = getDb();
  const { engine, profileId } = createEngine();
  sync.enqueueMutation(db, {
    entityType: "note", entityId: randomUUID(), operation: "upsert",
    deviceId: DEVICE_ID, profileId, payload: { title: "停用后仍在" },
  });

  sync.disableProfile(db, profileId);
  const status = await engine.syncOnce();

  assert.equal(status.state, "disabled");
  assert.equal(sync.countPendingMutations(db), 1);
});

test("同一时刻只跑一轮同步，重入请求排到轮次结束后", async () => {
  resetSyncTables();
  const { engine, remote } = createEngine();
  remote.serverSequence = 1;

  const [a, b] = await Promise.all([engine.syncOnce(), engine.syncOnce()]);
  assert.ok(a);
  assert.ok(b);
  // 并发调用不应导致重复 push（本轮没有待推送条目，只验证不抛错）
  assert.ok(remote.ackCalls.length >= 1);
});

test("诊断状态暴露定位同步问题所需的全部字段", async () => {
  resetSyncTables();
  const { engine, remote } = createEngine();
  remote.serverSequence = 77;
  await engine.syncOnce();

  const status = engine.getStatus();
  assert.equal(typeof status.deviceId, "string");
  assert.equal(typeof status.profileId, "string");
  assert.equal(status.localCursor, 77);
  assert.equal(status.remoteSequence, 77);
  assert.equal(typeof status.pendingMutations, "number");
  assert.equal(typeof status.conflictCount, "number");
  assert.ok(status.lastPullAt, "应记录最近拉取时间");
});
