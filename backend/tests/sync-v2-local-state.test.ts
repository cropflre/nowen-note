import assert from "node:assert/strict";
import test from "node:test";
import type Database from "better-sqlite3";

import { syncV2LocalStateMigration } from "../src/db/syncV2LocalStateMigration";
import { MIGRATIONS } from "../src/db/migrations";
import {
  countPendingMutations,
  enqueueMutation,
  listPendingMutations,
  markMutationFailed,
  markMutationInflight,
  markMutationSynced,
  recoverInflightMutations,
  withMutation,
} from "../src/sync/outbox";
import { ensureDevice, touchDevice } from "../src/sync/device";
import {
  advanceSyncState,
  createProfile,
  disableProfile,
  findProfileByServer,
  getProfile,
  getSyncState,
  resetSyncState,
  setProfileEnabled,
} from "../src/sync/profile";
import {
  countUnresolvedConflicts,
  getConflict,
  listUnresolvedConflicts,
  recordConflict,
  resolveConflict,
} from "../src/sync/conflict";
import { runWithOutboxSuppressed } from "../src/sync/context";
import { getDb } from "../src/db/schema";

/**
 * 复用项目自身的数据库连接（setup-db-isolation 已把 DB_PATH 指向临时目录），
 * 每个用例前清空同步表，保证互不干扰。
 *
 * 之所以不自建 better-sqlite3 连接：项目对 DB 路径有 test guard 与 PRAGMA 约定，
 * 绕过 getDb 既容易偏离真实运行环境，也会踩到原生模块的路径解析问题。
 */
function freshDb(): Database.Database {
  const db = getDb();
  // v81 已在 runMigrations 中执行；这里只清数据，不重复建表。
  db.exec(`
    DELETE FROM sync_conflicts;
    DELETE FROM sync_outbox;
    DELETE FROM sync_applied_mutations;
    DELETE FROM sync_state;
    DELETE FROM sync_devices;
    DELETE FROM sync_profiles;
  `);
  return db;
}

function seedProfile(db: Database.Database) {
  const profile = createProfile(db, {
    name: "我的 Nowen Server",
    serverUrl: "http://192.168.1.10:3000/",
  });
  const device = ensureDevice(db, {
    profileId: profile.id,
    deviceName: "工作本",
    platform: "win32",
  });
  return { profile, device };
}

// ---------------------------------------------------------------------------
// 迁移本身
// ---------------------------------------------------------------------------

test("v81 正确注册到迁移链且版本号无冲突", () => {
  assert.equal(syncV2LocalStateMigration.version, 81);

  const versions = MIGRATIONS.map((m) => m.version);
  // 版本号不得重复：重复会让迁移链在部分用户机器上乱序执行。
  assert.equal(new Set(versions).size, versions.length);
  // 只断言 v81 存在且唯一。不锁定"最大版本"，否则后续每加一条迁移
  // 都会误报失败——这正是 migration-task-version-compatibility 踩过的坑。
  assert.equal(versions.filter((v) => v === 81).length, 1);
  // v81 之前的版本必须都已存在，确认是追加而非插队。
  assert.ok(versions.includes(80), "v81 应追加在既有链尾之后");
});

test("迁移可重复执行（IF NOT EXISTS），升级中断后重跑不报错", () => {
  const db = freshDb();
  // 全部语句都是 CREATE ... IF NOT EXISTS，因此在已迁移的库上重跑必须安全。
  assert.doesNotThrow(() => syncV2LocalStateMigration.up(db));
  assert.doesNotThrow(() => syncV2LocalStateMigration.up(db));
});

test("六张同步表全部建立且初始为空，对现有用户无感", () => {
  const db = freshDb();
  const tables = [
    "sync_profiles",
    "sync_devices",
    "sync_state",
    "sync_outbox",
    "sync_applied_mutations",
    "sync_conflicts",
  ];
  for (const table of tables) {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table) as { name?: string } | undefined;
    assert.equal(row?.name, table, `${table} 未建立`);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
    assert.equal(count.c, 0, `${table} 升级后必须为空`);
  }
});

test("v81 的六张状态表上不挂触发器，本地状态只由代码显式写入", () => {
  const db = freshDb();
  // v82 的 Change Feed 触发器名为 sync_v2_*，挂在业务表上，与此处无关。
  // 这里要确认的是：v81 建的状态表自身没有隐式触发器，
  // 否则 Outbox 的写入时机将不可控。
  const triggers = db.prepare(`
    SELECT name, tbl_name FROM sqlite_master
    WHERE type = 'trigger'
      AND tbl_name IN (
        'sync_profiles', 'sync_devices', 'sync_state',
        'sync_outbox', 'sync_applied_mutations', 'sync_conflicts'
      )
  `).all();
  assert.deepEqual(triggers, []);
});

// ---------------------------------------------------------------------------
// Outbox：原子性与不丢数据
// ---------------------------------------------------------------------------

test("mutationId 唯一，重复入队被数据库拒绝", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  const base = {
    entityType: "note" as const,
    entityId: "note-1",
    operation: "upsert" as const,
    deviceId: device.id,
    profileId: profile.id,
    mutationId: "fixed-mutation",
  };
  enqueueMutation(db, base);
  assert.throws(() => enqueueMutation(db, base), /UNIQUE/i);
});

test("withMutation 把业务写入与入队包成一个事务，业务失败则不留 mutation", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  db.exec("DROP TABLE IF EXISTS demo_notes; CREATE TABLE demo_notes (id TEXT PRIMARY KEY, title TEXT)");

  assert.throws(() => {
    withMutation(
      db,
      {
        entityType: "note",
        entityId: "note-x",
        operation: "upsert",
        deviceId: device.id,
        profileId: profile.id,
      },
      () => {
        db.prepare("INSERT INTO demo_notes (id, title) VALUES (?, ?)").run("note-x", "草稿");
        throw new Error("业务写入失败");
      },
    );
  }, /业务写入失败/);

  // 事务回滚：业务行和 mutation 都不该存在，不允许只留下一半。
  const notes = db.prepare("SELECT COUNT(*) AS c FROM demo_notes").get() as { c: number };
  assert.equal(notes.c, 0);
  assert.equal(countPendingMutations(db), 0);
});

test("withMutation 成功时业务行与 mutation 同时可见", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  db.exec("DROP TABLE IF EXISTS demo_notes; CREATE TABLE demo_notes (id TEXT PRIMARY KEY, title TEXT)");

  const returned = withMutation(
    db,
    {
      entityType: "note",
      entityId: "note-y",
      operation: "upsert",
      deviceId: device.id,
      profileId: profile.id,
      baseVersion: 3,
      payload: { title: "标题" },
    },
    () => {
      db.prepare("INSERT INTO demo_notes (id, title) VALUES (?, ?)").run("note-y", "标题");
      return "ok";
    },
  );

  assert.equal(returned, "ok");
  const notes = db.prepare("SELECT COUNT(*) AS c FROM demo_notes").get() as { c: number };
  assert.equal(notes.c, 1);

  const pending = listPendingMutations(db, 10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].entityId, "note-y");
  assert.equal(pending[0].baseVersion, 3);
  assert.equal(pending[0].status, "pending");
  assert.deepEqual(JSON.parse(pending[0].payload as string), { title: "标题" });
});

test("应用远端变更时不入队，避免 Pull→Apply→Push 无限回环", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);

  const result = runWithOutboxSuppressed(() => enqueueMutation(db, {
    entityType: "note",
    entityId: "note-from-server",
    operation: "upsert",
    deviceId: device.id,
    profileId: profile.id,
  }));

  assert.equal(result, null);
  assert.equal(countPendingMutations(db), 0);

  // 抑制上下文结束后，用户自己的修改必须正常入队。
  enqueueMutation(db, {
    entityType: "note",
    entityId: "note-local",
    operation: "upsert",
    deviceId: device.id,
    profileId: profile.id,
  });
  assert.equal(countPendingMutations(db), 1);
});

test("重试次数增长但条目永不被自动删除", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  const mutationId = enqueueMutation(db, {
    entityType: "note",
    entityId: "note-retry",
    operation: "upsert",
    deviceId: device.id,
    profileId: profile.id,
  }) as string;

  for (let i = 0; i < 50; i += 1) {
    markMutationFailed(db, mutationId, "NETWORK_UNAVAILABLE");
  }

  const rows = listPendingMutations(db, 10);
  assert.equal(rows.length, 1, "失败 50 次后条目仍必须存在");
  assert.equal(rows[0].retryCount, 50);
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].lastError, "NETWORK_UNAVAILABLE");
});

test("failed 不是终态，仍会被 Push 取出重试", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  const id = enqueueMutation(db, {
    entityType: "note",
    entityId: "note-f",
    operation: "upsert",
    deviceId: device.id,
    profileId: profile.id,
  }) as string;
  markMutationFailed(db, id, "SERVER_ERROR");
  assert.equal(listPendingMutations(db, 10).length, 1);
  assert.equal(countPendingMutations(db), 1);
});

test("强杀进程后 inflight 条目复位为 pending，同步可继续", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  const id = enqueueMutation(db, {
    entityType: "note",
    entityId: "note-killed",
    operation: "upsert",
    deviceId: device.id,
    profileId: profile.id,
  }) as string;

  markMutationInflight(db, id);
  // 模拟进程被强杀：inflight 条目不会被任何路径取出
  assert.equal(listPendingMutations(db, 10).length, 0);

  const recovered = recoverInflightMutations(db);
  assert.equal(recovered, 1);
  assert.equal(listPendingMutations(db, 10).length, 1);
});

test("推送成功是唯一删除 Outbox 条目的路径", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  const id = enqueueMutation(db, {
    entityType: "note",
    entityId: "note-done",
    operation: "upsert",
    deviceId: device.id,
    profileId: profile.id,
  }) as string;
  markMutationSynced(db, id);
  assert.equal(countPendingMutations(db), 0);
});

test("按创建顺序推送，保证先父后子的因果顺序", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  const order = ["notebook-1", "note-1", "note-2"];
  for (const entityId of order) {
    enqueueMutation(db, {
      entityType: entityId.startsWith("notebook") ? "notebook" : "note",
      entityId,
      operation: "upsert",
      deviceId: device.id,
      profileId: profile.id,
    });
  }
  const rows = listPendingMutations(db, 10);
  assert.deepEqual(rows.map((r) => r.entityId), order);
});

test("关闭同步期间产生的 mutation（profileId 为空）在开启后一并补传", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  enqueueMutation(db, {
    entityType: "note",
    entityId: "note-offline-period",
    operation: "upsert",
    deviceId: device.id,
    profileId: null,
  });
  const rows = listPendingMutations(db, 10, profile.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entityId, "note-offline-period");
});

test("删除笔记的 mutation 不因业务行消失而被级联清除", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  enqueueMutation(db, {
    entityType: "note",
    entityId: "note-deleted",
    operation: "delete",
    deviceId: device.id,
    profileId: profile.id,
  });
  // entityId 上没有外键，因此业务表里没有这条笔记也不影响 mutation 存活。
  const rows = listPendingMutations(db, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation, "delete");
});

test("拒绝越界实体类型与非法操作，防止范围失控", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  assert.throws(() => enqueueMutation(db, {
    entityType: "task" as never,
    entityId: "task-1",
    operation: "upsert",
    deviceId: device.id,
    profileId: profile.id,
  }), /CHECK/i);

  assert.throws(() => enqueueMutation(db, {
    entityType: "note",
    entityId: "note-1",
    operation: "update" as never,
    deviceId: device.id,
    profileId: profile.id,
  }), /CHECK/i);
});

test("缺少 entityId 或 deviceId 时立即报错，不写入残缺 mutation", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  assert.throws(() => enqueueMutation(db, {
    entityType: "note",
    entityId: "",
    operation: "upsert",
    deviceId: device.id,
    profileId: profile.id,
  }), /entityId/);

  assert.throws(() => enqueueMutation(db, {
    entityType: "note",
    entityId: "note-1",
    operation: "upsert",
    deviceId: "",
    profileId: profile.id,
  }), /deviceId/);

  assert.equal(countPendingMutations(db), 0);
});

// ---------------------------------------------------------------------------
// Device：稳定身份
// ---------------------------------------------------------------------------

test("deviceId 反复调用保持稳定，不会被当成多台新设备", () => {
  const db = freshDb();
  const profile = createProfile(db, { name: "srv", serverUrl: "http://a.test" });
  const first = ensureDevice(db, { profileId: profile.id, deviceName: "本机", platform: "win32" });
  const second = ensureDevice(db, { profileId: profile.id, deviceName: "本机", platform: "win32" });
  assert.equal(first.id, second.id);

  const count = db.prepare("SELECT COUNT(*) AS c FROM sync_devices").get() as { c: number };
  assert.equal(count.c, 1);
});

test("设备改名不改变 deviceId", () => {
  const db = freshDb();
  const profile = createProfile(db, { name: "srv", serverUrl: "http://a.test" });
  const first = ensureDevice(db, { profileId: profile.id, deviceName: "旧名", platform: "win32" });
  const renamed = ensureDevice(db, { profileId: profile.id, deviceName: "新名", platform: "win32" });
  assert.equal(renamed.id, first.id);
  assert.equal(renamed.deviceName, "新名");
});

test("不同 Profile 拥有各自独立的设备关系", () => {
  const db = freshDb();
  const a = createProfile(db, { name: "A", serverUrl: "http://a.test" });
  const b = createProfile(db, { name: "B", serverUrl: "http://b.test" });
  const da = ensureDevice(db, { profileId: a.id });
  const dbv = ensureDevice(db, { profileId: b.id });
  assert.notEqual(da.id, dbv.id);
});

test("touchDevice 记录最近通信时间，供诊断展示", () => {
  const db = freshDb();
  const { device } = seedProfile(db);
  assert.equal(device.lastSeenAt, null);
  touchDevice(db, device.id);
  const row = db.prepare("SELECT lastSeenAt FROM sync_devices WHERE id = ?")
    .get(device.id) as { lastSeenAt: string | null };
  assert.ok(row.lastSeenAt);
});

// ---------------------------------------------------------------------------
// Profile 与游标
// ---------------------------------------------------------------------------

test("serverUrl 归一化去尾部斜杠，避免同一服务器产生两份 Profile", () => {
  const db = freshDb();
  const profile = createProfile(db, { name: "srv", serverUrl: "http://192.168.1.10:3000/" });
  assert.equal(profile.serverUrl, "http://192.168.1.10:3000");
  assert.equal(findProfileByServer(db, "http://192.168.1.10:3000", null)?.id, profile.id);
});

test("新建 Profile 默认未启用，需显式开启同步", () => {
  const db = freshDb();
  const profile = createProfile(db, { name: "srv", serverUrl: "http://a.test" });
  assert.equal(profile.enabled, 0);
});

test("切换服务器创建独立 Profile，游标互不影响", () => {
  const db = freshDb();
  const a = createProfile(db, { name: "A", serverUrl: "http://a.test" });
  const b = createProfile(db, { name: "B", serverUrl: "http://b.test" });

  advanceSyncState(db, a.id, 500);
  advanceSyncState(db, b.id, 7);

  assert.equal(getSyncState(db, a.id)?.lastSequence, 500);
  assert.equal(getSyncState(db, b.id)?.lastSequence, 7);
});

test("停用 Profile 只停同步，本地 Outbox 与冲突全部保留", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  setProfileEnabled(db, profile.id, true);
  enqueueMutation(db, {
    entityType: "note",
    entityId: "note-keep",
    operation: "upsert",
    deviceId: device.id,
    profileId: profile.id,
  });
  recordConflict(db, {
    profileId: profile.id,
    entityType: "note",
    entityId: "note-keep",
    localPayload: { title: "本机" },
    remotePayload: { title: "服务器" },
  });

  disableProfile(db, profile.id);

  assert.equal(getProfile(db, profile.id)?.enabled, 0);
  assert.equal(countPendingMutations(db), 1, "关闭同步不得删除未同步修改");
  assert.equal(countUnresolvedConflicts(db), 1, "关闭同步不得删除冲突记录");
});

test("游标只前进不后退，迟到的小序号不会导致重复拉取", () => {
  const db = freshDb();
  const profile = createProfile(db, { name: "srv", serverUrl: "http://a.test" });
  advanceSyncState(db, profile.id, 200);
  advanceSyncState(db, profile.id, 50);
  assert.equal(getSyncState(db, profile.id)?.lastSequence, 200);
});

test("resetSyncState 只清游标，不动 Outbox", () => {
  const db = freshDb();
  const { profile, device } = seedProfile(db);
  advanceSyncState(db, profile.id, 300);
  enqueueMutation(db, {
    entityType: "note",
    entityId: "note-r",
    operation: "upsert",
    deviceId: device.id,
    profileId: profile.id,
  });

  resetSyncState(db, profile.id);

  assert.equal(getSyncState(db, profile.id)?.lastSequence, 0);
  assert.equal(countPendingMutations(db), 1);
});

test("同一服务器同一远端账号只允许一份 Profile", () => {
  const db = freshDb();
  const a = createProfile(db, {
    name: "A", serverUrl: "http://a.test", remoteUserId: "u1",
  });
  assert.ok(a.id);
  assert.throws(() => createProfile(db, {
    name: "A2", serverUrl: "http://a.test", remoteUserId: "u1",
  }), /UNIQUE/i);

  // 同服务器不同账号可以并存（家庭共用一台 NAS）。
  assert.doesNotThrow(() => createProfile(db, {
    name: "A3", serverUrl: "http://a.test", remoteUserId: "u2",
  }));
});

// ---------------------------------------------------------------------------
// Conflict：两个版本都能恢复
// ---------------------------------------------------------------------------

test("冲突完整保留三方内容，任意一方都能还原", () => {
  const db = freshDb();
  const { profile } = seedProfile(db);
  const id = recordConflict(db, {
    profileId: profile.id,
    entityType: "note",
    entityId: "note-c",
    localVersion: 5,
    remoteVersion: 6,
    basePayload: { content: "共同祖先" },
    localPayload: { content: "本机修改" },
    remotePayload: { content: "服务器修改" },
  });

  const row = getConflict(db, id);
  assert.ok(row);
  assert.equal(row.status, "unresolved");
  assert.deepEqual(JSON.parse(row.basePayload as string), { content: "共同祖先" });
  assert.deepEqual(JSON.parse(row.localPayload as string), { content: "本机修改" });
  assert.deepEqual(JSON.parse(row.remotePayload as string), { content: "服务器修改" });
});

test("两侧内容都缺失时拒绝记录，否则冲突无法恢复", () => {
  const db = freshDb();
  const { profile } = seedProfile(db);
  assert.throws(() => recordConflict(db, {
    profileId: profile.id,
    entityType: "note",
    entityId: "note-empty",
    basePayload: { content: "只有祖先" },
  }), /localPayload|remotePayload/);
});

test("解决冲突只改状态，历史版本继续保留以便反悔", () => {
  const db = freshDb();
  const { profile } = seedProfile(db);
  const id = recordConflict(db, {
    profileId: profile.id,
    entityType: "note",
    entityId: "note-res",
    localPayload: { content: "本机" },
    remotePayload: { content: "服务器" },
  });

  resolveConflict(db, id);

  const row = getConflict(db, id);
  assert.equal(row?.status, "resolved");
  assert.ok(row?.resolvedAt);
  // 内容仍在，用户选错后还能取回另一版本。
  assert.deepEqual(JSON.parse(row?.localPayload as string), { content: "本机" });
  assert.deepEqual(JSON.parse(row?.remotePayload as string), { content: "服务器" });
  assert.equal(listUnresolvedConflicts(db, profile.id).length, 0);
});

test("同一实体可反复冲突，不会因唯一约束丢失后续冲突", () => {
  const db = freshDb();
  const { profile } = seedProfile(db);
  for (let i = 0; i < 3; i += 1) {
    recordConflict(db, {
      profileId: profile.id,
      entityType: "note",
      entityId: "note-multi",
      localPayload: { round: i },
      remotePayload: { round: i },
    });
  }
  assert.equal(countUnresolvedConflicts(db), 3);
});
