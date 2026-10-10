import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getDb } from "../src/db/schema";
import {
  countPendingMutations,
  enqueueMutation,
  listPendingMutations,
} from "../src/sync/outbox";
import {
  createProfile,
  disableAllProfiles,
  getActiveProfile,
  setProfileEnabled,
  switchActiveProfile,
} from "../src/sync/profile";
import {
  ensureDevice,
  ensureInstallationDevice,
  getInstallationDeviceId,
  listProfileDevices,
  touchDevice,
} from "../src/sync/device";

/**
 * 阶段 A + B + C 契约（migration v88）。
 *
 * A：一个本地库同时最多一个 Active SyncProfile（DB 约束 + 业务事务双保险）
 * B：deviceId 是安装级的，切服务器不变
 * C：sync_outbox.profileId NOT NULL，仅此设备绝不写 Outbox
 */

const USER_ID = "identity-outbox-user";

function db() {
  return getDb();
}

function resetAll(): void {
  const d = db();
  d.exec(`
    DELETE FROM sync_outbox;
    DELETE FROM sync_outbox_legacy_unbound;
    DELETE FROM sync_state;
    DELETE FROM sync_profile_devices;
    DELETE FROM sync_device_identity;
    DELETE FROM sync_devices;
    DELETE FROM sync_profiles;
    DELETE FROM note_tags;
    DELETE FROM notes;
    DELETE FROM notebooks;
  `);
  d.prepare(`
    INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, 'x', datetime('now'), datetime('now'))
  `).run(USER_ID, USER_ID);
}

function makeProfile(name: string, url: string) {
  return createProfile(db(), { name, serverUrl: url });
}

/**
 * 标记基线已建立。
 *
 * v89 的闸门要求 bootstrapStatus='ready' 才写 Outbox。凡是要验证
 * "触发器确实产生了 mutation" 的用例都需要先置位，否则测的是闸门
 * 而不是捕获逻辑（Bootstrap 本身有独立测试文件）。
 */
function markReady(profileId: string): void {
  db().prepare(
    "UPDATE sync_profiles SET bootstrapStatus = 'ready', bootstrapReadyAt = datetime('now') WHERE id = ?",
  ).run(profileId);
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

function createNotebook(id = randomUUID()): string {
  db().prepare(`
    INSERT INTO notebooks (id, userId, name, icon, sortOrder, createdAt, updatedAt)
    VALUES (?, ?, '本', '📒', 0, datetime('now'), datetime('now'))
  `).run(id, USER_ID);
  return id;
}

// ===========================================================================
// 阶段 A：Active Profile 唯一性
// ===========================================================================

test("A: 数据库层直接写入第二个 enabled=1 会被拒绝", () => {
  resetAll();
  const d = db();
  const a = makeProfile("服务器 A", "http://a.test");
  const b = makeProfile("服务器 B", "http://b.test");

  setProfileEnabled(d, a.id, true);

  assert.throws(
    () => setProfileEnabled(d, b.id, true),
    /UNIQUE|CONSTRAINT/i,
    "partial unique index 必须挡住第二个 active profile",
  );
  // A 仍然是唯一 active
  assert.equal(getActiveProfile(d)?.id, a.id);
});

test("A: 多个 enabled=0 允许共存（未启用的历史配置不受影响）", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  const b = makeProfile("B", "http://b.test");
  const c = makeProfile("C", "http://c.test");
  // 三个都是默认 enabled=0
  const count = (d.prepare(
    "SELECT COUNT(*) AS c FROM sync_profiles WHERE enabled = 0",
  ).get() as { c: number }).c;
  assert.equal(count, 3);
  assert.equal(getActiveProfile(d), null, "没有启用任何 Profile 即仅此设备");
  assert.ok(a.id && b.id && c.id);
});

test("A: switchActiveProfile 从 A 切到 B 后 A 自动停用", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  const b = makeProfile("B", "http://b.test");

  switchActiveProfile(d, a.id);
  assert.equal(getActiveProfile(d)?.id, a.id);

  switchActiveProfile(d, b.id);
  assert.equal(getActiveProfile(d)?.id, b.id);

  const enabledIds = d.prepare(
    "SELECT id FROM sync_profiles WHERE enabled = 1",
  ).all() as Array<{ id: string }>;
  assert.equal(enabledIds.length, 1, "任何时刻最多一个 active");
  assert.equal(enabledIds[0].id, b.id);
});

test("A: 重复切到已启用的 Profile 是幂等的，不会触发索引冲突", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  switchActiveProfile(d, a.id);
  assert.doesNotThrow(() => switchActiveProfile(d, a.id));
  assert.equal(getActiveProfile(d)?.id, a.id);
});

test("A: switchActiveProfile 目标不存在时整体回滚，原 active 不受影响", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  switchActiveProfile(d, a.id);

  assert.throws(() => switchActiveProfile(d, "not-exist-id"), /不存在/);
  assert.equal(
    getActiveProfile(d)?.id,
    a.id,
    "失败的切换不能把用户置于「谁都没启用」的状态",
  );
});

test("A: disableAllProfiles 停用全部但不删除任何本地数据", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  switchActiveProfile(d, a.id);
  markReady(a.id);
  ensureDevice(d, { profileId: a.id, platform: "win32" });
  const nb = createNotebook();
  const note = createNote(nb);

  const disabled = disableAllProfiles(d);
  assert.deepEqual(disabled, [a.id]);
  assert.equal(getActiveProfile(d), null);

  // Profile 本身还在，只是停用
  assert.equal(
    (d.prepare("SELECT COUNT(*) AS c FROM sync_profiles").get() as { c: number }).c,
    1,
  );
  // 业务数据完好
  assert.ok(d.prepare("SELECT id FROM notes WHERE id = ?").get(note));
  assert.ok(d.prepare("SELECT id FROM notebooks WHERE id = ?").get(nb));
  // 未推送的 Outbox 保留
  assert.ok(
    countPendingMutations(d) > 0,
    "关闭同步不得丢弃未推送的修改",
  );
});

// ===========================================================================
// 阶段 B：Installation-scoped Device ID
// ===========================================================================

test("B: 同一安装实例连不同服务器 deviceId 相同", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  const b = makeProfile("B", "http://b.test");

  const devA = ensureDevice(d, { profileId: a.id, platform: "win32" });
  const devB = ensureDevice(d, { profileId: b.id, platform: "win32" });

  assert.equal(
    devA.id,
    devB.id,
    "设备是物理安装实例，与连哪个服务器无关",
  );
  assert.equal(devA.id, getInstallationDeviceId(d));
});

test("B: membership 按 Profile 分别记录，但指向同一 deviceId", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  const b = makeProfile("B", "http://b.test");
  ensureDevice(d, { profileId: a.id, platform: "win32" });
  ensureDevice(d, { profileId: b.id, platform: "win32" });

  const memA = listProfileDevices(d, a.id);
  const memB = listProfileDevices(d, b.id);
  assert.equal(memA.length, 1);
  assert.equal(memB.length, 1);
  assert.equal(memA[0].id, memB[0].id);
  assert.notEqual(memA[0].profileId, memB[0].profileId);
});

test("B: 反复调用 ensureInstallationDevice 不会生成第二个身份", () => {
  resetAll();
  const d = db();
  const first = ensureInstallationDevice(d, { platform: "win32" });
  const second = ensureInstallationDevice(d, { platform: "win32" });
  const third = ensureInstallationDevice(d, { deviceName: "改名了" });

  assert.equal(first.deviceId, second.deviceId);
  assert.equal(first.deviceId, third.deviceId, "改名不改变 deviceId");
  assert.equal(third.deviceName, "改名了");

  const rows = d.prepare("SELECT COUNT(*) AS c FROM sync_device_identity").get() as { c: number };
  assert.equal(rows.c, 1, "单例表物理上只能有一行");
});

test("B: 单例表拒绝写入第二行", () => {
  resetAll();
  const d = db();
  ensureInstallationDevice(d, { platform: "win32" });
  assert.throws(
    () => d.prepare(
      "INSERT INTO sync_device_identity (singletonKey, deviceId) VALUES (2, ?)",
    ).run(randomUUID()),
    /CHECK|CONSTRAINT/i,
  );
});

test("B: 关闭再开启同步不改变 deviceId", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  switchActiveProfile(d, a.id);
  const before = ensureDevice(d, { profileId: a.id, platform: "win32" }).id;

  disableAllProfiles(d);
  switchActiveProfile(d, a.id);
  const after = ensureDevice(d, { profileId: a.id, platform: "win32" }).id;

  assert.equal(before, after);
});

test("B: touchDevice 更新全部 membership 的 lastSeenAt", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  const b = makeProfile("B", "http://b.test");
  const dev = ensureDevice(d, { profileId: a.id, platform: "win32" });
  ensureDevice(d, { profileId: b.id, platform: "win32" });

  touchDevice(d, dev.id);
  for (const pid of [a.id, b.id]) {
    const row = listProfileDevices(d, pid)[0];
    assert.ok(row.lastSeenAt, `${pid} 的 lastSeenAt 应被更新`);
  }
});

// ===========================================================================
// 阶段 C：Outbox profileId NOT NULL
// ===========================================================================

test("C: 数据库拒绝 profileId 为 NULL 的 Outbox 条目", () => {
  resetAll();
  const d = db();
  assert.throws(
    () => d.prepare(`
      INSERT INTO sync_outbox (
        id, mutationId, profileId, deviceId, entityType, entityId,
        operation, status, retryCount, createdAt
      ) VALUES (?, ?, NULL, 'dev', 'note', 'n1', 'upsert', 'pending', 0, datetime('now'))
    `).run(randomUUID(), randomUUID()),
    /NOT NULL|CONSTRAINT/i,
  );
});

test("C: enqueueMutation 缺少 profileId 时早失败", () => {
  resetAll();
  assert.throws(
    () => enqueueMutation(db(), {
      entityType: "note",
      entityId: randomUUID(),
      operation: "upsert",
      deviceId: "dev-1",
      // @ts-expect-error 故意省略以验证运行时守卫
      profileId: undefined,
    }),
    /profileId/,
    "仅此设备模式不该产生 Outbox 条目",
  );
});

test("C: listPendingMutations 严格按 Profile 隔离", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  const b = makeProfile("B", "http://b.test");
  const dev = ensureInstallationDevice(d, { platform: "win32" }).deviceId;

  enqueueMutation(d, {
    entityType: "note", entityId: "note-a", operation: "upsert",
    deviceId: dev, profileId: a.id, payload: { title: "A" },
  });
  enqueueMutation(d, {
    entityType: "note", entityId: "note-b", operation: "upsert",
    deviceId: dev, profileId: b.id, payload: { title: "B" },
  });

  const forA = listPendingMutations(d, 20, a.id);
  assert.equal(forA.length, 1);
  assert.equal(forA[0].entityId, "note-a", "A 的队列绝不能含 B 的 mutation");

  const forB = listPendingMutations(d, 20, b.id);
  assert.equal(forB.length, 1);
  assert.equal(forB[0].entityId, "note-b");
});

test("C: 仅此设备模式下真实业务 CRUD 不产生任何 Outbox 条目", () => {
  resetAll();
  // 无 active profile
  const nb = createNotebook();
  const note = createNote(nb);
  db().prepare("UPDATE notes SET title = '改' WHERE id = ?").run(note);
  db().prepare("DELETE FROM notes WHERE id = ?").run(note);

  assert.equal(countPendingMutations(db()), 0);
});

test("C: 开启同步后业务 CRUD 产生的条目都带 profileId", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  switchActiveProfile(d, a.id);
  markReady(a.id);
  ensureDevice(d, { profileId: a.id, platform: "win32" });

  createNote(createNotebook());

  const rows = listPendingMutations(d, 20, a.id);
  assert.ok(rows.length >= 2, "笔记本 + 笔记");
  for (const row of rows) {
    assert.equal(row.profileId, a.id);
    assert.ok(row.deviceId, "deviceId 不得为空");
  }
});

test("C: 归档表存在且默认为空（无脏数据时不产生噪音）", () => {
  resetAll();
  const count = db().prepare(
    "SELECT COUNT(*) AS c FROM sync_outbox_legacy_unbound",
  ).get() as { c: number };
  assert.equal(count.c, 0);
});

test("C: 重建表后索引与幂等约束仍然生效", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  const dev = ensureInstallationDevice(d, { platform: "win32" }).deviceId;
  const mid = randomUUID();

  enqueueMutation(d, {
    entityType: "note", entityId: "n1", operation: "upsert",
    deviceId: dev, profileId: a.id, mutationId: mid,
  });
  assert.throws(
    () => enqueueMutation(d, {
      entityType: "note", entityId: "n2", operation: "upsert",
      deviceId: dev, profileId: a.id, mutationId: mid,
    }),
    /UNIQUE|CONSTRAINT/i,
    "mutationId 唯一约束必须在表重建后保留",
  );

  const indexes = d.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='index' AND tbl_name='sync_outbox' AND name LIKE 'idx_%'
  `).all() as Array<{ name: string }>;
  const names = indexes.map((i) => i.name);
  for (const expected of [
    "idx_sync_outbox_pending",
    "idx_sync_outbox_profile",
    "idx_sync_outbox_entity",
  ]) {
    assert.ok(names.includes(expected), `${expected} 应在重建后重新创建`);
  }
});

test("C: 删除 Profile 时其队列条目级联清除，业务数据不受影响", () => {
  resetAll();
  const d = db();
  const a = makeProfile("A", "http://a.test");
  switchActiveProfile(d, a.id);
  markReady(a.id);
  ensureDevice(d, { profileId: a.id, platform: "win32" });
  const nb = createNotebook();
  const note = createNote(nb);
  assert.ok(countPendingMutations(d) > 0);

  d.prepare("DELETE FROM sync_profiles WHERE id = ?").run(a.id);

  assert.equal(
    countPendingMutations(d),
    0,
    "Profile 不存在时其 mutation 无处可推，级联清除避免孤儿条目",
  );
  // 业务数据必须完好 —— 这是删除同步关系，不是删除笔记
  assert.ok(d.prepare("SELECT id FROM notes WHERE id = ?").get(note));
  assert.ok(d.prepare("SELECT id FROM notebooks WHERE id = ?").get(nb));
});
