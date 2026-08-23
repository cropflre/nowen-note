import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getDb } from "../src/db/schema";
import {
  getBootstrapProgress,
  isBootstrapReady,
  isLocalEmpty,
  readLocalState,
  reconcile,
  resetBootstrap,
  runBootstrap,
} from "../src/sync/bootstrap";
import { createProfile, getSyncState, switchActiveProfile } from "../src/sync/profile";
import { ensureDevice } from "../src/sync/device";
import { countPendingMutations, listPendingMutations } from "../src/sync/outbox";
import { countUnresolvedConflicts, listUnresolvedConflicts } from "../src/sync/conflict";
import { SyncError } from "../src/sync/errors";
import type { SyncEntityType } from "../src/sync/types";

/**
 * 阶段 D：Bootstrap / Reconcile 契约（migration v89）。
 *
 * 覆盖用户要求的全部场景：
 *   Local only / Remote only / 两边不同 ID / 同 ID 同内容 / 同 ID 冲突 /
 *   中断恢复 / bootstrap 时 local edit / sequence 不丢 / reconnect 幂等
 */

const USER_ID = "bootstrap-user";
const DEVICE_HINT = { platform: "win32" };

function db() {
  return getDb();
}

function resetAll(): void {
  db().exec(`
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
    DELETE FROM task_reminders;
    DELETE FROM tasks;
    DELETE FROM diaries;
    DELETE FROM mindmaps;
    DELETE FROM notes;
    DELETE FROM tags;
    DELETE FROM notebooks;
  `);
  db().prepare(`
    INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, 'x', datetime('now'), datetime('now'))
  `).run(USER_ID, USER_ID);
}

function seedProfile() {
  const d = db();
  const profile = createProfile(d, { name: "对账服务器", serverUrl: "http://bs.test" });
  switchActiveProfile(d, profile.id);
  const device = ensureDevice(d, { profileId: profile.id, ...DEVICE_HINT });
  return { profileId: profile.id, deviceId: device.id };
}

function makeNotebook(name = "本", id = randomUUID()): string {
  db().prepare(`
    INSERT INTO notebooks (id, userId, name, icon, sortOrder, createdAt, updatedAt)
    VALUES (?, ?, ?, '📒', 0, datetime('now'), datetime('now'))
  `).run(id, USER_ID, name);
  return id;
}

function makeNote(notebookId: string, title = "标题", id = randomUUID()): string {
  db().prepare(`
    INSERT INTO notes (
      id, userId, notebookId, title, content, contentText, contentFormat,
      version, sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, '{}', '正文', 'richtext', 1, 0, datetime('now'), datetime('now'))
  `).run(id, USER_ID, notebookId, title);
  return id;
}

/** 可编程远端：记录调用、可注入 snapshot 分页与失败。 */
class FakeRemote {
  planSequence = 0;
  snapshotPages: Array<{
    snapshotSequence: number;
    hasMore: boolean;
    nextCursor: string | null;
    items: Array<{ entityType: SyncEntityType; entityId: string; payload: Record<string, unknown> }>;
  }> = [];
  changesQueue: Array<{
    serverSequence: number;
    nextSequence: number;
    hasMore: boolean;
    resetRequired: boolean;
    items: Array<{ sequence: number; entityType: SyncEntityType; entityId: string; operation: "upsert" | "delete" }>;
  }> = [];
  pushCalls: Array<Array<{ mutationId: string; entityType: string; entityId: string }>> = [];
  ackCalls: number[] = [];
  /** 注入失败：在指定阶段抛错，用于验证中断恢复。 */
  failOn: "plan" | "snapshot" | "push" | null = null;
  snapshotCallCount = 0;
  /** push 返回的冲突 mutationId 集合。 */
  conflictMutations = new Set<string>();

  async plan() {
    if (this.failOn === "plan") throw new SyncError("NETWORK_UNAVAILABLE", "断网");
    return {
      serverSequence: this.planSequence,
      minAvailableSequence: 0,
      resetRequired: false,
      notebookCount: 0,
      noteCount: 0,
      tagCount: 0,
    };
  }

  async snapshot(_cursor: string | null, _seq: number, _limit?: number) {
    if (this.failOn === "snapshot") throw new SyncError("NETWORK_UNAVAILABLE", "断网");
    this.snapshotCallCount += 1;
    return this.snapshotPages.shift() ?? {
      snapshotSequence: this.planSequence,
      hasMore: false,
      nextCursor: null,
      items: [],
    };
  }

  async changes(_after: number, _limit?: number) {
    return this.changesQueue.shift() ?? {
      serverSequence: this.planSequence,
      nextSequence: this.planSequence,
      hasMore: false,
      resetRequired: false,
      items: [],
    };
  }

  async push(_deviceId: string, mutations: Array<{ mutationId: string; entityType: string; entityId: string }>) {
    if (this.failOn === "push") throw new SyncError("NETWORK_UNAVAILABLE", "断网");
    this.pushCalls.push(mutations);
    return {
      serverSequence: this.planSequence,
      results: mutations.map((m) => (
        this.conflictMutations.has(m.mutationId)
          ? { mutationId: m.mutationId, status: "conflict" as const, serverVersion: 9 }
          : { mutationId: m.mutationId, status: "applied" as const }
      )),
    };
  }

  async ack(_deviceId: string, sequence: number) {
    this.ackCalls.push(sequence);
    return { lastSequence: sequence };
  }
}

function run(remote: FakeRemote, ids: { profileId: string; deviceId: string }, pageSize = 50) {
  return runBootstrap({
    db: db(),
    profileId: ids.profileId,
    deviceId: ids.deviceId,
    userId: USER_ID,
    client: remote as never,
    pageSize,
  });
}

// ===========================================================================
// reconcile 纯函数：合并规则
// ===========================================================================

test("reconcile: 不同 ID 即不同实体，绝不按标题匹配", () => {
  const plan = reconcile(
    [{ entityType: "note", entityId: "local-1", operation: "upsert", payload: { title: "同名笔记" } }],
    [{ entityType: "note", entityId: "remote-1", operation: "upsert", payload: { title: "同名笔记" } }],
  );
  assert.equal(plan.toPush.length, 1, "本地独有 → 上传");
  assert.equal(plan.toApply.length, 1, "远端独有 → 下载");
  assert.equal(
    plan.conflicts.length,
    0,
    "标题相同但 ID 不同是两篇不同的笔记，两者并存才是正确结果",
  );
});

test("reconcile: 同 ID 同内容视为已一致，不产生任何动作", () => {
  const payload = { title: "标题", content: "{}", notebookId: "nb1" };
  const plan = reconcile(
    [{ entityType: "note", entityId: "n1", operation: "upsert", payload }],
    [{ entityType: "note", entityId: "n1", operation: "upsert", payload: { ...payload } }],
  );
  assert.equal(plan.toPush.length, 0);
  assert.equal(plan.toApply.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

test("reconcile: 同 ID 内容不同进冲突，不做 LWW", () => {
  const plan = reconcile(
    [{ entityType: "note", entityId: "n1", operation: "upsert", payload: { title: "本机版本" } }],
    [{ entityType: "note", entityId: "n1", operation: "upsert", payload: { title: "服务器版本" } }],
  );
  assert.equal(plan.toPush.length, 0, "冲突不得被当成普通上传覆盖远端");
  assert.equal(plan.toApply.length, 0, "冲突不得被当成普通下载覆盖本地");
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].local.payload?.title, "本机版本");
  assert.equal(plan.conflicts[0].remote.payload?.title, "服务器版本");
});

test("reconcile: 关系型实体同 ID 即同内容，不构成冲突", () => {
  const plan = reconcile(
    [{ entityType: "note_tag", entityId: "n1:t1", operation: "upsert", payload: { noteId: "n1", tagId: "t1" } }],
    [{ entityType: "note_tag", entityId: "n1:t1", operation: "upsert", payload: { noteId: "n1", tagId: "t1", extra: 1 } }],
  );
  assert.equal(
    plan.conflicts.length,
    0,
    "复合 ID 本身编码了全部信息，两端各自建立结果相同",
  );
});

test("reconcile: version 与 updatedAt 差异不算冲突", () => {
  const plan = reconcile(
    [{ entityType: "note", entityId: "n1", operation: "upsert", payload: { title: "同", version: 3, updatedAt: "a" } }],
    [{ entityType: "note", entityId: "n1", operation: "upsert", payload: { title: "同", version: 7, updatedAt: "b" } }],
  );
  assert.equal(plan.conflicts.length, 0, "内容一致时版本号差异不该打扰用户");
});

// ===========================================================================
// 本地状态读取
// ===========================================================================

test("readLocalState 只读个人空间，不含工作区数据", () => {
  resetAll();
  const d = db();
  const nb = makeNotebook();
  makeNote(nb);
  d.prepare(`
    INSERT INTO workspaces (id, name, ownerId, createdAt, updatedAt)
    VALUES ('ws1', '团队', ?, datetime('now'), datetime('now'))
  `).run(USER_ID);
  d.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText,
      contentFormat, version, sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'ws1', 'T', '{}', 'x', 'richtext', 1, 0, datetime('now'), datetime('now'))
  `).run(randomUUID(), USER_ID, nb);

  const notes = readLocalState(d, USER_ID, "note");
  assert.equal(notes.length, 1, "工作区笔记不在第一版同步范围内");
});

test("readLocalState 的附件 payload 不含服务器路径", () => {
  resetAll();
  const nb = makeNotebook();
  const note = makeNote(nb);
  db().prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, hash)
    VALUES (?, ?, ?, '图.png', 'image/png', 1, '/srv/x.png', 'h')
  `).run(randomUUID(), note, USER_ID);

  const items = readLocalState(db(), USER_ID, "attachment");
  assert.equal(items.length, 1);
  assert.equal(items[0].payload?.path, undefined);
  assert.equal(items[0].payload?.filename, "图.png");
});

test("readLocalState 完整覆盖 10 类同步实体", () => {
  resetAll();
  const notebookId = makeNotebook();
  const noteId = makeNote(notebookId);
  const taskId = randomUUID();
  const reminderId = randomUUID();
  const diaryId = randomUUID();
  const mindmapId = randomUUID();
  db().prepare(`
    INSERT INTO tasks (id, userId, title, workspaceId, createdAt, updatedAt)
    VALUES (?, ?, '任务', NULL, datetime('now'), datetime('now'))
  `).run(taskId, USER_ID);
  db().prepare(`
    INSERT INTO task_reminders (id, taskId, userId, offsetMinutes, enabled, createdAt)
    VALUES (?, ?, ?, 15, 1, datetime('now'))
  `).run(reminderId, taskId, USER_ID);
  db().prepare(`
    INSERT INTO diaries (id, userId, workspaceId, contentText, mood, images, media, createdAt)
    VALUES (?, ?, NULL, '记录', '好', '[]', '[]', datetime('now'))
  `).run(diaryId, USER_ID);
  db().prepare(`
    INSERT INTO mindmaps (id, userId, workspaceId, title, data, createdAt, updatedAt)
    VALUES (?, ?, NULL, '导图', '{}', datetime('now'), datetime('now'))
  `).run(mindmapId, USER_ID);
  db().prepare("INSERT INTO tags (id, userId, name, workspaceId) VALUES ('tag-10', ?, '标签', NULL)").run(USER_ID);
  db().prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, 'tag-10')").run(noteId);
  db().prepare("INSERT INTO favorites (userId, noteId, workspaceId) VALUES (?, ?, NULL)").run(USER_ID, noteId);
  db().prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
    VALUES ('attachment-10', ?, ?, 'a.txt', 'text/plain', 1, 'a.txt')
  `).run(noteId, USER_ID);

  const types: SyncEntityType[] = [
    "notebook", "tag", "note", "note_tag", "favorite", "attachment",
    "task", "task_reminder", "diary", "mindmap",
  ];
  for (const type of types) {
    assert.ok(readLocalState(db(), USER_ID, type).length > 0, `${type} 未进入 Desktop Bootstrap 本地基线`);
  }
});

test("isLocalEmpty 正确区分空库与有数据", () => {
  resetAll();
  assert.equal(isLocalEmpty(db(), USER_ID), true);
  makeNotebook();
  assert.equal(isLocalEmpty(db(), USER_ID), false);
});

// ===========================================================================
// 场景 1：Local 有数据，Remote 空 → 上传
// ===========================================================================

test("场景: Local 有数据 Remote 空 → 本地状态全部上传", async () => {
  resetAll();
  const ids = seedProfile();
  const nb = makeNotebook("我的本");
  makeNote(nb, "笔记一");
  makeNote(nb, "笔记二");

  const remote = new FakeRemote();
  const progress = await run(remote, ids);

  assert.equal(progress.status, "ready");
  assert.equal(progress.pushed, 3, "1 笔记本 + 2 笔记");

  // 父实体必须先于子实体推送
  const order = remote.pushCalls.flat().map((m) => m.entityType);
  assert.equal(order[0], "notebook", "notebook 必须先推，否则服务端缺父实体");
  assert.ok(order.indexOf("notebook") < order.indexOf("note"));
});

// ===========================================================================
// 场景 2：Local 空，Remote 有数据 → 下载
// ===========================================================================

test("场景: Local 空 Remote 有数据 → Snapshot 全量下载到本地", async () => {
  resetAll();
  const ids = seedProfile();
  const nbId = randomUUID();
  const noteId = randomUUID();

  const remote = new FakeRemote();
  remote.planSequence = 42;
  remote.snapshotPages.push({
    snapshotSequence: 42,
    hasMore: false,
    nextCursor: null,
    items: [
      { entityType: "notebook", entityId: nbId, payload: { id: nbId, name: "远端本", icon: "📒" } },
      { entityType: "note", entityId: noteId, payload: { id: noteId, notebookId: nbId, title: "远端笔记", content: "{}", version: 1 } },
    ],
  });

  const progress = await run(remote, ids);

  assert.equal(progress.status, "ready");
  assert.equal(progress.pulled, 2);
  assert.equal(progress.pushed, 0, "Remote 有数据时不该反向上传");

  const nb = db().prepare("SELECT name FROM notebooks WHERE id = ?").get(nbId) as { name: string };
  assert.equal(nb.name, "远端本");
  const note = db().prepare("SELECT title FROM notes WHERE id = ?").get(noteId) as { title: string };
  assert.equal(note.title, "远端笔记");
});

test("下载不产生 Outbox 条目（双层抑制防回环）", async () => {
  resetAll();
  const ids = seedProfile();
  const nbId = randomUUID();
  const remote = new FakeRemote();
  remote.snapshotPages.push({
    snapshotSequence: 5, hasMore: false, nextCursor: null,
    items: [{ entityType: "notebook", entityId: nbId, payload: { id: nbId, name: "远端" } }],
  });

  await run(remote, ids);

  assert.equal(
    countPendingMutations(db()),
    0,
    "远端内容回流会形成 Pull → Apply → Push 无限循环",
  );
});

// ===========================================================================
// 场景 3：两边都有数据 → 合并
// ===========================================================================

test("场景: 两边都有数据 → 各自独有的双向同步，同 ID 冲突入台账", async () => {
  resetAll();
  const ids = seedProfile();
  // 本地：nb-local + note-local；另有 note-shared（与远端同 ID 不同内容）
  const nbLocal = makeNotebook("本地本");
  makeNote(nbLocal, "本地独有");
  const sharedId = randomUUID();
  makeNote(nbLocal, "本机版本", sharedId);

  const remoteNoteId = randomUUID();
  const remote = new FakeRemote();
  remote.planSequence = 10;
  remote.snapshotPages.push({
    snapshotSequence: 10, hasMore: false, nextCursor: null,
    items: [
      { entityType: "note", entityId: remoteNoteId, payload: { id: remoteNoteId, notebookId: nbLocal, title: "远端独有", content: "{}", version: 1 } },
      { entityType: "note", entityId: sharedId, payload: { id: sharedId, notebookId: nbLocal, title: "服务器版本", content: "{}", version: 4 } },
    ],
  });

  const progress = await run(remote, ids);

  assert.equal(progress.status, "ready");
  assert.equal(progress.conflicts, 1, "同 ID 内容不同必须进冲突台账");

  // 冲突的两个版本都被保留
  const conflicts = listUnresolvedConflicts(db());
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].entityId, sharedId);
  assert.ok(conflicts[0].localPayload, "本机版本必须可恢复");
  assert.ok(conflicts[0].remotePayload, "服务器版本必须可恢复");

  // 冲突笔记的本地内容未被覆盖
  const shared = db().prepare("SELECT title FROM notes WHERE id = ?").get(sharedId) as { title: string };
  assert.equal(shared.title, "本机版本", "冲突期间绝不能静默覆盖本地内容");

  // 远端独有的已下载
  assert.ok(db().prepare("SELECT id FROM notes WHERE id = ?").get(remoteNoteId));
  // 本地独有的已上传
  const pushedIds = remote.pushCalls.flat().map((m) => m.entityId);
  assert.ok(pushedIds.includes(nbLocal));
});

// ===========================================================================
// Snapshot 分页与 sequence 一致性
// ===========================================================================

test("Snapshot 分页续传，游标落库", async () => {
  resetAll();
  const ids = seedProfile();
  const a = randomUUID();
  const b = randomUUID();
  const remote = new FakeRemote();
  remote.planSequence = 7;
  remote.snapshotPages.push(
    { snapshotSequence: 7, hasMore: true, nextCursor: "cur-1", items: [{ entityType: "notebook", entityId: a, payload: { id: a, name: "第一页" } }] },
    { snapshotSequence: 7, hasMore: false, nextCursor: null, items: [{ entityType: "notebook", entityId: b, payload: { id: b, name: "第二页" } }] },
  );

  const progress = await run(remote, ids, 1);
  assert.equal(progress.status, "ready");
  assert.equal(progress.pulled, 2, "两页都必须应用");
  assert.ok(remote.snapshotCallCount >= 2);
});

test("verifying 阶段补齐 snapshot 窗口期的服务端增量，sequence 不丢", async () => {
  resetAll();
  const ids = seedProfile();
  const lateId = randomUUID();

  const remote = new FakeRemote();
  remote.planSequence = 100;
  remote.snapshotPages.push({
    snapshotSequence: 100, hasMore: false, nextCursor: null, items: [],
  });
  // snapshot 之后服务端又产生了变更
  remote.changesQueue.push({
    serverSequence: 105, nextSequence: 105, hasMore: false, resetRequired: false,
    items: [{ sequence: 105, entityType: "notebook", entityId: lateId, operation: "upsert" }],
  });
  // Change Feed 只给清单，内容从 snapshot 补齐
  remote.snapshotPages.push({
    snapshotSequence: 105, hasMore: false, nextCursor: null,
    items: [{ entityType: "notebook", entityId: lateId, payload: { id: lateId, name: "窗口期新增" } }],
  });

  const progress = await run(remote, ids);

  assert.equal(progress.status, "ready");
  const late = db().prepare("SELECT name FROM notebooks WHERE id = ?").get(lateId) as { name: string } | undefined;
  assert.equal(
    late?.name,
    "窗口期新增",
    "snapshot 下载期间的服务端变更不得丢失",
  );
  assert.equal(
    getSyncState(db(), ids.profileId)?.lastSequence,
    105,
    "游标必须落在收敛点，而不是 snapshot 时刻",
  );
  assert.ok(remote.ackCalls.includes(105));
});

test("verifying 缺少 upsert payload 时失败且不推进游标或 ACK", async () => {
  resetAll();
  const ids = seedProfile();
  const remote = new FakeRemote();
  remote.planSequence = 10;
  remote.snapshotPages.push({
    snapshotSequence: 10, hasMore: false, nextCursor: null, items: [],
  });
  remote.changesQueue.push({
    serverSequence: 11, nextSequence: 11, hasMore: false, resetRequired: false,
    items: [{ sequence: 11, entityType: "mindmap", entityId: "missing-map", operation: "upsert" }],
  });
  remote.snapshotPages.push({
    snapshotSequence: 11, hasMore: false, nextCursor: null, items: [],
  });

  await assert.rejects(() => run(remote, ids), /禁止推进同步游标/);
  assert.equal(getSyncState(db(), ids.profileId), null);
  assert.deepEqual(remote.ackCalls, []);
  assert.equal(getBootstrapProgress(db(), ids.profileId).status, "failed");
});

// ===========================================================================
// 中断与恢复
// ===========================================================================

test("preparing 阶段失败置为 failed，本地数据不受影响", async () => {
  resetAll();
  const ids = seedProfile();
  const nb = makeNotebook("重要笔记本");
  const note = makeNote(nb, "重要笔记");

  const remote = new FakeRemote();
  remote.failOn = "plan";
  await assert.rejects(() => run(remote, ids));

  const progress = getBootstrapProgress(db(), ids.profileId);
  assert.equal(progress.status, "failed");
  assert.equal(progress.error, "NETWORK_UNAVAILABLE");

  // 业务数据完好
  assert.ok(db().prepare("SELECT id FROM notes WHERE id = ?").get(note));
  assert.ok(db().prepare("SELECT id FROM notebooks WHERE id = ?").get(nb));
});

test("失败后重试可从 pending 重新开始并成功", async () => {
  resetAll();
  const ids = seedProfile();
  makeNotebook("本");

  const failing = new FakeRemote();
  failing.failOn = "plan";
  await assert.rejects(() => run(failing, ids));
  assert.equal(getBootstrapProgress(db(), ids.profileId).status, "failed");

  const ok = new FakeRemote();
  const progress = await run(ok, ids);
  assert.equal(progress.status, "ready", "failed 状态必须可重试");
});

test("snapshot 中途失败后重试沿用已记录的 sequence，不重新取 plan", async () => {
  resetAll();
  const ids = seedProfile();

  const failing = new FakeRemote();
  failing.planSequence = 55;
  failing.failOn = "snapshot";
  await assert.rejects(() => run(failing, ids));

  const progress = getBootstrapProgress(db(), ids.profileId);
  assert.equal(progress.status, "failed");
  assert.equal(
    progress.sequence,
    55,
    "high-water sequence 必须落库，否则重试会取到新的 sequence 而漏掉窗口期变更",
  );
});

test("已 ready 时重复调用直接返回，不产生任何网络请求", async () => {
  resetAll();
  const ids = seedProfile();
  const first = new FakeRemote();
  await run(first, ids);
  assert.equal(isBootstrapReady(db(), ids.profileId), true);

  const second = new FakeRemote();
  const progress = await run(second, ids);
  assert.equal(progress.status, "ready");
  assert.equal(second.snapshotCallCount, 0, "幂等：不重复下载");
  assert.equal(second.pushCalls.length, 0, "幂等：不重复上传");
  assert.equal(second.ackCalls.length, 0);
});

// ===========================================================================
// Bootstrap 期间的本地编辑
// ===========================================================================

test("Bootstrap 完成前的本地编辑不写 Outbox，但会被上传", async () => {
  resetAll();
  const ids = seedProfile();
  // seedProfile 后 bootstrapStatus 仍是 pending —— 此时编辑
  const nb = makeNotebook("对账期间新建");
  makeNote(nb, "对账期间的笔记");

  assert.equal(
    countPendingMutations(db()),
    0,
    "基线未建立时触发器不该写 Outbox，否则会推送半成品",
  );

  const remote = new FakeRemote();
  const progress = await run(remote, ids);

  assert.equal(progress.status, "ready");
  const pushedIds = remote.pushCalls.flat().map((m) => m.entityId);
  assert.ok(
    pushedIds.includes(nb),
    "pushing 阶段扫描当前最终状态，天然把期间的编辑一并上传",
  );
});

test("ready 之后本地编辑开始正常写 Outbox", async () => {
  resetAll();
  const ids = seedProfile();
  const remote = new FakeRemote();
  await run(remote, ids);
  db().exec("DELETE FROM sync_outbox");

  const nb = makeNotebook("基线后新建");

  const rows = listPendingMutations(db(), 10, ids.profileId);
  assert.ok(rows.length > 0, "ready 后触发器必须开始工作");
  assert.ok(rows.some((r) => r.entityId === nb));
});

// ===========================================================================
// push 冲突与重置
// ===========================================================================

test("上传时服务端回冲突 → 记入台账，不覆盖也不丢失", async () => {
  resetAll();
  const ids = seedProfile();
  const nb = makeNotebook("本");

  const remote = new FakeRemote();
  remote.conflictMutations.add(`bootstrap-${ids.profileId}-notebook-${nb}`);

  const progress = await run(remote, ids);
  assert.equal(progress.status, "ready");
  assert.ok(progress.conflicts >= 1);

  const conflicts = listUnresolvedConflicts(db());
  const found = conflicts.find((c) => c.entityId === nb);
  assert.ok(found, "被拒绝的上传必须留下可恢复的记录");
  assert.ok(found.localPayload, "本机版本必须保留");
});

test("resetBootstrap 只清对账进度，不动本地数据与 Outbox", async () => {
  resetAll();
  const ids = seedProfile();
  const remote = new FakeRemote();
  await run(remote, ids);

  const nb = makeNotebook("基线后新建");
  const pendingBefore = countPendingMutations(db());
  const conflictBefore = countUnresolvedConflicts(db());
  assert.ok(pendingBefore > 0);

  resetBootstrap(db(), ids.profileId);

  const progress = getBootstrapProgress(db(), ids.profileId);
  assert.equal(progress.status, "pending");
  assert.equal(progress.sequence, null);
  assert.equal(isBootstrapReady(db(), ids.profileId), false);

  assert.ok(db().prepare("SELECT id FROM notebooks WHERE id = ?").get(nb), "本地数据必须保留");
  assert.equal(countPendingMutations(db()), pendingBefore, "未推送的修改不得丢弃");
  assert.equal(countUnresolvedConflicts(db()), conflictBefore, "冲突台账不得清空");
});

test("重置后触发器停止写 Outbox（基线不再可信）", async () => {
  resetAll();
  const ids = seedProfile();
  await run(new FakeRemote(), ids);
  resetBootstrap(db(), ids.profileId);
  db().exec("DELETE FROM sync_outbox");

  makeNotebook("重置后新建");

  assert.equal(
    countPendingMutations(db()),
    0,
    "基线重置后必须重新对账，期间不该产生 mutation",
  );
});
