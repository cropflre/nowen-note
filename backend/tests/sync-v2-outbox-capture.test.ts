import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getDb } from "../src/db/schema";
import {
  countPendingMutations,
  listPendingMutations,
} from "../src/sync/outbox";
import { createProfile, switchActiveProfile } from "../src/sync/profile";
import { ensureDevice } from "../src/sync/device";
import { runWithOutboxSuppressed } from "../src/sync/context";
import { runChangeFeedSuppressed } from "../src/sync/suppression";

/**
 * 上行链路契约（migration v85）。
 *
 * 这组测试守护的是此前完全缺失的能力：**本地业务写入进入 Outbox**。
 *
 * 之前 Phase 4 的引擎测试全部用 enqueueMutation() 手工造数据，
 * 因此"没有任何路径把本地变更写入 sync_outbox"这个断点被测试全绿掩盖了。
 * 这里一律通过真实的 INSERT/UPDATE/DELETE 业务表来驱动，不调用任何 sync API 造数据。
 */

const USER_ID = "outbox-capture-user";

function db() {
  return getDb();
}

function resetAll(): void {
  const d = db();
  d.exec(`
    DELETE FROM sync_outbox;
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
  d.prepare(`
    INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, 'x', datetime('now'), datetime('now'))
  `).run(USER_ID, USER_ID);
}

/**
 * 建立"已开启同步且基线已建立"状态。
 *
 * 三个条件缺一不可（v87 闸门 + v89 闸门）：
 * enabled profile + 本机设备 + bootstrapStatus='ready'。
 * 基线未建立时触发器刻意不写 Outbox，避免推送半成品。
 */
function enableSync(): { profileId: string; deviceId: string } {
  const d = db();
  const profile = createProfile(d, { name: "测试服务器", serverUrl: "http://sync.test" });
  switchActiveProfile(d, profile.id);
  d.prepare(
    "UPDATE sync_profiles SET bootstrapStatus = 'ready', bootstrapReadyAt = datetime('now') WHERE id = ?",
  ).run(profile.id);
  const device = ensureDevice(d, { profileId: profile.id, platform: "win32" });
  return { profileId: profile.id, deviceId: device.id };
}

function createNotebook(id = randomUUID()): string {
  db().prepare(`
    INSERT INTO notebooks (id, userId, name, icon, sortOrder, createdAt, updatedAt)
    VALUES (?, ?, '测试本', '📒', 0, datetime('now'), datetime('now'))
  `).run(id, USER_ID);
  return id;
}

function createNote(notebookId: string, id = randomUUID()): string {
  db().prepare(`
    INSERT INTO notes (
      id, userId, notebookId, title, content, contentText, contentFormat,
      version, sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, '标题', '{}', '正文', 'richtext', 1, 0, datetime('now'), datetime('now'))
  `).run(id, USER_ID, notebookId);
  return id;
}

// ---------------------------------------------------------------------------
// 仅此设备：绝不写 Outbox（阶段 C 的核心要求）
// ---------------------------------------------------------------------------

test("仅此设备模式下的 CRUD 完全不产生 Outbox 条目", () => {
  resetAll();
  // 不建任何 profile —— 这就是"仅此设备"
  const nb = createNotebook();
  const note = createNote(nb);
  db().prepare("UPDATE notes SET title = '改过' WHERE id = ?").run(note);
  db().prepare("DELETE FROM notes WHERE id = ?").run(note);

  assert.equal(
    countPendingMutations(db()),
    0,
    "仅此设备模式绝不能产生同步队列条目",
  );
});

test("Profile 存在但未启用时同样不写 Outbox", () => {
  resetAll();
  const d = db();
  const profile = createProfile(d, { name: "未启用", serverUrl: "http://off.test" });
  ensureDevice(d, { profileId: profile.id, platform: "win32" });
  // 刻意不 setProfileEnabled

  createNote(createNotebook());
  assert.equal(countPendingMutations(d), 0);
});

// ---------------------------------------------------------------------------
// 开启同步：本地写入必须进 Outbox
// ---------------------------------------------------------------------------

test("开启同步后创建笔记本会自动进入 Outbox", () => {
  resetAll();
  const { profileId, deviceId } = enableSync();
  const nb = createNotebook();

  const pending = listPendingMutations(db(), 20, profileId);
  const row = pending.find((r) => r.entityId === nb);
  assert.ok(row, "创建笔记本必须产生 mutation");
  assert.equal(row.entityType, "notebook");
  assert.equal(row.operation, "upsert");
  assert.equal(row.profileId, profileId, "必须绑定到当前 active profile");
  assert.equal(row.deviceId, deviceId, "必须使用本机安装级 deviceId");

  const payload = JSON.parse(row.payload as string);
  assert.equal(payload.name, "测试本");
  assert.equal(payload.icon, "📒");
});

test("创建笔记进入 Outbox，且 upsert 顺序在其笔记本之后", () => {
  resetAll();
  const { profileId } = enableSync();
  const nb = createNotebook();
  const note = createNote(nb);

  const pending = listPendingMutations(db(), 20, profileId);
  const nbIndex = pending.findIndex((r) => r.entityId === nb);
  const noteIndex = pending.findIndex((r) => r.entityId === note);
  assert.ok(nbIndex >= 0 && noteIndex >= 0);
  assert.ok(
    nbIndex < noteIndex,
    "父实体必须先于子实体推送，否则服务端会因缺少 notebook 而拒绝",
  );

  const payload = JSON.parse(pending[noteIndex].payload as string);
  assert.equal(payload.title, "标题");
  assert.equal(payload.notebookId, nb);
});

test("修改笔记携带 OLD.version 作为 baseVersion，供服务端判冲突", () => {
  resetAll();
  const { profileId } = enableSync();
  const note = createNote(createNotebook());
  db().exec("DELETE FROM sync_outbox");

  // 模拟一次正常的业务更新：内容变、version 递增
  db().prepare("UPDATE notes SET title = ?, version = version + 1 WHERE id = ?")
    .run("新标题", note);

  const rows = listPendingMutations(db(), 10, profileId)
    .filter((r) => r.entityId === note);
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].baseVersion,
    1,
    "baseVersion 必须是本次修改所基于的旧版本，而不是新版本",
  );
  const payload = JSON.parse(rows[0].payload as string);
  assert.equal(payload.version, 2, "payload 携带新版本");
});

test("删除笔记产生 delete mutation 且带 baseVersion", () => {
  resetAll();
  const { profileId } = enableSync();
  const note = createNote(createNotebook());
  db().exec("DELETE FROM sync_outbox");

  db().prepare("DELETE FROM notes WHERE id = ?").run(note);

  const rows = listPendingMutations(db(), 10, profileId)
    .filter((r) => r.entityId === note);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation, "delete");
  assert.equal(rows[0].baseVersion, 1);
  assert.equal(rows[0].payload, null, "delete 不需要 payload");
});

test("标签与笔记标签关系都会进入 Outbox", () => {
  resetAll();
  const { profileId } = enableSync();
  const note = createNote(createNotebook());
  const tagId = randomUUID();
  db().prepare(`
    INSERT INTO tags (id, userId, name, createdAt) VALUES (?, ?, '工作', datetime('now'))
  `).run(tagId, USER_ID);
  db().prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, ?)").run(note, tagId);

  const pending = listPendingMutations(db(), 30, profileId);
  assert.ok(pending.some((r) => r.entityType === "tag" && r.entityId === tagId));

  const rel = pending.find((r) => r.entityType === "note_tag");
  assert.ok(rel, "笔记标签关系必须独立同步，而不是折算成 note upsert");
  assert.equal(
    rel.entityId,
    `${note}:${tagId}`,
    "关系型实体使用确定性复合 ID，两端各自建立时结果一致",
  );
});

test("附件元数据进入 Outbox 且不泄漏服务器文件路径", () => {
  resetAll();
  const { profileId } = enableSync();
  const note = createNote(createNotebook());
  const attId = randomUUID();
  db().prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, hash)
    VALUES (?, ?, ?, '图.png', 'image/png', 1024, '/srv/nowen/data/att/xx.png', 'h1')
  `).run(attId, note, USER_ID);

  const row = listPendingMutations(db(), 30, profileId)
    .find((r) => r.entityType === "attachment" && r.entityId === attId);
  assert.ok(row);
  const payload = JSON.parse(row.payload as string);
  assert.equal(payload.filename, "图.png");
  assert.equal(payload.size, 1024);
  assert.equal(
    payload.path,
    undefined,
    "绝不能把服务器本机路径同步出去",
  );
});

// ---------------------------------------------------------------------------
// 防回环：应用远端变更不得回流
// ---------------------------------------------------------------------------

test("在双层抑制下应用远端变更不产生 Outbox 条目", () => {
  resetAll();
  const { profileId } = enableSync();
  const nb = createNotebook();
  db().exec("DELETE FROM sync_outbox");

  // 模拟 applyLocal：Node 侧 + SQLite 侧同时抑制
  runWithOutboxSuppressed(() => {
    runChangeFeedSuppressed(db(), () => {
      db().prepare("UPDATE notebooks SET name = '远端改名' WHERE id = ?").run(nb);
      createNote(nb);
    });
  });

  assert.equal(
    listPendingMutations(db(), 10, profileId).length,
    0,
    "远端变更回流会形成 Pull → Apply → Push 无限循环",
  );
  // 但业务数据确实已写入
  const name = db().prepare("SELECT name FROM notebooks WHERE id = ?").get(nb) as { name: string };
  assert.equal(name.name, "远端改名");
});

test("抑制结束后本地写入重新进入 Outbox", () => {
  resetAll();
  const { profileId } = enableSync();
  const nb = createNotebook();
  runChangeFeedSuppressed(db(), () => {
    db().prepare("UPDATE notebooks SET name = '远端' WHERE id = ?").run(nb);
  });
  db().exec("DELETE FROM sync_outbox");

  db().prepare("UPDATE notebooks SET name = '本地' WHERE id = ?").run(nb);
  assert.equal(
    listPendingMutations(db(), 10, profileId).length,
    1,
    "抑制必须是作用域内生效，不能永久关闭捕获",
  );
});

// ---------------------------------------------------------------------------
// 作用域：工作区数据不进第一版同步
// ---------------------------------------------------------------------------

test("工作区笔记不进入 Outbox（Sync V2 第一版只覆盖个人空间）", () => {
  resetAll();
  const { profileId } = enableSync();
  const d = db();
  d.prepare(`
    INSERT INTO workspaces (id, name, ownerId, createdAt, updatedAt)
    VALUES ('ws1', '团队', ?, datetime('now'), datetime('now'))
  `).run(USER_ID);
  const nbId = randomUUID();
  d.prepare(`
    INSERT INTO notebooks (id, userId, name, icon, sortOrder, workspaceId, createdAt, updatedAt)
    VALUES (?, ?, '团队本', '📒', 0, 'ws1', datetime('now'), datetime('now'))
  `).run(nbId, USER_ID);
  d.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText,
      contentFormat, version, sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'ws1', 'T', '{}', 'x', 'richtext', 1, 0, datetime('now'), datetime('now'))
  `).run(randomUUID(), USER_ID, nbId);

  assert.equal(
    listPendingMutations(d, 10, profileId).length,
    0,
    "工作区离线编辑涉及 ACL 与权限撤销，不在第一版协议内",
  );
});

// ---------------------------------------------------------------------------
// mutationId 唯一性
// ---------------------------------------------------------------------------

test("批量写入产生的 mutationId 互不重复", () => {
  resetAll();
  const { profileId } = enableSync();
  const nb = createNotebook();
  for (let i = 0; i < 50; i += 1) createNote(nb);

  const rows = listPendingMutations(db(), 200, profileId);
  const ids = new Set(rows.map((r) => r.mutationId));
  assert.equal(ids.size, rows.length, "mutationId 重复会让幂等台账错判为已处理");
  assert.ok(rows.length >= 51);
});
