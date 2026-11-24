import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, beforeEach } from "node:test";

import Database from "better-sqlite3";
import { Hono } from "hono";

import { getDb, getDbPath } from "../src/db/schema";
import { ensureNormalizedSearchFts } from "../src/lib/searchIndex";
import { installNotebookTreeIntegrityGuards } from "../src/runtime/notebook-tree-hardening";
import syncV2Routes from "../src/routes/sync-v2";
import { runBootstrap } from "../src/sync/bootstrap";
import { listUnresolvedConflicts } from "../src/sync/conflict";
import { ensureDevice } from "../src/sync/device";
import { SyncEngine } from "../src/sync/engine";
import { runLiteMigration, type LiteMigrationProgress } from "../src/sync/liteMigration";
import { countPendingMutations } from "../src/sync/outbox";
import { createProfile, getSyncState, switchActiveProfile } from "../src/sync/profile";
import { SyncRemoteClient, type FetchLike } from "../src/sync/remote";

/**
 * Windows 首次从 NAS 下载 → 断网编辑 → 重连上传 → 多端一致 的端到端验收。
 *
 * 这是自动化的真实证据，**不是** Windows 真机验收：
 *   - NAS：真实的 SQLite（完整 schema、全部生产触发器）+ 真实的 /api/sync/v2 路由；
 *   - Windows 本机：另一份独立的真实 SQLite（同一份 schema 与触发器守卫）；
 *   - 两者之间走 SyncRemoteClient → 路由，只是把 HTTP 换成进程内的 app.request。
 * 没有覆盖的部分：真实网络、Electron 进程与 IPC、安装包、附件二进制通道。
 */

const NAS_USER = "nas-user";
const WIN_USER = "windows-local-user";
const PHONE_USER = "second-device-local-user";
const SERVER_URL = "http://nas.test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-nas-acceptance-"));
let templatePath = "";
let nas: Database.Database;
let nasApp: Hono;
const opened: Database.Database[] = [];

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

before(() => {
  nas = getDb();
  installNotebookTreeIntegrityGuards(nas);
  // 此刻数据库只有迁移后的空 schema：复制出来，作为之后每台"本机"的初始库。
  nas.pragma("wal_checkpoint(TRUNCATE)");
  templatePath = path.join(tmpDir, "template.db");
  fs.copyFileSync(getDbPath(), templatePath);
  nas.prepare(`
    INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, 'x', datetime('now'), datetime('now'))
  `).run(NAS_USER, NAS_USER);

  nasApp = new Hono();
  nasApp.use("*", async (c, next) => {
    c.req.raw.headers.set("X-User-Id", NAS_USER);
    await next();
  });
  nasApp.route("/api/sync/v2", syncV2Routes);
});

let networkUp = true;
/** 篡改 NAS 返回的快照条目，用来制造"同一份数据怎么重试都会失败"的结构性故障。 */
let snapshotMutator: ((items: SnapshotItem[]) => void) | null = null;
/** 拦截推送：返回结果数组就直接作为服务端响应（不转发给 NAS），用来制造"上传失败、修改留在 Outbox"。 */
let pushInterceptor: ((mutations: Array<{ mutationId: string }>) => Array<Record<string, unknown>> | null) | null = null;
const requestLog: Array<{ method: string; path: string }> = [];

/** 进程内的 HTTP：路径、查询串、方法、请求体都原样经过真实路由。 */
const nasFetch: FetchLike = async (url, init) => {
  if (!networkUp) throw new TypeError("fetch failed（模拟断网）");
  const target = new URL(url);
  requestLog.push({ method: init?.method ?? "GET", path: target.pathname });
  if (pushInterceptor && target.pathname.endsWith("/push") && init?.body) {
    const results = pushInterceptor((JSON.parse(init.body) as { mutations: Array<{ mutationId: string }> }).mutations);
    if (results) {
      const body = { scopeKey: "personal", accessFingerprint: "personal:owner", serverSequence: 0, results };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
  }
  const response = await nasApp.request(`${target.pathname}${target.search}`, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  });
  if (snapshotMutator && target.pathname.endsWith("/snapshot") && response.ok) {
    const body = await response.json() as { items: SnapshotItem[] };
    snapshotMutator(body.items);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }
  return response as never;
};

function remoteClient(): SyncRemoteClient {
  return new SyncRemoteClient({ serverUrl: SERVER_URL, token: "test-token" }, { fetchImpl: nasFetch });
}

function openLocalDb(name: string, userId: string): Database.Database {
  const file = path.join(tmpDir, `${name}-${randomUUID().slice(0, 8)}.db`);
  fs.copyFileSync(templatePath, file);
  const local = new Database(file);
  local.pragma("foreign_keys = ON");
  // 与 getDb() 一致：笔记上的 FTS 触发器依赖连接级的自定义 SQL 函数，要先注册。
  ensureNormalizedSearchFts(local);
  installNotebookTreeIntegrityGuards(local);
  local.prepare(`
    INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, 'x', datetime('now'), datetime('now'))
  `).run(userId, userId);
  opened.push(local);
  return local;
}

beforeEach(() => {
  networkUp = true;
  snapshotMutator = null;
  pushInterceptor = null;
  requestLog.length = 0;
  nas.exec(`
    DELETE FROM note_tags; DELETE FROM favorites; DELETE FROM attachments; DELETE FROM notes;
    DELETE FROM tags; DELETE FROM notebooks;
  `);
});

// ---------------------------------------------------------------------------
// NAS 侧造数：手法与服务端自己的路由一致，保证数据形状真实
// ---------------------------------------------------------------------------

function nasNotebook(id: string, parentId: string | null, name = `目录-${id.slice(0, 4)}`): string {
  nas.prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, icon, sortOrder, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, '📒', 0, datetime('now'), datetime('now'))
  `).run(id, NAS_USER, parentId, name);
  return id;
}

function nasNote(notebookId: string, title: string, id = randomUUID()): string {
  nas.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version, sortOrder, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', ?, 'tiptap-json', 1, 0, datetime('now'), datetime('now'))
  `).run(id, NAS_USER, notebookId, title, `正文：${title}`);
  return id;
}

/** routes/notebooks.ts DELETE 的事务体：整棵子树只翻转 isDeleted，保留 parentId；其下笔记进回收站。 */
function nasDeleteSubtree(rootId: string): void {
  const ids = (nas.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM notebooks WHERE id = ? AND isDeleted = 0
      UNION ALL
      SELECT n.id FROM notebooks n JOIN sub ON n.parentId = sub.id WHERE n.isDeleted = 0
    ) SELECT id FROM sub
  `).all(rootId) as Array<{ id: string }>).map((entry) => entry.id);
  const marks = ids.map(() => "?").join(",");
  nas.transaction(() => {
    nas.prepare(`UPDATE notebooks SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
      WHERE id IN (${marks}) AND isDeleted = 0`).run(...ids);
    nas.prepare(`UPDATE notes SET isTrashed = 1, trashedAt = datetime('now'), updatedAt = datetime('now')
      WHERE notebookId IN (${marks}) AND isTrashed = 0`).run(...ids);
  })();
}

const HIDDEN_ROOT = `__nowen_root_documents__:personal:${NAS_USER}`;

/**
 * 根文档：服务端 activateRootContainer → 在容器下建目录/文档 → hideRootContainer。
 * 结果是容器常年 isDeleted=1，而它下面挂着未删除的目录和笔记。
 */
function nasRootDocumentFolder(folderId: string): void {
  nas.transaction(() => {
    nas.prepare(`
      INSERT OR IGNORE INTO notebooks (id, userId, workspaceId, parentId, name, icon, sortOrder, isExpanded, isDeleted, deletedAt)
      VALUES (?, ?, NULL, NULL, '__NOWEN_ROOT_DOCUMENTS__', '📄', -2147483648, 0, 0, NULL)
    `).run(HIDDEN_ROOT, NAS_USER);
    nas.prepare("UPDATE notebooks SET isDeleted = 0, deletedAt = NULL WHERE id = ?").run(HIDDEN_ROOT);
    // activateRootContainer 也会补回容器的树节点，子目录的镜像触发器要求父树节点存在。
    nas.prepare(`
      INSERT OR IGNORE INTO knowledge_tree_nodes (id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType, resourceId, sortOrder, isExpanded, isDeleted, deletedAt)
      VALUES (?, ?, NULL, ?, NULL, 'folder', 'notebook', ?, -2147483648, 0, 0, NULL)
    `).run(`notebook:${HIDDEN_ROOT}`, NAS_USER, `personal:${NAS_USER}`, HIDDEN_ROOT);
    nasNotebook(folderId, HIDDEN_ROOT, "根文档下的目录");
    nas.prepare("UPDATE notebooks SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now') WHERE id = ?").run(HIDDEN_ROOT);
    nas.prepare("DELETE FROM knowledge_tree_nodes WHERE id = ?").run(`notebook:${HIDDEN_ROOT}`);
  })();
}

/** 一棵有代表性的 NAS 目录树：嵌套、已删除子树、根文档目录；id 全是随机 UUID。 */
function seedRepresentativeNas(): { live: string[]; deletedRoot: string; folderUnderHidden: string; noteIds: string[] } {
  const noteIds: string[] = [];
  const work = nasNotebook(randomUUID(), null, "工作");
  const project = nasNotebook(randomUUID(), work, "项目");
  const sprint = nasNotebook(randomUUID(), project, "迭代");
  const deepest = nasNotebook(randomUUID(), sprint, "任务");
  const life = nasNotebook(randomUUID(), null, "生活");
  const trip = nasNotebook(randomUUID(), life, "旅行");
  for (const [index, notebookId] of [work, project, sprint, deepest, life, trip].entries()) {
    for (let n = 0; n < 3; n += 1) noteIds.push(nasNote(notebookId, `笔记 ${index}-${n}`));
  }

  const oldRoot = nasNotebook(randomUUID(), null, "已删除的归档");
  const oldChild = nasNotebook(randomUUID(), oldRoot, "归档子目录");
  const oldGrandchild = nasNotebook(randomUUID(), oldChild, "归档孙目录");
  for (const notebookId of [oldRoot, oldChild, oldGrandchild]) noteIds.push(nasNote(notebookId, `归档笔记 ${notebookId.slice(0, 4)}`));
  nasDeleteSubtree(oldRoot);

  const folderUnderHidden = randomUUID();
  nasRootDocumentFolder(folderUnderHidden);
  noteIds.push(nasNote(folderUnderHidden, "根文档下目录里的笔记"));
  return { live: [work, project, sprint, deepest, life, trip], deletedRoot: oldRoot, folderUnderHidden, noteIds };
}

// ---------------------------------------------------------------------------
// 对比工具
// ---------------------------------------------------------------------------

function structure(db: Database.Database, userId: string): Array<[string, string | null, number]> {
  return (db.prepare("SELECT id, parentId, isDeleted FROM notebooks WHERE userId = ? AND workspaceId IS NULL ORDER BY id").all(userId) as
    Array<{ id: string; parentId: string | null; isDeleted: number }>).map((row) => [row.id, row.parentId, row.isDeleted]);
}

function notes(db: Database.Database, userId: string): Array<[string, string, number, string]> {
  return (db.prepare("SELECT id, notebookId, isTrashed, title FROM notes WHERE userId = ? AND workspaceId IS NULL ORDER BY id").all(userId) as
    Array<{ id: string; notebookId: string; isTrashed: number; title: string }>).map((row) => [row.id, row.notebookId, row.isTrashed, row.title]);
}

async function downloadToWindows(local: Database.Database, pageSize?: number): Promise<LiteMigrationProgress> {
  return runLiteMigration({
    db: local, remoteUrl: SERVER_URL, userId: WIN_USER, remoteUserId: NAS_USER, client: remoteClient(), pageSize,
  });
}

function engineFor(local: Database.Database, progress: LiteMigrationProgress, userId: string): SyncEngine {
  const device = ensureDevice(local, { profileId: progress.profileId!, platform: "win32" });
  return new SyncEngine({
    db: local, profileId: progress.profileId!, deviceId: device.id, userId, client: remoteClient(),
    intervalMs: 0, scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
  });
}

// ===========================================================================
// 服务端 Snapshot 顺序
// ===========================================================================

interface SnapshotItem { entityType: string; entityId: string; payload: Record<string, unknown> }

async function snapshotNotebooks(limit: number): Promise<{ order: string[]; pages: string[][]; items: SnapshotItem[] }> {
  const items: SnapshotItem[] = [];
  const pages: string[][] = [];
  let cursor = "";
  let sequence = 0;
  for (let guard = 0; guard < 500; guard += 1) {
    const response = await nasApp.request(
      `/api/sync/v2/snapshot?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${sequence ? `&snapshotSequence=${sequence}` : ""}`,
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { items: SnapshotItem[]; hasMore: boolean; nextCursor: string | null; snapshotSequence: number };
    sequence = body.snapshotSequence;
    const notebooks = body.items.filter((item) => item.entityType === "notebook");
    if (notebooks.length > 0) pages.push(notebooks.map((item) => item.entityId));
    items.push(...body.items);
    if (!body.hasMore) break;
    cursor = body.nextCursor!;
  }
  return { order: items.filter((item) => item.entityType === "notebook").map((item) => item.entityId), pages, items };
}

test("DCC-005: the NAS snapshot delivers every parent before its children, across page boundaries and for any page size", async () => {
  for (let round = 0; round < 4; round += 1) {
    nas.exec("DELETE FROM notes; DELETE FROM notebooks;");
    seedRepresentativeNas();
    for (const limit of [1, 2, 3, 5, 200]) {
      const { order, items } = await snapshotNotebooks(limit);
      const rows = new Map(items.filter((item) => item.entityType === "notebook").map((item) => [item.entityId, item.payload]));
      assert.equal(new Set(order).size, order.length, `limit=${limit}: 目录被重复下发`);
      const total = (nas.prepare("SELECT COUNT(*) AS c FROM notebooks WHERE userId = ?").get(NAS_USER) as { c: number }).c;
      assert.equal(order.length, total, `limit=${limit}: 目录没有被完整下发`);
      const position = new Map(order.map((id, index) => [id, index]));
      for (const [id, payload] of rows) {
        const parent = payload.parentId as string | null;
        if (parent && position.has(parent)) {
          assert.ok(position.get(parent)! < position.get(id)!, `limit=${limit}: 子目录 ${id.slice(0, 8)} 先于它的父目录到达`);
        }
      }
    }
  }
});

test("DCC-005: corrupt notebook data (a parent cycle and a dangling parent) is still delivered exactly once without hanging the snapshot", async () => {
  const healthy = "c0000000-0000-4000-8000-000000000001";
  const cycleA = "c0000000-0000-4000-8000-0000000000a1";
  const cycleB = "c0000000-0000-4000-8000-0000000000a2";
  const dangling = "c0000000-0000-4000-8000-0000000000d1";
  nasNotebook(healthy, null, "正常根目录");
  // 这些行违反服务端自己的守卫，只可能来自历史脏数据：关闭外键并临时撤掉守卫来造出它们。
  nas.pragma("foreign_keys = OFF");
  nas.exec("DROP TRIGGER IF EXISTS notebooks_parent_guard_insert; DROP TRIGGER IF EXISTS notebooks_parent_guard_update;");
  try {
    for (const [id, parent] of [
      [cycleA, cycleB],
      [cycleB, cycleA],
      [dangling, "c0000000-0000-4000-8000-0000000000ff"],
    ] as const) {
      nas.prepare("INSERT INTO notebooks (id, userId, parentId, name, createdAt, updatedAt) VALUES (?, ?, ?, 'x', datetime('now'), datetime('now'))").run(id, NAS_USER, parent);
    }
  } finally {
    nas.pragma("foreign_keys = ON");
    // installNotebookTreeIntegrityGuards 按连接对象只安装一次；换一条新连接才能把触发器真正装回文件里。
    const restorer = new Database(getDbPath());
    try { installNotebookTreeIntegrityGuards(restorer); } finally { restorer.close(); }
  }
  assert.ok((nas.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'notebooks_parent_guard_insert'").get()),
    "测试结束前必须把 NAS 的守卫装回去，否则后面的用例都在没有守卫的库上跑");

  for (const limit of [1, 2, 200]) {
    const { order } = await snapshotNotebooks(limit);
    // 正常根目录和悬空父目录（按根处理）深度都是 0；成环的行拿不到合法深度，排在最后，且每行只下发一次。
    // （自引用行连知识树镜像守卫都过不去，服务端造不出来；它由客户端单元用例直接覆盖。）
    assert.deepEqual(order, [healthy, dangling, cycleA, cycleB], `limit=${limit}`);
  }
  nas.exec("DELETE FROM notebooks");
});

// ===========================================================================
// Windows 首次下载
// ===========================================================================

function nasFingerprint(): string {
  const dump = (sql: string) => JSON.stringify(nas.prepare(sql).all());
  return [
    dump("SELECT * FROM notebooks ORDER BY id"),
    dump("SELECT id, notebookId, title, content, contentText, isTrashed, trashedAt, version, updatedAt FROM notes ORDER BY id"),
    dump("SELECT * FROM tags ORDER BY id"),
  ].join("\n");
}

test("DCC-005: Windows first download from a NAS-shaped database converges exactly for random ids and any page size", async () => {
  for (let round = 0; round < 3; round += 1) {
    nas.exec("DELETE FROM notes; DELETE FROM notebooks;");
    const seeded = seedRepresentativeNas();
    const expectedStructure = structure(nas, NAS_USER);
    const expectedNotes = notes(nas, NAS_USER);

    for (const pageSize of [2, 3, 200]) {
      const win = openLocalDb("windows", WIN_USER);
      const progress = await downloadToWindows(win, pageSize);

      assert.equal(progress.stage, "complete", `第 ${round} 轮 pageSize=${pageSize} 未完成: ${progress.error} ${JSON.stringify(progress.diagnostic)}`);
      assert.equal(progress.errorCode, null);
      assert.deepEqual(structure(win, WIN_USER), expectedStructure, `第 ${round} 轮 pageSize=${pageSize}: 目录结构与 NAS 不一致`);
      assert.deepEqual(notes(win, WIN_USER), expectedNotes, `第 ${round} 轮 pageSize=${pageSize}: 笔记与 NAS 不一致`);
      assert.equal(countPendingMutations(win), 0, "导入的数据不得回流成待上传修改");
      assert.equal(listUnresolvedConflicts(win, progress.profileId!).length, 0, "干净的首次下载不应有冲突");
      const tree = win.prepare(
        "SELECT parentId FROM knowledge_tree_nodes WHERE resourceType = 'notebook' AND resourceId = ?",
      ).get(seeded.folderUnderHidden) as { parentId: string | null } | undefined;
      assert.equal(tree?.parentId ?? null, null, "根文档下的目录在知识树里落到根");
    }
  }
  assert.ok(requestLog.some((entry) => entry.path.endsWith("/snapshot")), "必须真的走了 Snapshot 路由");
});

test("DCC-007: a first download never rewrites, deletes or advances anything on the NAS", async () => {
  seedRepresentativeNas();
  const before = nasFingerprint();
  const feedBefore = (nas.prepare("SELECT COUNT(*) AS c FROM sync_changes_v2").get() as { c: number }).c;

  const progress = await downloadToWindows(openLocalDb("windows", WIN_USER), 3);
  assert.equal(progress.stage, "complete");

  assert.equal(nasFingerprint(), before, "下载是只读的：NAS 的目录、笔记、标签一个字节都不能变");
  assert.equal((nas.prepare("SELECT COUNT(*) AS c FROM sync_changes_v2").get() as { c: number }).c, feedBefore, "NAS 的变更流不得因下载而增长");
});

test("DCC-003: a structural failure on the real snapshot stops cleanly, keeps both sides intact, and a retry after repair completes", async () => {
  const seeded = seedRepresentativeNas();
  const before = nasFingerprint();
  const win = openLocalDb("windows", WIN_USER);
  // 本机已有的工作：失败后必须原样保留。
  const localNotebook = randomUUID();
  win.prepare("INSERT INTO notebooks (id, userId, name, createdAt, updatedAt) VALUES (?, ?, '本机已有', datetime('now'), datetime('now'))").run(localNotebook, WIN_USER);
  win.prepare(`INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version, sortOrder, createdAt, updatedAt)
    VALUES (?, ?, ?, '本机笔记', '{}', '本机正文', 'richtext', 1, 0, datetime('now'), datetime('now'))`).run(randomUUID(), WIN_USER, localNotebook);
  const localBefore = JSON.stringify([structure(win, WIN_USER), notes(win, WIN_USER)]);

  // 让快照里的一篇笔记指向不存在的目录：任何重试都会得到同一个外键失败。
  const poisoned = seeded.noteIds[0];
  snapshotMutator = (items) => {
    for (const item of items) if (item.entityType === "note" && item.entityId === poisoned) item.payload.notebookId = randomUUID();
  };
  const failed = await downloadToWindows(win, 200);
  assert.equal(failed.stage, "failed");
  assert.equal(failed.errorCode, "DATA_STRUCTURE");
  assert.equal(failed.retryable, false, "界面据此停止无意义的自动重试");
  assert.match(String(failed.error), /继续在线使用/);
  assert.equal(failed.diagnostic?.sqliteCode, "SQLITE_CONSTRAINT_FOREIGNKEY");
  assert.equal(JSON.stringify([structure(win, WIN_USER), notes(win, WIN_USER)]), localBefore, "失败后本机数据必须与失败前完全一致");
  assert.equal(nasFingerprint(), before, "失败不得改动 NAS");
  assert.equal(countPendingMutations(win), 0);
  assert.equal(getSyncState(win, failed.profileId!)?.lastSequence ?? 0, 0, "同步游标不得推进");

  snapshotMutator = null;
  const recovered = await downloadToWindows(win, 200);
  assert.equal(recovered.stage, "complete", `修复后应能完成: ${recovered.error}`);
  assert.equal(recovered.errorCode, null);
  const expected = new Set(structure(nas, NAS_USER).map((entry) => entry[0]));
  for (const [id] of structure(win, WIN_USER)) if (id !== localNotebook) assert.ok(expected.has(id));
  assert.ok(structure(win, WIN_USER).some(([id]) => id === localNotebook), "本机已有目录仍在");
});

// ===========================================================================
// 本机已有数据：双向对账（下载 + 上传）
// ===========================================================================

/** 与 routes/notebooks.ts 的 DELETE 同一套语义，用在任意一份库上。 */
function deleteSubtreeOn(db: Database.Database, rootId: string): void {
  const ids = (db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM notebooks WHERE id = ? AND isDeleted = 0
      UNION ALL
      SELECT n.id FROM notebooks n JOIN sub ON n.parentId = sub.id WHERE n.isDeleted = 0
    ) SELECT id FROM sub
  `).all(rootId) as Array<{ id: string }>).map((entry) => entry.id);
  const marks = ids.map(() => "?").join(",");
  db.transaction(() => {
    db.prepare(`UPDATE notebooks SET isDeleted = 1, deletedAt = datetime('now'), updatedAt = datetime('now')
      WHERE id IN (${marks}) AND isDeleted = 0`).run(...ids);
    db.prepare(`UPDATE notes SET isTrashed = 1, trashedAt = datetime('now'), updatedAt = datetime('now')
      WHERE notebookId IN (${marks}) AND isTrashed = 0`).run(...ids);
  })();
}

function localNotebook(db: Database.Database, userId: string, id: string, parentId: string | null, name: string): string {
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))")
    .run(id, userId, parentId, name);
  return id;
}

function localNote(db: Database.Database, userId: string, notebookId: string, title: string, id = randomUUID()): string {
  db.prepare(`INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version, sortOrder, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', ?, 'tiptap-json', 1, 0, datetime('now'), datetime('now'))`)
    .run(id, userId, notebookId, title, `本机正文：${title}`);
  return id;
}

async function bootstrapInto(db: Database.Database, userId: string) {
  const profile = createProfile(db, { name: "NAS", serverUrl: SERVER_URL, remoteUserId: NAS_USER });
  switchActiveProfile(db, profile.id);
  const device = ensureDevice(db, { profileId: profile.id, platform: "win32" });
  const progress = await runBootstrap({ db, profileId: profile.id, deviceId: device.id, userId, client: remoteClient() });
  return { profileId: profile.id, deviceId: device.id, progress };
}

test("DCC-007: connecting a Windows database that already has notes merges both directions without losing either side", async () => {
  const seeded = seedRepresentativeNas();
  const nasBefore = structure(nas, NAS_USER);
  const win = openLocalDb("windows", WIN_USER);

  // 用户在连接 NAS 之前就在本机用过：一棵嵌套目录，加上一棵被删除的嵌套目录。
  const mine = localNotebook(win, WIN_USER, randomUUID(), null, "本机目录");
  const mineChild = localNotebook(win, WIN_USER, randomUUID(), mine, "本机子目录");
  const mineNote = localNote(win, WIN_USER, mineChild, "本机已有笔记");
  const dead = localNotebook(win, WIN_USER, randomUUID(), null, "本机已删除目录");
  const deadChild = localNotebook(win, WIN_USER, randomUUID(), dead, "本机已删除子目录");
  localNote(win, WIN_USER, deadChild, "本机已删除目录里的笔记");
  deleteSubtreeOn(win, dead);
  const localBefore = structure(win, WIN_USER);

  const { profileId, progress } = await bootstrapInto(win, WIN_USER);

  assert.equal(progress.status, "ready", `首次对账失败: ${progress.error}`);
  assert.equal(progress.conflicts, 0, "两边 ID 互不重叠，不应有冲突");

  // 下载方向：NAS 的全部目录都在本机，结构一致。
  const nasIds = new Set(nasBefore.map((entry) => entry[0]));
  const winById = new Map(structure(win, WIN_USER).map((entry) => [entry[0], entry]));
  for (const entry of nasBefore) assert.deepEqual(winById.get(entry[0]), entry, `NAS 目录 ${entry[0].slice(0, 8)} 在本机缺失或结构不同`);
  // 本机原有的目录原样保留。
  for (const entry of localBefore) assert.deepEqual(winById.get(entry[0]), entry, "本机原有目录被改动");

  // 上传方向：本机独有的目录（含已删除的嵌套子树）都到了 NAS，父子链和删除标记完整。
  const nasAfter = new Map(structure(nas, NAS_USER).map((entry) => [entry[0], entry]));
  for (const entry of localBefore) {
    assert.ok(!nasIds.has(entry[0]));
    assert.deepEqual(nasAfter.get(entry[0]), entry, `本机目录 ${entry[0].slice(0, 8)} 没有按原结构上传到 NAS`);
  }
  assert.ok(nas.prepare("SELECT 1 FROM notes WHERE id = ?").get(mineNote), "本机笔记要上传");
  // NAS 原有数据没有被上传过程改坏。
  for (const entry of nasBefore) assert.deepEqual(nasAfter.get(entry[0]), entry, "NAS 原有目录被改动");
  assert.ok(seeded.live.length > 0);
  assert.equal(countPendingMutations(win), 0);
  assert.equal(listUnresolvedConflicts(win, profileId).length, 0);
});

// ===========================================================================
// 断网编辑 → 重连上传 → 多端一致
// ===========================================================================

async function secondDevice(): Promise<{ db: Database.Database; engine: SyncEngine; progress: LiteMigrationProgress }> {
  const db = openLocalDb("phone", PHONE_USER);
  const progress = await runLiteMigration({ db, remoteUrl: SERVER_URL, userId: PHONE_USER, remoteUserId: NAS_USER, client: remoteClient(), pageSize: 4 });
  assert.equal(progress.stage, "complete", `第二台设备下载失败: ${progress.error}`);
  return { db, engine: engineFor(db, progress, PHONE_USER), progress };
}

test("DCC-005: child-first downloads followed by folder expansion never flatten the desktop, NAS or second device", async () => {
  const id = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const parent = nasNotebook(id(6), null, "工作目录");
  const children = [1, 2, 3, 4, 5, 7, 8, 9, 10].map((n) => nasNotebook(id(n), parent, `项目 ${n}`));
  for (const child of children) nasNote(child, `项目笔记 ${child.slice(0, 8)}`);
  const expected = structure(nas, NAS_USER);
  const expectedNotes = notes(nas, NAS_USER);

  // v1.5.5 服务端按随机 UUID 排序：同一父目录的一部分子目录先到，另一部分后到。
  // 新客户端还必须兼容这样的服务端，不能只依赖新服务端的父先子后排序。
  snapshotMutator = (items) => {
    const notebooks = items.filter((item) => item.entityType === "notebook")
      .sort((a, b) => a.entityId.localeCompare(b.entityId));
    let index = 0;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].entityType === "notebook") items[i] = notebooks[index++];
    }
  };
  const win = openLocalDb("windows-child-first", WIN_USER);
  const progress = await downloadToWindows(win, 200);
  assert.equal(progress.stage, "complete");
  const downloaded = structure(win, WIN_USER);
  assert.equal(countPendingMutations(win), 0, "下载本身不应产生待上传的修改");

  // 用户没有移动任何目录，只折叠它们。旧协议仍会把 parentId 连同 isExpanded 一起上传。
  for (const child of children) win.prepare("UPDATE notebooks SET isExpanded = 0 WHERE id = ?").run(child);
  const queuedParents = (win.prepare(`SELECT entityId, json_extract(payload, '$.parentId') AS parentId
    FROM sync_outbox WHERE entityType = 'notebook' AND status = 'pending' ORDER BY entityId`).all() as
    Array<{ entityId: string; parentId: string | null }>);
  const engine = engineFor(win, progress, WIN_USER);
  const uploaded = await engine.syncOnce();

  const second = openLocalDb("second-child-first", PHONE_USER);
  const secondProgress = await runLiteMigration({
    db: second, remoteUrl: SERVER_URL, userId: PHONE_USER, remoteUserId: NAS_USER,
    client: remoteClient(), pageSize: 200,
  });
  assert.equal(secondProgress.stage, "complete");

  // 一并检查传播链，避免只检查数量或空 Outbox 就漏掉三端一致地变成错误结构。
  assert.deepEqual({
    downloaded,
    queuedParents,
    nas: structure(nas, NAS_USER),
    second: structure(second, PHONE_USER),
  }, {
    downloaded: expected,
    queuedParents: children.sort().map((entityId) => ({ entityId, parentId: parent })),
    nas: expected,
    second: expected,
  });
  assert.equal(uploaded.state, "idle", uploaded.lastError ?? "同步后不应产生结构冲突");
  assert.equal(countPendingMutations(win), 0);
  for (const [replica, userId] of [[win, WIN_USER], [nas, NAS_USER], [second, PHONE_USER]] as const) {
    assert.deepEqual(notes(replica, userId), expectedNotes);
    for (const child of children) {
      assert.deepEqual(replica.prepare(`SELECT parentId FROM knowledge_tree_nodes
        WHERE resourceType = 'notebook' AND resourceId = ?`).get(child), { parentId: `notebook:${parent}` });
    }
  }
});

function assertSameWorld(label: string, replica: Database.Database, userId: string): void {
  assert.deepEqual(structure(replica, userId), structure(nas, NAS_USER), `${label}: 目录结构与 NAS 不一致`);
  assert.deepEqual(notes(replica, userId), notes(nas, NAS_USER), `${label}: 笔记与 NAS 不一致`);
}

test("DCC-003: Windows offline edits survive, upload after reconnect, and a second device converges to the same tree", async () => {
  const seeded = seedRepresentativeNas();
  const [work, project, , , life] = seeded.live;
  const win = openLocalDb("windows", WIN_USER);
  const winProgress = await downloadToWindows(win, 5);
  assert.equal(winProgress.stage, "complete");
  const winEngine = engineFor(win, winProgress, WIN_USER);
  // 生产里引擎在下载完成后立刻启动：先在线跑一轮，建立知识树基线，之后才会断网。
  const firstCycle = await winEngine.syncOnce();
  assert.equal(firstCycle.state, "idle", `下载后的第一轮同步应干净: ${firstCycle.lastError} conflicts=${firstCycle.conflictCount}`);
  const phone = await secondDevice();
  assert.equal((await phone.engine.syncOnce()).state, "idle");

  // ---- 断网：本机继续编辑 ----
  networkUp = false;
  win.prepare("UPDATE notebooks SET name = '项目（离线改名）' WHERE id = ?").run(project);
  const newFolder = localNotebook(win, WIN_USER, randomUUID(), work, "离线新建目录");
  const newNote = localNote(win, WIN_USER, newFolder, "离线新建笔记");
  win.prepare("UPDATE notes SET title = '离线改过的标题', contentText = '离线改过的正文' WHERE id = ?").run(seeded.noteIds[0]);
  deleteSubtreeOn(win, life); // 「生活」及其子目录「旅行」一起删除
  const localWhileOffline = JSON.stringify([structure(win, WIN_USER), notes(win, WIN_USER)]);
  const nasWhileOffline = nasFingerprint();

  const offline = await winEngine.syncOnce();
  assert.equal(offline.state, "offline", "断网是离线状态，不是错误");
  assert.ok(offline.pendingMutations > 0, "离线修改必须在 Outbox 里等着");
  assert.equal(JSON.stringify([structure(win, WIN_USER), notes(win, WIN_USER)]), localWhileOffline, "断网同步不得改动本机数据");
  assert.equal(nasFingerprint(), nasWhileOffline, "断网时 NAS 不会变");
  const queuedBefore = offline.pendingMutations;

  // ---- 重连：上传 ----
  networkUp = true;
  const online = await winEngine.syncOnce();
  assert.equal(online.state, "idle", `重连后应回到空闲: ${online.lastError}`);
  assert.equal(online.pendingMutations, 0, `Outbox 应清空（原有 ${queuedBefore} 条）`);
  assert.equal((nas.prepare("SELECT name FROM notebooks WHERE id = ?").get(project) as { name: string }).name, "项目（离线改名）");
  assert.ok(nas.prepare("SELECT 1 FROM notebooks WHERE id = ? AND parentId = ?").get(newFolder, work), "离线新建的目录按原父目录到了 NAS");
  assert.ok(nas.prepare("SELECT 1 FROM notes WHERE id = ? AND notebookId = ?").get(newNote, newFolder));
  assert.equal((nas.prepare("SELECT title FROM notes WHERE id = ?").get(seeded.noteIds[0]) as { title: string }).title, "离线改过的标题");
  const deletedOnNas = nas.prepare("SELECT id, parentId, isDeleted FROM notebooks WHERE id = ? OR parentId = ? ORDER BY id").all(life, life) as
    Array<{ id: string; parentId: string | null; isDeleted: number }>;
  assert.equal(deletedOnNas.length, 2);
  assert.ok(deletedOnNas.every((entry) => entry.isDeleted === 1), "嵌套删除的整棵子树在 NAS 上都是已删除");
  assert.equal(deletedOnNas.find((entry) => entry.id !== life)?.parentId, life, "已删除子树的父子链保留");
  assertSameWorld("Windows", win, WIN_USER);

  // ---- 多端：第二台设备拉取后与 NAS、Windows 完全一致 ----
  const pulled = await phone.engine.syncOnce();
  assert.equal(pulled.state, "idle", `第二台设备拉取失败: ${pulled.lastError}`);
  assertSameWorld("第二台设备", phone.db, PHONE_USER);
  assert.equal(countPendingMutations(phone.db), 0, "拉取到的远端数据不得回流成上传");
});

test("DCC-005: a nested delete on the NAS reaches a synced device in either id order without tripping the parent guard", async () => {
  for (const parentSortsFirst of [true, false]) {
    nas.exec("DELETE FROM notes; DELETE FROM notebooks;");
    const root = nasNotebook(parentSortsFirst ? "d1000000-0000-4000-8000-000000000001" : "d1000000-0000-4000-8000-000000000009", null, "待删除的父目录");
    const child = nasNotebook(parentSortsFirst ? "d1000000-0000-4000-8000-000000000002" : "d1000000-0000-4000-8000-000000000003", root, "子目录");
    const grandchild = nasNotebook("d1000000-0000-4000-8000-000000000005", child, "孙目录");
    nasNote(grandchild, "孙目录里的笔记");

    const win = openLocalDb("windows", WIN_USER);
    const progress = await downloadToWindows(win);
    assert.equal(progress.stage, "complete");
    const engine = engineFor(win, progress, WIN_USER);
    assertSameWorld("下载后", win, WIN_USER);

    nasDeleteSubtree(root);
    const status = await engine.syncOnce();
    assert.equal(status.state, "idle", `parentSortsFirst=${parentSortsFirst}: 增量拉取失败 ${status.lastError}`);
    assertSameWorld(`parentSortsFirst=${parentSortsFirst}`, win, WIN_USER);
    assert.equal(countPendingMutations(win), 0);
  }
});

test("DCC-005: a folder the NAS creates under a root document reaches a synced device even though the container stays hidden", async () => {
  const seeded = seedRepresentativeNas();
  const win = openLocalDb("windows", WIN_USER);
  const progress = await downloadToWindows(win);
  assert.equal(progress.stage, "complete");
  const engine = engineFor(win, progress, WIN_USER);

  const another = randomUUID();
  nasRootDocumentFolder(another); // 容器被重新激活、建目录、再隐藏
  nasNote(another, "新目录里的笔记");
  nas.prepare("UPDATE notebooks SET name = '改名后的根文档目录' WHERE id = ?").run(seeded.folderUnderHidden);

  const status = await engine.syncOnce();
  assert.equal(status.state, "idle", `增量拉取失败: ${status.lastError}`);
  assertSameWorld("根文档容器场景", win, WIN_USER);
  assert.equal((win.prepare("SELECT isDeleted FROM notebooks WHERE id = ?").get(HIDDEN_ROOT) as { isDeleted: number }).isDeleted, 1, "容器在副本上仍是隐藏状态");
  const tree = win.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE resourceType = 'notebook' AND resourceId = ?").get(another) as
    { parentId: string | null } | undefined;
  assert.equal(tree?.parentId ?? null, null, "新目录在知识树里落到根");
});

// ===========================================================================
// 引擎：不可重试的结构错误
// ===========================================================================

test("DCC-005: the engine stops retrying a structural pull failure, keeps the cursor and local data, and recovers once the data is repaired", async () => {
  const seeded = seedRepresentativeNas();
  const win = openLocalDb("windows", WIN_USER);
  const progress = await downloadToWindows(win);
  assert.equal(progress.stage, "complete");
  const scheduled: number[] = [];
  const device = ensureDevice(win, { profileId: progress.profileId!, platform: "win32" });
  const engine = new SyncEngine({
    db: win, profileId: progress.profileId!, deviceId: device.id, userId: WIN_USER, client: remoteClient(),
    intervalMs: 0, scheduler: { setTimeout: (_fn, ms) => { scheduled.push(ms); return scheduled.length; }, clearTimeout: () => undefined },
  });
  assert.equal((await engine.syncOnce()).state, "idle");
  const cursorBefore = getSyncState(win, progress.profileId!)?.lastSequence;
  const localBefore = JSON.stringify([structure(win, WIN_USER), notes(win, WIN_USER)]);

  // NAS 上新增一篇笔记，但快照里它指向一个不存在的目录：每次重试都会得到同一个外键失败。
  const added = nasNote(seeded.live[0], "NAS 新增的笔记");
  snapshotMutator = (items) => { for (const item of items) if (item.entityId === added) item.payload.notebookId = randomUUID(); };
  scheduled.length = 0;
  requestLog.length = 0;

  const failed = await engine.syncOnce();
  assert.equal(failed.state, "error");
  assert.equal(failed.lastError, "DATA_STRUCTURE");
  assert.deepEqual(scheduled, [], "不可重试的结构错误不能再排程自动重试");
  assert.equal(getSyncState(win, progress.profileId!)?.lastSequence, cursorBefore, "失败后游标不得前进");
  assert.ok(!requestLog.some((entry) => entry.path.endsWith("/ack")), "没有落库成功就不能 ACK");
  assert.equal(JSON.stringify([structure(win, WIN_USER), notes(win, WIN_USER)]), localBefore, "本机数据保持原样");
  assert.ok(nas.prepare("SELECT 1 FROM notes WHERE id = ?").get(added), "NAS 数据不受影响");

  // 数据被修好后（手动触发一轮）立即恢复，说明没有任何粘滞状态。
  snapshotMutator = null;
  const recovered = await engine.syncOnce();
  assert.equal(recovered.state, "idle", `修复后应恢复: ${recovered.lastError}`);
  assert.ok(win.prepare("SELECT 1 FROM notes WHERE id = ?").get(added));
});

// ===========================================================================
// 服务端：拒绝而不是改写
// ===========================================================================

interface PushResult { mutationId: string; status: string; code?: string; error?: string }

async function pushToNas(mutations: Array<Record<string, unknown>>): Promise<PushResult[]> {
  const response = await nasApp.request("/api/sync/v2/push?scopeKey=personal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scopeKey: "personal", deviceId: "acceptance-device", mutations }),
  });
  assert.equal(response.status, 200);
  return (await response.json() as { results: PushResult[] }).results;
}

function notebookMutation(id: string, parentId: string | null, extra: Record<string, unknown> = {}) {
  return {
    mutationId: randomUUID(), entityType: "notebook", entityId: id, operation: "upsert",
    payload: { id, parentId, name: `推送-${id.slice(0, 4)}`, icon: "📒", sortOrder: 0, isExpanded: 1, isDeleted: 0, deletedAt: null, ...extra },
  };
}

test("DCC-007: the NAS refuses a child pushed before its parent instead of attaching it to the root, and accepts it once the parent exists", async () => {
  const parent = randomUUID();
  const child = randomUUID();

  const first = await pushToNas([notebookMutation(child, parent)]);
  assert.equal(first[0].status, "conflict");
  assert.equal(first[0].code, "MISSING_DEPENDENCY", "父目录还没到：拒绝，客户端的修改留在 Outbox 里");
  assert.equal(nas.prepare("SELECT 1 FROM notebooks WHERE id = ?").get(child), undefined, "NAS 不能悄悄创建一个被改写到根的目录");

  const second = await pushToNas([notebookMutation(parent, null)]);
  assert.equal(second[0].status, "applied");
  const third = await pushToNas([notebookMutation(child, parent)]);
  assert.equal(third[0].status, "applied");
  assert.equal((nas.prepare("SELECT parentId FROM notebooks WHERE id = ?").get(child) as { parentId: string }).parentId, parent);
});

test("DCC-007: pushing a deleted subtree parent-first, and renaming a folder under the hidden root container, are accepted with every link kept", async () => {
  const parent = randomUUID();
  const child = randomUUID();
  const grandchild = randomUUID();
  const deleted = { isDeleted: 1, deletedAt: "2026-11-01 10:00:00" };
  const results = await pushToNas([
    notebookMutation(parent, null, deleted),
    notebookMutation(child, parent, deleted),
    notebookMutation(grandchild, child, deleted),
  ]);
  assert.deepEqual(results.map((entry) => entry.status), ["applied", "applied", "applied"], JSON.stringify(results));
  const stored = (id: string) => nas.prepare("SELECT parentId, isDeleted FROM notebooks WHERE id = ?").get(id);
  assert.deepEqual(stored(parent), { parentId: null, isDeleted: 1 });
  assert.deepEqual(stored(child), { parentId: parent, isDeleted: 1 });
  assert.deepEqual(stored(grandchild), { parentId: child, isDeleted: 1 });

  const folder = randomUUID();
  nasRootDocumentFolder(folder);
  const renamed = await pushToNas([notebookMutation(folder, HIDDEN_ROOT, { name: "改名后" })]);
  assert.equal(renamed[0].status, "applied", JSON.stringify(renamed));
  assert.equal((nas.prepare("SELECT name, parentId FROM notebooks WHERE id = ?").get(folder) as { name: string; parentId: string }).name, "改名后");
  assert.equal((nas.prepare("SELECT isDeleted FROM notebooks WHERE id = ?").get(HIDDEN_ROOT) as { isDeleted: number }).isDeleted, 1, "容器仍是隐藏状态");
});

test("DCC-004: a pull never re-parents a folder whose local move is still waiting to upload", async () => {
  const seeded = seedRepresentativeNas();
  const [, , sprint, deepest, life, trip] = seeded.live;
  const win = openLocalDb("windows", WIN_USER);
  const progress = await downloadToWindows(win);
  const engine = engineFor(win, progress, WIN_USER);
  assert.equal((await engine.syncOnce()).state, "idle");

  // 本机把「任务」从「迭代」移到「生活」下，但上传失败（服务端拒绝），修改留在 Outbox。
  win.prepare("UPDATE notebooks SET parentId = ?, name = '本机移动后' WHERE id = ?").run(life, deepest);
  pushInterceptor = (mutations) => mutations.map((mutation) => ({ mutationId: mutation.mutationId, status: "conflict", code: "SERVER_ERROR" }));
  // 同时 NAS 上有人把它改名并移到了「旅行」下。
  nas.prepare("UPDATE notebooks SET parentId = ?, name = 'NAS 改名' WHERE id = ?").run(trip, deepest);

  const status = await engine.syncOnce();
  assert.ok(status.pendingMutations > 0, "上传失败的修改必须留在 Outbox");
  assert.deepEqual(win.prepare("SELECT parentId, name FROM notebooks WHERE id = ?").get(deepest), { parentId: life, name: "本机移动后" },
    "拉取不能用远端的父目录覆盖尚未上传的本机移动");
  assert.ok(listUnresolvedConflicts(win, progress.profileId!).some((entry) => entry.entityType === "notebook" && entry.entityId === deepest),
    "两边都改了：登记冲突，双方版本都保留");
  assert.ok(sprint);
});

test("DCC-005: local-only deleted folders uploaded during the first sync leave the second device and the knowledge tree consistent", async () => {
  seedRepresentativeNas();
  const win = openLocalDb("windows", WIN_USER);
  const dead = localNotebook(win, WIN_USER, randomUUID(), null, "本机已删除目录");
  const deadChild = localNotebook(win, WIN_USER, randomUUID(), dead, "本机已删除子目录");
  localNote(win, WIN_USER, deadChild, "本机已删除目录里的笔记");
  deleteSubtreeOn(win, dead);

  const { profileId, deviceId, progress } = await bootstrapInto(win, WIN_USER);
  assert.equal(progress.status, "ready", `首次对账失败: ${progress.error}`);
  const engine = new SyncEngine({
    db: win, profileId, deviceId, userId: WIN_USER, client: remoteClient(),
    intervalMs: 0, scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
  });
  const first = await engine.syncOnce();
  assert.equal(first.state, "idle", `上传了本机已删除子树之后的第一轮同步应干净: conflicts=${first.conflictCount} ${first.lastError}`);
  assertSameWorld("上传后的 Windows", win, WIN_USER);

  const phone = await secondDevice();
  assert.equal((await phone.engine.syncOnce()).state, "idle");
  assertSameWorld("第二台设备", phone.db, PHONE_USER);
});

test("DCC-003: notes that existed only on the Windows side before a download upload as creates, not as conflicts against a 'deleted' remote note", async () => {
  seedRepresentativeNas();
  const win = openLocalDb("windows", WIN_USER);
  const mine = localNotebook(win, WIN_USER, randomUUID(), null, "本机已有目录");
  const mineNote = localNote(win, WIN_USER, mine, "本机已有笔记");

  const progress = await downloadToWindows(win, 5);
  assert.equal(progress.stage, "complete");
  const queued = win.prepare("SELECT entityType, entityId, baseVersion FROM sync_outbox WHERE entityId = ?").get(mineNote) as
    { entityType: string; baseVersion: number | null } | undefined;
  assert.ok(queued, "迁移把本机独有的笔记登记为待上传意图");
  assert.equal(queued.baseVersion ?? null, null, "服务端上还没有这篇笔记：这是新建，不能带 baseVersion");

  const engine = engineFor(win, progress, WIN_USER);
  await engine.syncOnce();
  assert.ok(nas.prepare("SELECT 1 FROM notes WHERE id = ? AND notebookId = ?").get(mineNote, mine), "本机已有笔记必须真的到了 NAS");
  assert.equal((win.prepare("SELECT COUNT(*) AS c FROM sync_conflicts WHERE entityType = 'note' AND status = 'unresolved'").get() as { c: number }).c, 0,
    "新建不应被服务端当成『远端笔记已删除』的版本冲突");
  assert.equal((win.prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE entityId = ? AND status != 'synced'").get(mineNote) as { c: number }).c, 0);
});
