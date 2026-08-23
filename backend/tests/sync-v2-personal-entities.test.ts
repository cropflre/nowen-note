import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getDb } from "../src/db/schema";
import { ensureKnowledgeTreeTables } from "../src/db/knowledgeTreeMigration";
import { applyMutation } from "../src/sync/apply";
import { applyRemoteChanges } from "../src/sync/applyLocal";
import { createProfile, switchActiveProfile } from "../src/sync/profile";
import { ensureDevice } from "../src/sync/device";
import { countPendingMutations, listPendingMutations } from "../src/sync/outbox";
import { SyncError } from "../src/sync/errors";
import { SYNC_ENTITY_TYPES } from "../src/sync/types";
import { runChangeFeedSuppressed } from "../src/sync/suppression";
import { runWithOutboxSuppressed } from "../src/sync/context";

/**
 * 阶段 J：task / task_reminder / diary / mindmap 完整 Local-first 链路
 * （migration v90）。
 *
 * 每类实体必须走通七个环节，缺一即"只做了上传"：
 *   Local CRUD → Outbox → Push(Server Apply) → Change Feed
 *   → Pull(Local Apply) → Delete → Conflict
 */

const USER_ID = "personal-sync-user";

function db() {
  return getDb();
}

function resetAll(): void {
  // 顺序很重要：先清业务表（这些 DELETE 本身会触发 feed/outbox 触发器，
  // 把上一个测试的实体记成 delete 变更），再清同步表把这些副作用一并抹掉。
  // 反过来会让每个测试起始就带着上一个测试的残留变更。
  db().exec(`
    DELETE FROM task_reminders;
    DELETE FROM tasks;
    DELETE FROM diaries;
    DELETE FROM mindmaps;
    DELETE FROM notes;
    DELETE FROM notebooks;

    DELETE FROM sync_conflicts;
    DELETE FROM sync_outbox;
    DELETE FROM sync_applied_mutations;
    DELETE FROM sync_changes_v2;
    DELETE FROM sync_state;
    DELETE FROM sync_profile_devices;
    DELETE FROM sync_device_identity;
    DELETE FROM sync_devices;
    DELETE FROM sync_profiles;
  `);
  db().prepare(`
    INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, 'x', datetime('now'), datetime('now'))
  `).run(USER_ID, USER_ID);
}

/** 建立"已开启同步且基线就绪"状态，触发器才会写 Outbox。 */
function enableSync(): { profileId: string; deviceId: string } {
  const d = db();
  const profile = createProfile(d, { name: "srv", serverUrl: "http://p.test" });
  switchActiveProfile(d, profile.id);
  d.prepare(`
    UPDATE sync_profiles
       SET bootstrapStatus = 'ready', bootstrapReadyAt = datetime('now')
     WHERE id = ?
  `).run(profile.id);
  const device = ensureDevice(d, { profileId: profile.id, platform: "win32" });
  return { profileId: profile.id, deviceId: device.id };
}

function createTask(title = "写周报"): string {
  const id = randomUUID();
  db().prepare(`
    INSERT INTO tasks (id, userId, title, priority, createdAt, updatedAt)
    VALUES (?, ?, ?, 2, datetime('now'), datetime('now'))
  `).run(id, USER_ID, title);
  return id;
}

function createMindmap(title = "架构图"): string {
  const id = randomUUID();
  db().prepare(`
    INSERT INTO mindmaps (id, userId, title, data, createdAt, updatedAt)
    VALUES (?, ?, ?, '{"root":1}', datetime('now'), datetime('now'))
  `).run(id, USER_ID, title);
  return id;
}

function outboxFor(entityType: string): Array<{ entityId: string; operation: string; payload: string | null }> {
  return db().prepare(`
    SELECT entityId, operation, payload FROM sync_outbox
     WHERE entityType = ? ORDER BY createdAt ASC, rowid ASC
  `).all(entityType) as Array<{ entityId: string; operation: string; payload: string | null }>;
}

function feedFor(entityType: string): Array<{ entityId: string; operation: string }> {
  return db().prepare(`
    SELECT entityId, operation FROM sync_changes_v2
     WHERE entityType = ? ORDER BY sequence ASC
  `).all(entityType) as Array<{ entityId: string; operation: string }>;
}

// ===========================================================================
// 契约：实体类型已扩展
// ===========================================================================

test("四类个人实体已纳入同步实体范围", () => {
  for (const t of ["task", "task_reminder", "diary", "mindmap"]) {
    assert.ok(
      (SYNC_ENTITY_TYPES as readonly string[]).includes(t),
      `${t} 未纳入 SYNC_ENTITY_TYPES`,
    );
  }
});

test("首次同步可写入已删除根容器下的笔记和子目录", () => {
  resetAll();
  const d = db();
  // 复现运行期首次访问知识树：历史 base helper 会重建触发器，最终必须仍由
  // scope-aware 版本接管，不能覆盖 v85/v92 的修复。
  ensureKnowledgeTreeTables(d);
  const rootId = "__nowen_root_documents__:personal:remote-user";
  d.prepare(`
    INSERT INTO notebooks (id, userId, name, isDeleted, deletedAt, createdAt, updatedAt)
    VALUES (?, ?, '__NOWEN_ROOT_DOCUMENTS__', 1, datetime('now'), datetime('now'), datetime('now'))
  `).run(rootId, USER_ID);

  const noteId = randomUUID();
  const childId = randomUUID();
  assert.doesNotThrow(() => applyRemoteChanges(d, [
    {
      entityType: "note",
      entityId: noteId,
      operation: "upsert",
      payload: { notebookId: rootId, title: "远端根文档", content: "{}" },
    },
    {
      entityType: "notebook",
      entityId: childId,
      operation: "upsert",
      payload: { parentId: rootId, name: "远端回收站目录", isDeleted: true },
    },
  ], { userId: USER_ID }));

  const note = d.prepare("SELECT notebookId FROM notes WHERE id = ?").get(noteId) as { notebookId: string };
  const child = d.prepare("SELECT parentId FROM notebooks WHERE id = ?").get(childId) as { parentId: string };
  assert.equal(note.notebookId, rootId, "业务表仍保留根文档容器关系");
  assert.equal(child.parentId, rootId, "业务表仍保留已删除父子关系");

  const projected = d.prepare(`
    SELECT resourceType, parentId FROM knowledge_tree_nodes
    WHERE resourceId IN (?, ?) ORDER BY resourceType
  `).all(childId, noteId) as Array<{ resourceType: string; parentId: string | null }>;
  assert.deepEqual(projected, [
    { resourceType: "note", parentId: null },
    { resourceType: "notebook", parentId: null },
  ]);
});

// ===========================================================================
// task：Local CRUD → Outbox → Change Feed → Push → Pull → Delete → Conflict
// ===========================================================================

test("task 本地新增同时进入 Outbox 与 Change Feed", () => {
  resetAll();
  enableSync();
  const id = createTask("买牛奶");

  const out = outboxFor("task");
  assert.equal(out.length, 1, "本地新增必须进 Outbox（上行）");
  assert.equal(out[0].entityId, id);
  assert.equal(out[0].operation, "upsert");

  const feed = feedFor("task");
  assert.equal(feed.length, 1, "本地新增必须进 Change Feed（供其他设备下行）");
  assert.equal(feed[0].entityId, id);
});

test("task payload 完整携带业务字段，不丢截止日期与优先级", () => {
  resetAll();
  enableSync();
  const id = createTask("交报告");
  db().prepare(`
    UPDATE tasks SET dueDate = '2026-09-01', priority = 1, sortOrder = 7
     WHERE id = ?
  `).run(id);

  const out = outboxFor("task");
  const last = JSON.parse(out[out.length - 1].payload as string);
  assert.equal(last.dueDate, "2026-09-01");
  assert.equal(last.priority, 1);
  assert.equal(last.sortOrder, 7);
  // baseUpdatedAt 必须存在：它是冲突检测的唯一依据
  assert.ok(last.baseUpdatedAt, "UPDATE 必须携带 baseUpdatedAt");
});

test("task 删除进入 Outbox，删除操作能同步到其他设备", () => {
  resetAll();
  enableSync();
  const id = createTask("临时任务");
  db().prepare("DELETE FROM tasks WHERE id = ?").run(id);

  const deletes = outboxFor("task").filter((r) => r.operation === "delete");
  assert.equal(deletes.length, 1, "删除必须进 Outbox，否则其他设备上永远删不掉");
  assert.equal(deletes[0].entityId, id);
});

test("task 服务端 apply 支持 upsert 与 delete", () => {
  resetAll();
  const id = randomUUID();
  applyMutation(db(), {
    mutationId: randomUUID(),
    entityType: "task",
    entityId: id,
    operation: "upsert",
    userId: USER_ID,
    deviceId: "dev-1",
    payload: { title: "远端任务", priority: 3, dueDate: "2026-10-01" },
  });
  const row = db().prepare("SELECT title, priority, dueDate FROM tasks WHERE id = ?")
    .get(id) as { title: string; priority: number; dueDate: string };
  assert.equal(row.title, "远端任务");
  assert.equal(row.priority, 3);
  assert.equal(row.dueDate, "2026-10-01");

  applyMutation(db(), {
    mutationId: randomUUID(),
    entityType: "task",
    entityId: id,
    operation: "delete",
    userId: USER_ID,
    deviceId: "dev-1",
  });
  assert.equal(db().prepare("SELECT 1 FROM tasks WHERE id = ?").get(id), undefined);
});

test("task 服务端在 baseUpdatedAt 不匹配时判冲突，绝不静默覆盖", () => {
  resetAll();
  const id = createTask("被两端同时改的任务");

  assert.throws(
    () => applyMutation(db(), {
      mutationId: randomUUID(),
      entityType: "task",
      entityId: id,
      operation: "upsert",
      userId: USER_ID,
      // 谎报一个过期的 base
      payload: { title: "客户端版本", baseUpdatedAt: "1970-01-01 00:00:00" },
    }),
    (err: unknown) => err instanceof SyncError && err.code === "VERSION_CONFLICT",
  );
  // 服务端内容必须保持原样
  const row = db().prepare("SELECT title FROM tasks WHERE id = ?").get(id) as { title: string };
  assert.equal(row.title, "被两端同时改的任务");
});

test("task 本地 apply（下行）保留远端 updatedAt 供下次冲突判定", () => {
  resetAll();
  const id = randomUUID();
  runWithOutboxSuppressed(() => {
    runChangeFeedSuppressed(db(), () => {
      applyRemoteChanges(db(), [{
        entityType: "task",
        entityId: id,
        operation: "upsert",
        payload: { title: "他机任务", updatedAt: "2026-08-01 10:00:00", priority: 1 },
      }], { userId: USER_ID });
    });
  });
  const row = db().prepare("SELECT title, updatedAt FROM tasks WHERE id = ?")
    .get(id) as { title: string; updatedAt: string };
  assert.equal(row.title, "他机任务");
  // 改写成 now() 会让下次 Push 的 base 与服务端不符，误判冲突
  assert.equal(row.updatedAt, "2026-08-01 10:00:00");
});

test("task 下行时孤儿引用置空而非拒绝写入", () => {
  resetAll();
  const id = randomUUID();
  runWithOutboxSuppressed(() => {
    runChangeFeedSuppressed(db(), () => {
      applyRemoteChanges(db(), [{
        entityType: "task",
        entityId: id,
        operation: "upsert",
        // 指向本地不存在的笔记与父任务
        payload: { title: "带孤儿引用", noteId: randomUUID(), parentId: randomUUID() },
      }], { userId: USER_ID });
    });
  });
  const row = db().prepare("SELECT noteId, parentId FROM tasks WHERE id = ?")
    .get(id) as { noteId: string | null; parentId: string | null };
  assert.equal(row.noteId, null, "孤儿引用必须置空，否则外键会让整条任务同步不下来");
  assert.equal(row.parentId, null);
});

// ===========================================================================
// task_reminder
// ===========================================================================

test("task_reminder 双向同步且不携带 lastNotifiedAt", () => {
  resetAll();
  enableSync();
  const taskId = createTask("带提醒的任务");
  const reminderId = randomUUID();
  db().prepare(`
    INSERT INTO task_reminders (id, taskId, userId, offsetMinutes, enabled, lastNotifiedAt, createdAt)
    VALUES (?, ?, ?, 15, 1, '2026-08-01 09:00:00', datetime('now'))
  `).run(reminderId, taskId, USER_ID);

  const out = outboxFor("task_reminder");
  assert.equal(out.length, 1);
  const payload = JSON.parse(out[0].payload as string);
  assert.equal(payload.offsetMinutes, 15);
  assert.equal(payload.taskId, taskId);
  // 本机通知状态不该同步，否则另一台设备会以为已提醒过而漏掉
  assert.equal("lastNotifiedAt" in payload, false, "lastNotifiedAt 不得同步");
});

test("task_reminder 缺少所属任务时报缺依赖，供客户端稍后重试", () => {
  resetAll();
  assert.throws(
    () => applyMutation(db(), {
      mutationId: randomUUID(),
      entityType: "task_reminder",
      entityId: randomUUID(),
      operation: "upsert",
      userId: USER_ID,
      payload: { taskId: randomUUID(), offsetMinutes: 10 },
    }),
    (err: unknown) => err instanceof SyncError && err.code === "MISSING_DEPENDENCY",
  );
});

test("task_reminder 下行时任务未到达则跳过，下轮 Pull 会补上", () => {
  resetAll();
  const id = randomUUID();
  // 不抛错：Change Feed 幂等，下一轮任务已存在时会重新带上这条提醒
  assert.doesNotThrow(() => {
    runWithOutboxSuppressed(() => {
      runChangeFeedSuppressed(db(), () => {
        applyRemoteChanges(db(), [{
          entityType: "task_reminder",
          entityId: id,
          operation: "upsert",
          payload: { taskId: randomUUID(), offsetMinutes: 5 },
        }], { userId: USER_ID });
      });
    });
  });
  assert.equal(db().prepare("SELECT 1 FROM task_reminders WHERE id = ?").get(id), undefined);
});

// ===========================================================================
// diary
// ===========================================================================

test("diary 双向同步且 images/media 保持合法 JSON", () => {
  resetAll();
  enableSync();
  const id = randomUUID();
  db().prepare(`
    INSERT INTO diaries (id, userId, contentText, mood, images, media, createdAt)
    VALUES (?, ?, '今天很好', 'happy', '["a","b"]', '[{"id":"a","type":"image"}]', datetime('now'))
  `).run(id, USER_ID);

  const out = outboxFor("diary");
  assert.equal(out.length, 1);
  const payload = JSON.parse(out[0].payload as string);
  assert.equal(payload.contentText, "今天很好");
  assert.deepEqual(JSON.parse(payload.images), ["a", "b"]);
});

test("diary 收到损坏的 JSON 时退化为空数组，不让前端解析崩溃", () => {
  resetAll();
  const id = randomUUID();
  applyMutation(db(), {
    mutationId: randomUUID(),
    entityType: "diary",
    entityId: id,
    operation: "upsert",
    userId: USER_ID,
    deviceId: "dev-1",
    payload: { contentText: "x", images: "这不是JSON", media: "{也不是数组}" },
  });
  const row = db().prepare("SELECT images, media FROM diaries WHERE id = ?")
    .get(id) as { images: string; media: string };
  assert.deepEqual(JSON.parse(row.images), []);
  assert.deepEqual(JSON.parse(row.media), []);
});

test("diary 同 ID 幂等 upsert，不产生冲突", () => {
  resetAll();
  const id = randomUUID();
  const apply = (text: string) => applyMutation(db(), {
    mutationId: randomUUID(),
    entityType: "diary",
    entityId: id,
    operation: "upsert",
    userId: USER_ID,
    deviceId: "dev-1",
    payload: { contentText: text },
  });
  apply("第一版");
  // 追加型记录不做版本冲突：同 ID 就是同一条
  assert.doesNotThrow(() => apply("第二版"));
  const row = db().prepare("SELECT contentText FROM diaries WHERE id = ?")
    .get(id) as { contentText: string };
  assert.equal(row.contentText, "第二版");
});

// ===========================================================================
// mindmap
// ===========================================================================

test("mindmap 双向同步且携带完整 data", () => {
  resetAll();
  enableSync();
  const id = createMindmap("产品规划");

  const out = outboxFor("mindmap");
  assert.equal(out.length, 1);
  const payload = JSON.parse(out[0].payload as string);
  assert.equal(payload.title, "产品规划");
  assert.equal(payload.data, '{"root":1}');
});

test("mindmap 缺少 baseUpdatedAt 也判冲突，绝不盲目覆盖整份导图", () => {
  resetAll();
  const id = createMindmap("重要导图");

  assert.throws(
    () => applyMutation(db(), {
      mutationId: randomUUID(),
      entityType: "mindmap",
      entityId: id,
      operation: "upsert",
      userId: USER_ID,
      // 不带 base：客户端不知道自己在覆盖什么
      payload: { title: "覆盖版", data: "{}" },
    }),
    (err: unknown) => err instanceof SyncError && err.code === "VERSION_CONFLICT",
  );
  const row = db().prepare("SELECT data FROM mindmaps WHERE id = ?").get(id) as { data: string };
  assert.equal(row.data, '{"root":1}', "整份导图不得被覆盖");
});

test("mindmap base 匹配时正常写入", () => {
  resetAll();
  const id = createMindmap("可更新导图");
  const current = db().prepare("SELECT updatedAt FROM mindmaps WHERE id = ?")
    .get(id) as { updatedAt: string };

  applyMutation(db(), {
    mutationId: randomUUID(),
    entityType: "mindmap",
    entityId: id,
    operation: "upsert",
    userId: USER_ID,
    deviceId: "dev-1",
    payload: { title: "新标题", data: '{"root":2}', baseUpdatedAt: current.updatedAt },
  });
  const row = db().prepare("SELECT title, data FROM mindmaps WHERE id = ?")
    .get(id) as { title: string; data: string };
  assert.equal(row.title, "新标题");
  assert.equal(row.data, '{"root":2}');
});

test("mindmap 工作区导图进入独立 workspace Scope", () => {
  resetAll();
  enableSync();
  const id = randomUUID();
  db().prepare(`
    INSERT INTO mindmaps (id, userId, workspaceId, title, data, createdAt, updatedAt)
    VALUES (?, ?, 'ws-1', '团队导图', '{}', datetime('now'), datetime('now'))
  `).run(id, USER_ID);

  const outbox = db().prepare(`
    SELECT scopeKey FROM sync_outbox WHERE entityType = 'mindmap' AND entityId = ?
  `).all(id) as Array<{ scopeKey: string }>;
  const feed = db().prepare(`
    SELECT workspaceId FROM sync_changes_v2 WHERE entityType = 'mindmap' AND entityId = ?
  `).all(id) as Array<{ workspaceId: string | null }>;
  assert.deepEqual(outbox, [{ scopeKey: "workspace:ws-1" }]);
  assert.deepEqual(feed, [{ workspaceId: "ws-1" }]);
});

// ===========================================================================
// 通用约束
// ===========================================================================

test("仅此设备（无 active profile）时四类实体都不产生 Outbox", () => {
  resetAll();
  // 刻意不调用 enableSync()
  createTask("本机任务");
  createMindmap("本机导图");
  db().prepare(`
    INSERT INTO diaries (id, userId, contentText, createdAt)
    VALUES (?, ?, '本机日记', datetime('now'))
  `).run(randomUUID(), USER_ID);

  assert.equal(countPendingMutations(db()), 0, "仅此设备不得产生任何上行 mutation");
});

test("Pull 应用远端变更不回流 Outbox，避免同步死循环", () => {
  resetAll();
  const { profileId } = enableSync();
  const before = countPendingMutations(db());

  runWithOutboxSuppressed(() => {
    runChangeFeedSuppressed(db(), () => {
      applyRemoteChanges(db(), [
        { entityType: "task", entityId: randomUUID(), operation: "upsert", payload: { title: "远端任务" } },
        { entityType: "mindmap", entityId: randomUUID(), operation: "upsert", payload: { title: "远端导图", data: "{}" } },
        { entityType: "diary", entityId: randomUUID(), operation: "upsert", payload: { contentText: "远端日记" } },
      ], { userId: USER_ID });
    });
  });

  assert.equal(
    countPendingMutations(db()),
    before,
    "远端变更回流 Outbox 会形成 Pull→Apply→Push 无限循环",
  );
  assert.equal(listPendingMutations(db(), 50, profileId).length, before);
});

test("Change Feed 的 sequence 单调递增，保证游标可靠", () => {
  resetAll();
  enableSync();
  createTask("t1");
  createTask("t2");
  createMindmap("m1");

  const rows = db().prepare(`
    SELECT sequence FROM sync_changes_v2 ORDER BY sequence ASC
  `).all() as Array<{ sequence: number }>;
  assert.ok(rows.length >= 3);
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i].sequence > rows[i - 1].sequence, "sequence 必须严格递增");
  }
});
