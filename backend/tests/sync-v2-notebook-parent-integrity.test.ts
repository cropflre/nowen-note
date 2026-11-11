import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getDb } from "../src/db/schema";
import { installNotebookTreeIntegrityGuards } from "../src/runtime/notebook-tree-hardening";
import { applyRemoteChanges, type RemoteEntityPayload } from "../src/sync/applyLocal";
import { getBootstrapProgress, runBootstrap } from "../src/sync/bootstrap";
import { listUnresolvedConflicts } from "../src/sync/conflict";
import { redactEntityId } from "../src/sync/diagnostics";
import { ensureDevice } from "../src/sync/device";
import { SyncError } from "../src/sync/errors";
import { getLiteMigrationProgress, runLiteMigration } from "../src/sync/liteMigration";
import { SERVER_PUSH_MODE, applyNotebookUpserts, orderNotebooksParentsFirst } from "../src/sync/notebookApply";
import { countPendingMutations, enqueueMutation } from "../src/sync/outbox";
import { createProfile, getSyncState, switchActiveProfile } from "../src/sync/profile";
import type { SyncEntityType } from "../src/sync/types";

/**
 * 目录（notebook）父子链的真实数据库回归。
 *
 * 与其它 sync 测试的关键区别：这里**显式安装生产环境的触发器守卫**
 * （notebooks_parent_guard_* 与知识树镜像触发器）。生产里它们由
 * services/notebook-permissions 在启动时安装；多数 sync 测试没有引入这个模块，
 * 数据库里根本没有守卫，于是"父目录已删除"这类失败从来没有被测到。
 *
 * 事故原型（Windows v1.5.5 首次从 NAS 下载）：
 *   Snapshot 按 id 排序并包含已软删除的整棵子树和根文档隐藏容器，
 *   本机逐条 upsert → NOTEBOOK_PARENT_NOT_FOUND，且被当成可重试的 SERVER_ERROR 无限重试。
 */

const LOCAL_USER = "win-local-user";
const NAS_USER = "nas-user";
const REMOTE_URL = "http://nas.test";
const HIDDEN_ROOT = `__nowen_root_documents__:personal:${NAS_USER}`;

installNotebookTreeIntegrityGuards(getDb());

function db() {
  return getDb();
}

/** 数字顺序 == 字典序，便于精确摆放"父在子前/子在父前"。 */
function nid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function resetAll(): void {
  db().exec(`
    DROP TABLE IF EXISTS lite_migration_state;
    DELETE FROM attachment_sync_state;
    DELETE FROM sync_conflicts;
    DELETE FROM sync_outbox;
    DELETE FROM sync_applied_mutations;
    DELETE FROM sync_state;
    DELETE FROM sync_profile_devices;
    DELETE FROM sync_device_identity;
    DELETE FROM sync_devices;
    DELETE FROM sync_profiles;
    DELETE FROM note_tags;
    DELETE FROM favorites;
    DELETE FROM attachments;
    DELETE FROM notes;
    DELETE FROM tags;
    DELETE FROM notebooks;
  `);
  db().prepare(`
    INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, 'x', datetime('now'), datetime('now'))
  `).run(LOCAL_USER, LOCAL_USER);
}

interface NotebookSpec {
  id: string;
  parentId?: string | null;
  name?: string;
  deleted?: boolean;
}

/** 与服务端 Snapshot 的 notebook 载荷同形：含 userId / updatedAt / workspaceId。 */
function notebookPayload(spec: NotebookSpec): Record<string, unknown> {
  return {
    id: spec.id,
    userId: NAS_USER,
    parentId: spec.parentId ?? null,
    name: spec.name ?? `目录 ${spec.id.slice(0, 8)}`,
    description: null,
    icon: "📒",
    color: null,
    sortOrder: 0,
    isExpanded: 1,
    isDeleted: spec.deleted ? 1 : 0,
    deletedAt: spec.deleted ? "2026-11-01 10:00:00" : null,
    createdAt: "2026-10-01 10:00:00",
    updatedAt: "2026-10-01 10:00:00",
    workspaceId: null,
  };
}

function remoteNotebook(spec: NotebookSpec): RemoteEntityPayload {
  return { entityType: "notebook", entityId: spec.id, operation: "upsert", payload: notebookPayload(spec) };
}

function notePayload(id: string, notebookId: string, title = "笔记标题"): Record<string, unknown> {
  return {
    id,
    userId: NAS_USER,
    notebookId,
    title,
    content: "{}",
    contentText: "正文",
    contentFormat: "richtext",
    version: 1,
    workspaceId: null,
  };
}

function row(id: string): { id: string; parentId: string | null; isDeleted: number; userId: string } | undefined {
  return db().prepare("SELECT id, parentId, isDeleted, userId FROM notebooks WHERE id = ?").get(id) as never;
}

function treeParent(id: string): string | null | undefined {
  const found = db().prepare(
    "SELECT parentId FROM knowledge_tree_nodes WHERE resourceType = 'notebook' AND resourceId = ?",
  ).get(id) as { parentId: string | null } | undefined;
  return found === undefined ? undefined : found.parentId;
}

function snapshotOfStructure(ids: string[]): Array<{ id: string; parentId: string | null; isDeleted: number }> {
  return ids.map((id) => {
    const found = row(id);
    return { id, parentId: found?.parentId ?? null, isDeleted: found?.isDeleted ?? -1 };
  });
}

/**
 * 一份 NAS 形状的目录数据，id 顺序刻意布置成各种危险排列：
 *   - a-child(2) 排在它的父目录 m-root(6) 之前；
 *   - c-del-child(4) 的父目录 b-del-parent(3) 已删除且排在它之前；
 *   - d-live-under-hidden(5) 是挂在已删除的根文档容器(1)下的活目录；
 *   - z-grandchild(7) 排在最后，祖先链是 m-root → a-child → z。
 */
const NAS_TREE = {
  hidden: { id: HIDDEN_ROOT, deleted: true },
  aChild: { id: nid(2), parentId: nid(6) },
  bDelParent: { id: nid(3), deleted: true },
  cDelChild: { id: nid(4), parentId: nid(3), deleted: true },
  dLive: { id: nid(5), parentId: HIDDEN_ROOT },
  mRoot: { id: nid(6) },
  zGrand: { id: nid(7), parentId: nid(2) },
} satisfies Record<string, NotebookSpec>;

const EXPECTED_STRUCTURE = [
  { id: HIDDEN_ROOT, parentId: null, isDeleted: 1 },
  { id: nid(2), parentId: nid(6), isDeleted: 0 },
  { id: nid(3), parentId: null, isDeleted: 1 },
  { id: nid(4), parentId: nid(3), isDeleted: 1 },
  { id: nid(5), parentId: HIDDEN_ROOT, isDeleted: 0 },
  { id: nid(6), parentId: null, isDeleted: 0 },
  { id: nid(7), parentId: nid(2), isDeleted: 0 },
];

function nasTreeItems(): RemoteEntityPayload[] {
  return Object.values(NAS_TREE).map((spec) => remoteNotebook(spec as NotebookSpec));
}

const NAS_TREE_IDS = EXPECTED_STRUCTURE.map((entry) => entry.id);

/** 确定性洗牌，失败时能复现。 */
function shuffled<T>(values: T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const pick = state % (index + 1);
    [result[index], result[pick]] = [result[pick], result[index]];
  }
  return result;
}

// ===========================================================================
// 测试环境自检：守卫必须真的在
// ===========================================================================

test("DCC-005: the sync test database carries the production notebook parent guards", () => {
  resetAll();
  const triggers = (db().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'notebooks'",
  ).all() as Array<{ name: string }>).map((entry) => entry.name);
  assert.ok(triggers.includes("notebooks_parent_guard_insert"), "缺少 INSERT 守卫，本文件的其余用例会失去意义");
  assert.ok(triggers.includes("notebooks_parent_guard_update"), "缺少 UPDATE 守卫，本文件的其余用例会失去意义");

  const insert = (id: string, parent: string | null) => db().prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, createdAt, updatedAt)
    VALUES (?, ?, ?, 'n', datetime('now'), datetime('now'))
  `).run(id, LOCAL_USER, parent);
  insert("guard-parent", null);
  db().prepare("UPDATE notebooks SET isDeleted = 1 WHERE id = 'guard-parent'").run();
  assert.throws(() => insert("guard-child", "guard-parent"), /NOTEBOOK_PARENT_NOT_FOUND/);
});

// ===========================================================================
// 单批应用：父目录缺失 / 已软删除 / 乱序
// ===========================================================================

test("DCC-005: a NAS-shaped notebook batch (deleted subtree, hidden root container, child before parent) applies with its structure intact", () => {
  resetAll();
  const result = applyRemoteChanges(db(), nasTreeItems(), { userId: LOCAL_USER });

  assert.equal(result.applied, 7);
  assert.equal(result.structureRepairs, 0, "合法数据不应触发任何结构修复");
  assert.deepEqual(snapshotOfStructure(NAS_TREE_IDS), EXPECTED_STRUCTURE);
  assert.equal(countPendingMutations(db()), 0, "应用远端数据不得产生 Outbox 回声");
  for (const id of NAS_TREE_IDS) assert.equal(row(id)?.userId, LOCAL_USER, "目录归属本机账号");
});

test("DCC-005: notebook structure is identical for every delivery order of the same NAS data", () => {
  const items = nasTreeItems();
  const orders = [items, [...items].reverse(), ...Array.from({ length: 30 }, (_, seed) => shuffled(items, seed + 1))];
  for (const [index, order] of orders.entries()) {
    resetAll();
    applyRemoteChanges(db(), order, { userId: LOCAL_USER });
    assert.deepEqual(snapshotOfStructure(NAS_TREE_IDS), EXPECTED_STRUCTURE, `第 ${index} 种到达顺序得到了不同的目录结构`);
  }
});

test("DCC-005: knowledge-tree projection follows the notebook parents the way the server's own hide/delete leaves it", () => {
  resetAll();
  applyRemoteChanges(db(), nasTreeItems(), { userId: LOCAL_USER });
  assert.equal(treeParent(nid(2)), `notebook:${nid(6)}`, "活父目录下的树父节点保持");
  assert.equal(treeParent(nid(7)), `notebook:${nid(2)}`);
  assert.equal(treeParent(nid(5)), null, "根文档容器下的活目录在树上落到根");
  assert.equal(treeParent(nid(4)), `notebook:${nid(3)}`, "已删除子树内部的树链接保留，恢复整棵子树时需要它");
});

test("DCC-005: deep nesting resolves regardless of delivery order, including a deleted tail of the chain", () => {
  resetAll();
  const depth = 120;
  const chain: NotebookSpec[] = Array.from({ length: depth }, (_, level) => ({
    id: nid(1000 + level),
    parentId: level === 0 ? null : nid(1000 + level - 1),
    deleted: level >= 90,
  }));
  applyRemoteChanges(db(), [...chain].reverse().map(remoteNotebook), { userId: LOCAL_USER });

  for (const [level, spec] of chain.entries()) {
    const found = row(spec.id);
    assert.equal(found?.parentId ?? null, spec.parentId ?? null, `第 ${level} 层的父目录被改变`);
    assert.equal(found?.isDeleted, level >= 90 ? 1 : 0, `第 ${level} 层的删除状态不对`);
  }
});

test("DCC-005: re-applying a batch and renaming a folder under a deleted parent do not re-run the parent guard", () => {
  resetAll();
  applyRemoteChanges(db(), nasTreeItems(), { userId: LOCAL_USER });

  // 同一批再来一次（重试 / 中断恢复 / 对账重放）。
  assert.doesNotThrow(() => applyRemoteChanges(db(), nasTreeItems(), { userId: LOCAL_USER }));
  assert.deepEqual(snapshotOfStructure(NAS_TREE_IDS), EXPECTED_STRUCTURE);

  // 活目录挂在已删除的根文档容器下，只改名：父目录没变就不能重写 parentId。
  const rename = remoteNotebook({ id: nid(5), parentId: HIDDEN_ROOT, name: "改名后的目录" });
  assert.doesNotThrow(() => applyRemoteChanges(db(), [rename], { userId: LOCAL_USER }));
  assert.equal((db().prepare("SELECT name FROM notebooks WHERE id = ?").get(nid(5)) as { name: string }).name, "改名后的目录");
  assert.equal(row(nid(5))?.parentId, HIDDEN_ROOT);
  assert.equal(row(HIDDEN_ROOT)?.isDeleted, 1, "容器必须回到隐藏状态");
});

test("DCC-007: remote restore of a deleted subtree and a later re-delete keep tombstone state and parent links", () => {
  resetAll();
  applyRemoteChanges(db(), nasTreeItems(), { userId: LOCAL_USER });

  applyRemoteChanges(db(), [
    remoteNotebook({ id: nid(3) }),
    remoteNotebook({ id: nid(4), parentId: nid(3) }),
  ], { userId: LOCAL_USER });
  assert.deepEqual(snapshotOfStructure([nid(3), nid(4)]), [
    { id: nid(3), parentId: null, isDeleted: 0 },
    { id: nid(4), parentId: nid(3), isDeleted: 0 },
  ]);

  // 再次整棵删除：服务端只翻转标志，保留父子链。
  applyRemoteChanges(db(), [
    remoteNotebook({ id: nid(4), parentId: nid(3), deleted: true }),
    remoteNotebook({ id: nid(3), deleted: true }),
  ], { userId: LOCAL_USER });
  assert.deepEqual(snapshotOfStructure([nid(3), nid(4)]), [
    { id: nid(3), parentId: null, isDeleted: 1 },
    { id: nid(4), parentId: nid(3), isDeleted: 1 },
  ]);
});

test("DCC-005: an incremental batch can hang a new folder under a parent the replica already holds as deleted", () => {
  resetAll();
  applyRemoteChanges(db(), [remoteNotebook({ id: HIDDEN_ROOT, deleted: true })], { userId: LOCAL_USER });

  // 服务端在根文档下新建目录：先激活容器、建目录、再隐藏——副本只会收到最终状态。
  assert.doesNotThrow(() => applyRemoteChanges(db(), [remoteNotebook({ id: nid(50), parentId: HIDDEN_ROOT })], { userId: LOCAL_USER }));
  assert.equal(row(nid(50))?.parentId, HIDDEN_ROOT);
  assert.equal(row(HIDDEN_ROOT)?.isDeleted, 1, "容器的已删除状态必须恢复");
  assert.equal(treeParent(nid(50)), null);
});

// ===========================================================================
// 结构异常：回退要确定、可见，不能再悄悄压平
// ===========================================================================

test("DCC-007: a dangling parent falls back to the root visibly instead of failing or silently flattening", () => {
  resetAll();
  const result = applyRemoteChanges(db(), [
    remoteNotebook({ id: nid(10), parentId: nid(999) }),
    remoteNotebook({ id: nid(11) }),
    remoteNotebook({ id: nid(12), parentId: nid(11) }),
  ], { userId: LOCAL_USER });

  assert.equal(result.structureRepairs, 1, "只有悬空父目录这一处是异常");
  assert.equal(row(nid(10))?.parentId, null);
  assert.equal(row(nid(12))?.parentId, nid(11), "正常的链接不受影响");
});

test("DCC-007: a remote parent cycle is broken deterministically at its smallest id and counted", () => {
  resetAll();
  const loop = [
    remoteNotebook({ id: nid(21), parentId: nid(22) }),
    remoteNotebook({ id: nid(22), parentId: nid(23) }),
    remoteNotebook({ id: nid(23), parentId: nid(21) }),
    remoteNotebook({ id: nid(24), parentId: nid(22) }),
    remoteNotebook({ id: nid(25), parentId: nid(25) }),
  ];
  const outcomes = [loop, [...loop].reverse()].map((order) => {
    resetAll();
    const result = applyRemoteChanges(db(), order, { userId: LOCAL_USER });
    return { result, structure: snapshotOfStructure([nid(21), nid(22), nid(23), nid(24), nid(25)]) };
  });
  assert.deepEqual(outcomes[0].structure, outcomes[1].structure, "断环结果不能依赖到达顺序");
  // 环 21→22→23→21 在 id 最小的 21 处断开（放到根），其余链接原样保留；24 仍挂在 22 下；25 自引用放到根。
  assert.deepEqual(outcomes[0].structure.map((entry) => entry.parentId), [null, nid(23), nid(21), nid(22), null]);
  assert.equal(outcomes[0].result.structureRepairs, 2, "一个环、一个自引用");
});

test("DCC-007: ordering helper keeps parents before children and never drops an item", () => {
  const items = [
    { entityId: "c", payload: { parentId: "b" } },
    { entityId: "b", payload: { parentId: "a" } },
    { entityId: "a", payload: {} },
    { entityId: "x", payload: { parentId: "y" } },
    { entityId: "y", payload: { parentId: "x" } },
    { entityId: "orphan", payload: { parentId: "elsewhere" } },
  ];
  const { ordered, cycleBreakers } = orderNotebooksParentsFirst(items);
  assert.equal(ordered.length, items.length);
  const position = new Map(ordered.map((item, index) => [item.entityId, index]));
  assert.ok(position.get("a")! < position.get("b")! && position.get("b")! < position.get("c")!);
  assert.deepEqual([...cycleBreakers], ["x"]);
});

test("DCC-007: server push mode refuses an unresolved parent and never touches a notebook that belongs to another user", () => {
  resetAll();
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt) VALUES ('other-local', 'other-local', 'x', datetime('now'), datetime('now'))").run();
  db().prepare("INSERT INTO notebooks (id, userId, name, createdAt, updatedAt) VALUES (?, 'other-local', '别人的目录', datetime('now'), datetime('now'))").run(nid(80));

  // 别人的 id 被推送过来：服务端沿用"不更新不属于本作用域的行"，且删除标记也不能被改。
  applyNotebookUpserts(db(), [
    remoteNotebook({ id: nid(80), name: "被改写", deleted: true }),
    remoteNotebook({ id: nid(81) }),
  ], { userId: LOCAL_USER }, {}, SERVER_PUSH_MODE);
  assert.deepEqual(db().prepare("SELECT name, isDeleted, userId FROM notebooks WHERE id = ?").get(nid(80)),
    { name: "别人的目录", isDeleted: 0, userId: "other-local" });
  assert.ok(row(nid(81)), "同一批里属于自己作用域的目录照常写入");

  // 父目录还没到：拒绝，不创建，也不改写到根。
  assert.throws(
    () => applyNotebookUpserts(db(), [remoteNotebook({ id: nid(82), parentId: nid(999) })], { userId: LOCAL_USER }, {}, SERVER_PUSH_MODE),
    (error: unknown) => error instanceof SyncError && error.code === "MISSING_DEPENDENCY" && error.diagnostic?.reason === "NOTEBOOK_PARENT_NOT_FOUND",
  );
  assert.equal(row(nid(82)), undefined);
});

// ===========================================================================
// Lite 迁移：分页、跨页依赖、中断恢复
// ===========================================================================

interface FakeEntity {
  entityType: SyncEntityType;
  entityId: string;
  payload: Record<string, unknown>;
}

class FakeRemote {
  entities: FakeEntity[] = [];
  serverSequence = 500;
  failSnapshotAtCall = 0;
  snapshotCalls = 0;
  /** 每次 snapshot 被调用时，本机落库的 lite 迁移游标——用来证明游标没有跑到未落库的数据前面。 */
  persistedCursorAtCall: Array<string | null> = [];

  async plan() {
    return {
      serverSequence: this.serverSequence,
      minAvailableSequence: 0,
      resetRequired: false,
      notebookCount: this.entities.filter((entity) => entity.entityType === "notebook").length,
      noteCount: this.entities.filter((entity) => entity.entityType === "note").length,
      tagCount: this.entities.filter((entity) => entity.entityType === "tag").length,
    };
  }

  async snapshot(cursor: string | null, _at: number, limit: number) {
    this.snapshotCalls += 1;
    const stateRow = db().prepare("SELECT cursor FROM lite_migration_state WHERE singletonKey = 1").get() as
      | { cursor: string | null } | undefined;
    this.persistedCursorAtCall.push(stateRow?.cursor ?? null);
    if (this.failSnapshotAtCall > 0 && this.snapshotCalls === this.failSnapshotAtCall) {
      throw new SyncError("NETWORK_UNAVAILABLE", "断网");
    }
    const start = cursor ? Number(cursor) : 0;
    const slice = this.entities.slice(start, start + limit);
    const next = start + slice.length;
    return {
      snapshotSequence: this.serverSequence,
      hasMore: next < this.entities.length,
      nextCursor: next < this.entities.length ? String(next) : null,
      items: slice,
    };
  }

  async changes(after: number) {
    return { serverSequence: this.serverSequence, nextSequence: Math.max(after, this.serverSequence), hasMore: false, resetRequired: false, items: [] };
  }

  async push(_deviceId: string, mutations: Array<{ mutationId: string }>) {
    return { serverSequence: this.serverSequence, results: mutations.map((m) => ({ mutationId: m.mutationId, status: "applied" as const })) };
  }

  async ack(_deviceId: string, sequence: number) {
    return { lastSequence: sequence };
  }

  addNotebooks(specs: NotebookSpec[]): void {
    for (const spec of specs) this.entities.push({ entityType: "notebook", entityId: spec.id, payload: notebookPayload(spec) });
  }

  addNote(id: string, notebookId: string, title = "笔记标题"): void {
    this.entities.push({ entityType: "note", entityId: id, payload: notePayload(id, notebookId, title) });
  }
}

function lite(remote: FakeRemote, pageSize = 2) {
  return runLiteMigration({ db: db(), remoteUrl: REMOTE_URL, userId: LOCAL_USER, remoteUserId: NAS_USER, client: remote as never, pageSize });
}

/** 子目录在前、父目录在后，且父子被分页切开。 */
function crossPageTree(): NotebookSpec[] {
  return [
    { id: nid(7), parentId: nid(2) },
    { id: nid(2), parentId: nid(6) },
    { id: nid(4), parentId: nid(3), deleted: true },
    { id: nid(5), parentId: HIDDEN_ROOT },
    { id: nid(3), deleted: true },
    { id: HIDDEN_ROOT, deleted: true },
    { id: nid(6) },
  ];
}

test("DCC-005: lite migration keeps parent links that straddle snapshot pages", async () => {
  resetAll();
  const remote = new FakeRemote();
  remote.addNotebooks(crossPageTree());
  remote.addNote(randomUUID(), nid(7));

  const progress = await lite(remote, 2);

  assert.equal(progress.stage, "complete", `迁移未完成: ${progress.error}`);
  assert.deepEqual(snapshotOfStructure(NAS_TREE_IDS), EXPECTED_STRUCTURE);
  assert.equal((db().prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c, 1);
  assert.equal(listUnresolvedConflicts(db(), progress.profileId!).length, 0);
  assert.equal(countPendingMutations(db()), 0, "迁移导入的远端数据不得回流成 Outbox");
});

test("DCC-005: the persisted lite cursor never runs ahead of notebooks that are still held for dependency ordering", async () => {
  resetAll();
  const remote = new FakeRemote();
  remote.addNotebooks(crossPageTree());
  remote.addNote(randomUUID(), nid(7));

  const progress = await lite(remote, 2);
  assert.equal(progress.stage, "complete");
  // 目录占前 4 页（7 个目录，每页 2 条）：期间落库的游标必须停在目录段的起点。
  assert.deepEqual(remote.persistedCursorAtCall.slice(0, 4), [null, null, null, null],
    "目录段尚未整体落库时，游标不能前进——否则此刻被强杀，续传会跳过已下载但未写入的目录");
});

test("DCC-003: a network failure in the middle of the notebook segment keeps the cursor and retries to the same structure", async () => {
  resetAll();
  const remote = new FakeRemote();
  remote.addNotebooks(crossPageTree());
  remote.addNote(randomUUID(), nid(7));
  const before = (db().prepare("SELECT COUNT(*) AS c FROM notebooks").get() as { c: number }).c;

  remote.failSnapshotAtCall = 3;
  const failed = await lite(remote, 2);
  assert.equal(failed.stage, "failed");
  assert.equal(failed.errorCode, "NETWORK_UNAVAILABLE");
  assert.equal(failed.retryable, true, "断网属于可重试");
  assert.equal((db().prepare("SELECT COUNT(*) AS c FROM notebooks").get() as { c: number }).c, before, "没有半写入的目录");

  remote.failSnapshotAtCall = 0;
  const resumed = await lite(remote, 2);
  assert.equal(resumed.stage, "complete", `续传失败: ${resumed.error}`);
  assert.deepEqual(snapshotOfStructure(NAS_TREE_IDS), EXPECTED_STRUCTURE);
  assert.equal(resumed.downloaded, remote.entities.length, "续传不能重复计数已下载的条目");
});

test("DCC-003: an interruption after notebooks were committed resumes from the stored cursor without re-conflicting", async () => {
  resetAll();
  const remote = new FakeRemote();
  remote.addNotebooks(crossPageTree());
  for (let index = 0; index < 5; index += 1) remote.addNote(randomUUID(), nid(6), `笔记 ${index}`);

  remote.failSnapshotAtCall = 6; // 目录段 4 页之后的第 2 页笔记
  const failed = await lite(remote, 2);
  assert.equal(failed.stage, "failed");
  const callsBeforeResume = remote.snapshotCalls;

  remote.failSnapshotAtCall = 0;
  const resumed = await lite(remote, 2);
  assert.equal(resumed.stage, "complete");
  assert.ok(remote.persistedCursorAtCall[callsBeforeResume] !== null, "目录已落库，续传应从落库的游标继续而不是重下目录");
  assert.equal(listUnresolvedConflicts(db(), resumed.profileId!).length, 0, "续传不得把已落库的同 ID 数据当成冲突");
  assert.deepEqual(snapshotOfStructure(NAS_TREE_IDS), EXPECTED_STRUCTURE);
});

test("DCC-005: replaying the whole snapshot after a reset is idempotent and records no bogus conflicts", async () => {
  resetAll();
  // 只放目录：手写的笔记载荷缺 isPinned 等真实字段，会制造与产品无关的差异；
  // 笔记的真实载荷由走真实 Snapshot 路由的验收用例覆盖。
  const remote = new FakeRemote();
  remote.addNotebooks(crossPageTree());
  const first = await lite(remote, 3);
  assert.equal(first.stage, "complete");

  db().exec("DROP TABLE lite_migration_state");
  const replay = await lite(remote, 3);
  assert.equal(replay.stage, "complete", `重放失败: ${replay.error}`);
  assert.equal(listUnresolvedConflicts(db(), replay.profileId!).length, 0,
    "服务端载荷带 userId/updatedAt 等本机状态里没有的字段，不应因此被当成内容不同");
  assert.deepEqual(snapshotOfStructure(NAS_TREE_IDS), EXPECTED_STRUCTURE);
});

// ===========================================================================
// 失败语义：分类、停止重试、不丢数据、不推进游标、诊断脱敏
// ===========================================================================

function seedLocalWork(): { notebookId: string; noteId: string } {
  const notebookId = randomUUID();
  const noteId = randomUUID();
  db().prepare(`
    INSERT INTO notebooks (id, userId, name, createdAt, updatedAt)
    VALUES (?, ?, '本机已有目录', datetime('now'), datetime('now'))
  `).run(notebookId, LOCAL_USER);
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version, sortOrder, createdAt, updatedAt)
    VALUES (?, ?, ?, '本机已有笔记', '{}', '尚未同步的内容', 'richtext', 1, 0, datetime('now'), datetime('now'))
  `).run(noteId, LOCAL_USER, notebookId);
  return { notebookId, noteId };
}

function captureLogs<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const sink = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.log = sink; console.warn = sink; console.error = sink; console.info = sink;
  return work().then((result) => ({ result, lines }))
    .finally(() => { Object.assign(console, originals); });
}

/** 笔记指向快照里不存在的目录：外键失败，同一份数据再试一万次也是同一个结果。 */
function danglingNoteRemote(secretTitle: string): { remote: FakeRemote; noteId: string; missingNotebook: string } {
  const remote = new FakeRemote();
  remote.addNotebooks([{ id: nid(6) }, { id: nid(2), parentId: nid(6) }]);
  const noteId = randomUUID();
  const missingNotebook = randomUUID();
  remote.addNote(noteId, missingNotebook, secretTitle);
  return { remote, noteId, missingNotebook };
}

test("DCC-003: a structural failure is classified non-retryable, rolls the page back, keeps local work and does not advance cursors", async () => {
  resetAll();
  const local = seedLocalWork();
  const { remote } = danglingNoteRemote("机密标题-SECRET");

  const progress = await lite(remote, 100);

  assert.equal(progress.stage, "failed");
  assert.equal(progress.errorCode, "DATA_STRUCTURE");
  assert.equal(progress.retryable, false, "同一份载荷必然再次失败，不能让调用方继续自动重试");
  assert.match(String(progress.error), /已停止自动重试/);
  assert.match(String(progress.error), /可继续在线使用/);
  assert.equal(progress.diagnostic?.sqliteCode, "SQLITE_CONSTRAINT_FOREIGNKEY");
  assert.equal(progress.diagnostic?.entityType, "note");
  assert.equal(progress.diagnostic?.stage, "lite-migration:applying");

  // 整页随事务回滚：远端目录没有半写入，本机已有数据一条不少，也没有任何同步游标/队列副作用。
  assert.equal(row(nid(6)), undefined);
  assert.ok(row(local.notebookId), "本机已有目录不得丢失");
  assert.equal((db().prepare("SELECT contentText FROM notes WHERE id = ?").get(local.noteId) as { contentText: string }).contentText, "尚未同步的内容");
  assert.equal(countPendingMutations(db()), 0);
  assert.equal(getSyncState(db(), progress.profileId!)?.lastSequence ?? 0, 0, "失败后同步游标不能前进");
  assert.equal(getLiteMigrationProgress(db()).retryable, false, "进度查询也要保留分类");
});

test("DCC-003: failure diagnostics carry stage, error kind, redacted ids, parent state and SQLite code but no content or credentials", async () => {
  resetAll();
  seedLocalWork();
  const { remote, noteId, missingNotebook } = danglingNoteRemote("机密标题-SECRET");

  const { result: progress, lines } = await captureLogs(() => lite(remote, 100));
  assert.equal(progress.errorCode, "DATA_STRUCTURE");

  const failureLine = lines.find((line) => line.includes("lite-migration.failed"));
  assert.ok(failureLine, `缺少失败日志: ${lines.join("\n")}`);
  for (const expected of [
    "errorCode=DATA_STRUCTURE",
    "retryable=false",
    "stage=lite-migration:applying",
    "step=note",
    "entityType=note",
    "sqliteCode=SQLITE_CONSTRAINT_FOREIGNKEY",
    `entityId=${redactEntityId(noteId)}`,
  ]) assert.ok(failureLine!.includes(expected), `日志缺少 ${expected}: ${failureLine}`);

  const everything = JSON.stringify(progress) + lines.join("\n");
  for (const forbidden of ["机密标题-SECRET", "尚未同步的内容", noteId, missingNotebook, "Bearer"]) {
    assert.ok(!everything.includes(forbidden), `诊断泄漏了 ${forbidden}`);
  }
});

test("DCC-005: notebook-level failures also report the parent state that caused them", async () => {
  resetAll();
  // 另一个本机用户已经占用了这个目录 id：不能把远端数据写进不属于本作用域的行。
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt) VALUES ('other-local', 'other-local', 'x', datetime('now'), datetime('now'))").run();
  db().prepare("INSERT INTO notebooks (id, userId, name, createdAt, updatedAt) VALUES (?, 'other-local', '别人的目录', datetime('now'), datetime('now'))").run(nid(31));

  let failure: unknown;
  try {
    applyRemoteChanges(db(), [remoteNotebook({ id: nid(30) }), remoteNotebook({ id: nid(31), parentId: nid(30) })], { userId: LOCAL_USER });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof SyncError);
  assert.equal(failure.code, "DATA_STRUCTURE");
  assert.equal(failure.diagnostic?.reason, "NOTEBOOK_ID_COLLISION");
  assert.equal(failure.diagnostic?.step, "notebook.link");
  assert.equal(failure.diagnostic?.parentState, "live");
  assert.equal(failure.diagnostic?.entityId, redactEntityId(nid(31)));
  assert.equal(row(nid(30)), undefined, "整批回滚");
  assert.equal(row(nid(31))?.userId, "other-local", "别人的目录没有被改动");
});

test("DCC-003: a structural failure after a successful retry cycle recovers once the remote data is repaired", async () => {
  resetAll();
  const { remote, noteId, missingNotebook } = danglingNoteRemote("标题");

  const failed = await lite(remote, 100);
  assert.equal(failed.errorCode, "DATA_STRUCTURE");

  // NAS 上的数据被修好：悬空引用指向的目录补回来了。
  remote.addNotebooks([{ id: missingNotebook }]);
  const recovered = await lite(remote, 100);
  assert.equal(recovered.stage, "complete", `修复后应能续传: ${recovered.error}`);
  assert.ok(db().prepare("SELECT 1 FROM notes WHERE id = ?").get(noteId));
  assert.equal(recovered.errorCode ?? null, null, "成功后不能残留上一次的错误分类");
});

// ===========================================================================
// Bootstrap：已有本地数据、失败分类
// ===========================================================================

function seedBootstrapProfile() {
  const profile = createProfile(db(), { name: "NAS", serverUrl: REMOTE_URL });
  switchActiveProfile(db(), profile.id);
  const device = ensureDevice(db(), { profileId: profile.id, platform: "win32" });
  return { profileId: profile.id, deviceId: device.id };
}

class FakeBootstrapRemote {
  pushed: Array<{ entityType: string; entityId: string }> = [];
  constructor(public items: FakeEntity[], public serverSequence = 700) {}
  async plan() { return { serverSequence: this.serverSequence, minAvailableSequence: 0, resetRequired: false, notebookCount: 0, noteCount: 0, tagCount: 0 }; }
  async snapshot(_cursor: string | null, _at: number, _limit: number) {
    return { snapshotSequence: this.serverSequence, hasMore: false, nextCursor: null, items: this.items };
  }
  async changes(after: number) { return { serverSequence: this.serverSequence, nextSequence: Math.max(after, this.serverSequence), hasMore: false, resetRequired: false, items: [] }; }
  async push(_deviceId: string, mutations: Array<{ mutationId: string; entityType: string; entityId: string }>) {
    for (const mutation of mutations) this.pushed.push({ entityType: mutation.entityType, entityId: mutation.entityId });
    return { serverSequence: this.serverSequence, results: mutations.map((m) => ({ mutationId: m.mutationId, status: "applied" as const })) };
  }
  async ack(_deviceId: string, sequence: number) { return { lastSequence: sequence }; }
}

test("DCC-007: bootstrap into a database that already has folders links remote children to local ones and keeps both versions of a clash", async () => {
  resetAll();
  const { profileId, deviceId } = seedBootstrapProfile();
  // 本机已有：与远端同 id 但名称/父目录不同的目录，以及一个只在本机的目录。
  const sharedId = nid(60);
  const localOnly = nid(61);
  const insertLocal = (id: string, name: string, parentId: string | null) => db().prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, LOCAL_USER, parentId, name);
  insertLocal(localOnly, "只在本机", null);
  insertLocal(sharedId, "本机版本", localOnly);

  const remote = new FakeBootstrapRemote([
    { entityType: "notebook", entityId: nid(62), payload: notebookPayload({ id: nid(62), parentId: sharedId, name: "远端子目录" }) },
    { entityType: "notebook", entityId: sharedId, payload: notebookPayload({ id: sharedId, name: "远端版本" }) },
    { entityType: "notebook", entityId: nid(63), payload: notebookPayload({ id: nid(63), parentId: nid(64), deleted: true }) },
    { entityType: "notebook", entityId: nid(64), payload: notebookPayload({ id: nid(64), deleted: true }) },
  ]);

  const progress = await runBootstrap({ db: db(), profileId, deviceId, userId: LOCAL_USER, client: remote as never });

  assert.equal(progress.status, "ready");
  assert.equal(progress.conflicts, 1, "同 id 内容不同必须进冲突台账");
  const shared = db().prepare("SELECT name, parentId FROM notebooks WHERE id = ?").get(sharedId) as { name: string; parentId: string };
  assert.deepEqual(shared, { name: "本机版本", parentId: localOnly }, "冲突期间本机版本原样保留，不被静默覆盖");
  assert.equal(row(nid(62))?.parentId, sharedId, "远端子目录挂到了本机已有的父目录下");
  assert.deepEqual(snapshotOfStructure([nid(63), nid(64)]), [
    { id: nid(63), parentId: nid(64), isDeleted: 1 },
    { id: nid(64), parentId: null, isDeleted: 1 },
  ]);
  assert.ok(remote.pushed.some((entry) => entry.entityId === localOnly), "只在本机的目录要上传");
});

test("DCC-007: bootstrap uploads local folders parents-first even when a child was created before its parent", async () => {
  resetAll();
  const { profileId, deviceId } = seedBootstrapProfile();
  const parent = nid(70);
  const child = nid(71);
  // 子目录先创建、之后才被移到更晚创建的父目录下：createdAt 顺序与依赖顺序相反。
  db().prepare("INSERT INTO notebooks (id, userId, name, createdAt, updatedAt) VALUES (?, ?, '子', '2026-01-01 00:00:00', datetime('now'))").run(child, LOCAL_USER);
  db().prepare("INSERT INTO notebooks (id, userId, name, createdAt, updatedAt) VALUES (?, ?, '父', '2026-02-01 00:00:00', datetime('now'))").run(parent, LOCAL_USER);
  db().prepare("UPDATE notebooks SET parentId = ? WHERE id = ?").run(parent, child);

  const remote = new FakeBootstrapRemote([{ entityType: "tag", entityId: randomUUID(), payload: { id: "t", name: "占位标签", color: "#fff", userId: NAS_USER } }]);
  const progress = await runBootstrap({ db: db(), profileId, deviceId, userId: LOCAL_USER, client: remote as never });

  assert.equal(progress.status, "ready");
  const order = remote.pushed.filter((entry) => entry.entityType === "notebook").map((entry) => entry.entityId);
  assert.deepEqual(order, [parent, child], "NAS 的守卫要求父目录先于子目录到达");
});

test("DCC-003: a structural bootstrap failure is recorded as non-retryable and leaves local data, cursor and queue alone", async () => {
  resetAll();
  const { profileId, deviceId } = seedBootstrapProfile();
  const local = seedLocalWork();
  const { remote } = danglingNoteRemote("机密标题-SECRET");
  const client = new FakeBootstrapRemote(remote.entities);

  const { result: outcome, lines } = await captureLogs(async () => {
    try {
      await runBootstrap({ db: db(), profileId, deviceId, userId: LOCAL_USER, client: client as never });
      return null;
    } catch (error) {
      return error;
    }
  });

  assert.ok(outcome instanceof SyncError);
  assert.equal(outcome.code, "DATA_STRUCTURE");
  assert.equal(outcome.retryable, false);
  const progress = getBootstrapProgress(db(), profileId);
  assert.equal(progress.status, "failed");
  assert.equal(progress.error, "DATA_STRUCTURE");
  assert.ok(row(local.notebookId) && db().prepare("SELECT 1 FROM notes WHERE id = ?").get(local.noteId), "本机数据保留");
  assert.equal(getSyncState(db(), profileId)?.lastSequence ?? 0, 0, "游标不能前进");

  const line = lines.find((entry) => entry.includes("bootstrap.failed"));
  assert.ok(line && line.includes("errorCode=DATA_STRUCTURE") && line.includes("retryable=false")
    && line.includes("stage=bootstrap:reconciling") && line.includes("sqliteCode=SQLITE_CONSTRAINT_FOREIGNKEY"), String(line));
  assert.ok(!lines.join("\n").includes("机密标题-SECRET"));
});

// ===========================================================================
// 标签：全新安装的本机库自带播种标签，与服务器上的同名标签 ID 不同
// ===========================================================================

function localTag(id: string, name: string, color = "#999999"): string {
  db().prepare("INSERT INTO tags (id, userId, name, color, createdAt) VALUES (?, ?, ?, ?, datetime('now'))").run(id, LOCAL_USER, name, color);
  return id;
}

function remoteTag(id: string, name: string, color = "#ff0000"): FakeEntity {
  return { entityType: "tag", entityId: id, payload: { id, userId: NAS_USER, name, color, createdAt: "2026-01-01 00:00:00", workspaceId: null } };
}

function tagNames(): Array<{ id: string; name: string; color: string }> {
  return db().prepare("SELECT id, name, color FROM tags WHERE userId = ? ORDER BY id").all(LOCAL_USER) as never;
}

test("DCC-007: a same-name tag seeded on the Windows install is merged into the server's tag and keeps every note association", async () => {
  resetAll();
  // 全新安装播种出来的默认标签与关联笔记（ID 与服务器上的不同，名称相同；大小写和首尾空格不同）。
  const [l1, l2, lonely] = [nid(901), nid(902), nid(903)];
  localTag(l1, "Important", "#111111");
  localTag(l2, "技术");
  localTag(lonely, "只在本机");
  const seedNotebook = localNotebookRow(nid(910));
  const seedNote = localNoteRow(seedNotebook, "播种笔记");
  for (const tagId of [l1, l2, lonely]) db().prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, ?)").run(seedNote, tagId);

  const [r1, r2] = [nid(951), nid(952)];
  const remote = new FakeRemote();
  remote.addNotebooks([{ id: nid(920) }]);
  remote.entities.push(remoteTag(r1, "important "), remoteTag(r2, "技术", "#58a6ff"));
  const remoteNote = nid(930);
  remote.addNote(remoteNote, nid(920));
  remote.entities.push({ entityType: "note_tag", entityId: `${remoteNote}:${r1}`, payload: { noteId: remoteNote, tagId: r1, workspaceId: null } });

  const progress = await lite(remote, 100);

  assert.equal(progress.stage, "complete", `首次下载应能完成: ${progress.error} ${JSON.stringify(progress.diagnostic)}`);
  assert.deepEqual(tagNames(), [
    { id: lonely, name: "只在本机", color: "#999999" },
    { id: r1, name: "important ", color: "#ff0000" },
    { id: r2, name: "技术", color: "#58a6ff" },
  ], "同名标签并入服务器上的标签（采用服务器的 ID、名称和颜色）；本机独有的标签原样保留");
  const associations = db().prepare("SELECT noteId, tagId FROM note_tags ORDER BY noteId, tagId").all();
  assert.deepEqual(associations, [
    { noteId: remoteNote, tagId: r1 },
    ...[lonely, r1, r2].sort().map((tagId) => ({ noteId: seedNote, tagId })),
  ].sort((a, b) => a.noteId.localeCompare(b.noteId) || a.tagId.localeCompare(b.tagId)), "本机笔记的标签关联一条不少，且指向服务器上的标签");
  assert.equal(listUnresolvedConflicts(db(), progress.profileId!).length, 0);
  const queued = db().prepare("SELECT entityType, entityId FROM sync_outbox").all() as Array<{ entityType: string; entityId: string }>;
  assert.ok(!queued.some((entry) => entry.entityId.includes(l1) || entry.entityId.includes(l2)),
    "已经并掉的本机标签不能再作为待上传意图留在队列里（否则会撞服务器的唯一索引）");
  assert.ok(queued.some((entry) => entry.entityType === "note_tag" && entry.entityId === `${seedNote}:${r1}`),
    "本机笔记与服务器标签的关联要上传");
});

test("DCC-003: a same-name tag with unsent local changes is never merged silently and fails with a precise non-retryable reason", async () => {
  resetAll();
  const profile = createProfile(db(), { name: "NAS", serverUrl: REMOTE_URL });
  switchActiveProfile(db(), profile.id);
  const device = ensureDevice(db(), { profileId: profile.id, platform: "win32" });
  const l1 = localTag(nid(901), "重要");
  enqueueMutation(db(), { profileId: profile.id, deviceId: device.id, entityType: "tag", entityId: l1, operation: "upsert", baseVersion: null, payload: { id: l1, name: "重要" } });
  const before = JSON.stringify(tagNames());

  let failure: unknown;
  try {
    applyRemoteChanges(db(), [{ entityType: "tag", entityId: nid(951), operation: "upsert", payload: { name: "重要", color: "#ff0000" } }], { userId: LOCAL_USER });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof SyncError);
  assert.equal(failure.code, "DATA_STRUCTURE");
  assert.equal(failure.diagnostic?.reason, "TAG_NAME_COLLISION");
  assert.equal(failure.diagnostic?.step, "tag");
  assert.equal(JSON.stringify(tagNames()), before, "失败整体回滚，本机标签和待上传意图都原样保留");
  assert.equal(countPendingMutations(db()), 1);
});

test("DCC-007: bootstrap recomputes its upload plan after a same-name tag merge and pushes only what is still local", async () => {
  resetAll();
  const { profileId, deviceId } = seedBootstrapProfile();
  const [l1, lonely] = [nid(901), nid(903)];
  localTag(l1, "重要");
  localTag(lonely, "只在本机");
  const seedNote = localNoteRow(localNotebookRow(nid(910)), "播种笔记");
  db().prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, ?)").run(seedNote, l1);

  const r1 = nid(951);
  const remote = new FakeBootstrapRemote([remoteTag(r1, "重要")]);
  const progress = await runBootstrap({ db: db(), profileId, deviceId, userId: LOCAL_USER, client: remote as never });

  assert.equal(progress.status, "ready", `首次对账应完成: ${progress.error}`);
  assert.deepEqual(tagNames().map((tag) => tag.id), [lonely, r1].sort());
  const pushed = remote.pushed.map((entry) => `${entry.entityType}:${entry.entityId}`);
  assert.ok(pushed.includes(`tag:${lonely}`), "本机独有的标签要上传");
  assert.ok(pushed.includes(`note_tag:${seedNote}:${r1}`), "关联按合并后的服务器标签上传");
  assert.ok(!pushed.includes(`tag:${l1}`) && !pushed.includes(`note_tag:${seedNote}:${l1}`), "已经并掉的本机标签和旧关联不能再上传");
});

function localNotebookRow(id: string): string {
  db().prepare("INSERT INTO notebooks (id, userId, name, createdAt, updatedAt) VALUES (?, ?, '本机目录', datetime('now'), datetime('now'))").run(id, LOCAL_USER);
  return id;
}

function localNoteRow(notebookId: string, title: string): string {
  const id = randomUUID();
  db().prepare(`INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version, sortOrder, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, '{}', '本机正文', 'richtext', 1, 0, datetime('now'), datetime('now'))`).run(id, LOCAL_USER, notebookId, title);
  return id;
}
