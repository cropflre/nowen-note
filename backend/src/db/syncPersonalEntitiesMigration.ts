// backend/src/db/syncPersonalEntitiesMigration.ts
//
// v90: 把 task / task_reminder / diary / mindmap 接入完整同步链路（阶段 J）。
//
// 只加 applier 不加触发器 = 只做了"能应用"，变更根本不会被捕获，
// 表现为这些数据在设备间永远不同步且无任何错误。因此本迁移同时装两组触发器：
//
//   sync_changes_v2  —— 服务端 Change Feed，供其他设备拉取（下行）
//   sync_outbox      —— 本机变更队列，供推送到服务端（上行）
//
// 沿用 v82 / v87 已验证的闸门与抑制机制，不另立一套：
//   Change Feed 闸门：sync_v2_should_log
//   Outbox 闸门：    sync_v2_should_enqueue（含 active profile + bootstrap ready）
//
// v2 已为 tasks / diaries 增加 workspaceId，mindmaps 建表时也带该列；
// task_reminders 没有冗余列，作用域必须从所属 task 推导。

import type { Migration } from "./migrations.impl.js";
import { installSyncChangesV2Triggers } from "./syncChangesV2Migration.js";
import { installSyncOutboxCaptureTriggers } from "./syncOutboxCaptureMigration.js";

/** 需要接入的实体：表名 → 同步实体类型。 */
const ENTITY_TABLES: Array<{
  table: string;
  entityType: string;
  /** direct 读取本行；task 通过 taskId 从 tasks 推导。 */
  scopeSource: "direct" | "task";
}> = [
  { table: "tasks", entityType: "task", scopeSource: "direct" },
  { table: "task_reminders", entityType: "task_reminder", scopeSource: "task" },
  { table: "diaries", entityType: "diary", scopeSource: "direct" },
  { table: "mindmaps", entityType: "mindmap", scopeSource: "direct" },
];

/**
 * 构造 payload 的 JSON 表达式。
 *
 * 每类实体的字段集不同，必须与 apply.ts / applyLocal.ts 的期望严格对应，
 * 否则同步过去的对象会缺字段（表现为"任务标题同步了但截止日期没了"）。
 *
 * 统一带上 baseUpdatedAt：那是冲突检测的依据。
 * 对 UPDATE 用 OLD.updatedAt —— 它正是"本次修改所基于的版本"。
 */
function payloadExpr(entityType: string, alias: string, baseAlias?: string): string {
  const base = baseAlias
    ? `'baseUpdatedAt', ${baseAlias}.updatedAt,`
    : "";

  switch (entityType) {
    case "task":
      return `json_object(
        'id', ${alias}.id,
        'title', ${alias}.title,
        'isCompleted', ${alias}.isCompleted,
        'completedAt', ${alias}.completedAt,
        'priority', ${alias}.priority,
        'dueDate', ${alias}.dueDate,
        'noteId', ${alias}.noteId,
        'parentId', ${alias}.parentId,
        'sortOrder', ${alias}.sortOrder,
        'createdAt', ${alias}.createdAt,
        'updatedAt', ${alias}.updatedAt,
        ${base}
        'userId', ${alias}.userId,
        'workspaceId', ${alias}.workspaceId
      )`;
    case "task_reminder":
      // lastNotifiedAt 刻意不进 payload：本机通知状态不该同步，
      // 否则另一台设备会以为已经提醒过而漏掉。
      return `json_object(
        'id', ${alias}.id,
        'taskId', ${alias}.taskId,
        'offsetMinutes', ${alias}.offsetMinutes,
        'enabled', ${alias}.enabled,
        'createdAt', ${alias}.createdAt,
        'userId', ${alias}.userId,
        'workspaceId', (SELECT workspaceId FROM tasks WHERE id = ${alias}.taskId)
      )`;
    case "diary":
      return `json_object(
        'id', ${alias}.id,
        'contentText', ${alias}.contentText,
        'mood', ${alias}.mood,
        'images', ${alias}.images,
        'media', ${alias}.media,
        'createdAt', ${alias}.createdAt,
        'userId', ${alias}.userId,
        'workspaceId', ${alias}.workspaceId
      )`;
    case "mindmap":
      return `json_object(
        'id', ${alias}.id,
        'title', ${alias}.title,
        'data', ${alias}.data,
        'createdAt', ${alias}.createdAt,
        'updatedAt', ${alias}.updatedAt,
        ${base}
        'userId', ${alias}.userId,
        'workspaceId', ${alias}.workspaceId
      )`;
    default:
      throw new Error(`[migrations] v90 未知实体类型: ${entityType}`);
  }
}

function workspaceExpr(alias: "NEW" | "OLD", scopeSource: "direct" | "task"): string {
  return scopeSource === "direct"
    ? `${alias}.workspaceId`
    : `(SELECT workspaceId FROM tasks WHERE id = ${alias}.taskId)`;
}

/** diary / task_reminder 没有 updatedAt，不能构造 baseUpdatedAt。 */
function hasUpdatedAt(entityType: string): boolean {
  return entityType === "task" || entityType === "mindmap";
}

/**
 * 安装阶段 J 四类实体的 Change Feed / Outbox 触发器。
 *
 * v90 调用时 sync_outbox 尚无 scopeKey，只捕获个人空间；v91 重建后再次调用，
 * 自动切换为工作区感知 SQL。这样历史迁移顺序不需要回写旧版本号。
 */
export function installSyncPersonalEntitiesTriggers(
  db: Parameters<Migration["up"]>[0],
): void {
  const outboxColumns = db.prepare("PRAGMA table_info(sync_outbox)").all() as Array<{ name: string }>;
  const scopeAware = outboxColumns.some((column) => column.name === "scopeKey");
  const scopeColumn = scopeAware ? ", scopeKey" : "";
  const scopeValue = (workspaceId: string) => scopeAware
    ? `, CASE WHEN ${workspaceId} IS NULL THEN 'personal' ELSE 'workspace:' || ${workspaceId} END`
    : "";

  for (const { table, entityType, scopeSource } of ENTITY_TABLES) {
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
    ).get(table);
    if (!exists) continue;

    const newWorkspace = workspaceExpr("NEW", scopeSource);
    const oldWorkspace = workspaceExpr("OLD", scopeSource);
    const newScopeCondition = scopeAware ? "1 = 1" : `${newWorkspace} IS NULL`;
    const oldScopeCondition = scopeAware ? "1 = 1" : `${oldWorkspace} IS NULL`;
    const scopeChanged = scopeSource === "direct"
      ? `OLD.workspaceId IS NOT NEW.workspaceId OR OLD.userId IS NOT NEW.userId`
      : `OLD.taskId IS NOT NEW.taskId OR OLD.userId IS NOT NEW.userId OR ${oldWorkspace} IS NOT ${newWorkspace}`;
    const oldDeleteCondition = scopeAware
      ? scopeChanged
      : `${oldWorkspace} IS NULL AND (${scopeChanged})`;
    const baseArg = hasUpdatedAt(entityType) ? "OLD" : undefined;

    db.exec(`
      DROP TRIGGER IF EXISTS sync_v2_${table}_feed_insert;
      CREATE TRIGGER sync_v2_${table}_feed_insert
      AFTER INSERT ON ${table}
      WHEN ${newScopeCondition}
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (
          entityType, entityId, operation, userId, workspaceId, changedAt
        ) VALUES (
          '${entityType}', NEW.id, 'upsert', NEW.userId, ${newWorkspace}, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_v2_${table}_feed_update;
      CREATE TRIGGER sync_v2_${table}_feed_update
      AFTER UPDATE ON ${table}
      WHEN (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (
          entityType, entityId, operation, userId, workspaceId, changedAt
        )
        SELECT '${entityType}', OLD.id, 'delete', OLD.userId, ${oldWorkspace}, datetime('now')
        WHERE ${oldDeleteCondition};

        INSERT INTO sync_changes_v2 (
          entityType, entityId, operation, userId, workspaceId, changedAt
        )
        SELECT '${entityType}', NEW.id, 'upsert', NEW.userId, ${newWorkspace}, datetime('now')
        WHERE ${newScopeCondition};
      END;

      DROP TRIGGER IF EXISTS sync_v2_${table}_feed_delete;
      CREATE TRIGGER sync_v2_${table}_feed_delete
      AFTER DELETE ON ${table}
      WHEN ${oldScopeCondition}
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO sync_changes_v2 (
          entityType, entityId, operation, userId, workspaceId, changedAt
        ) VALUES (
          '${entityType}', OLD.id, 'delete', OLD.userId, ${oldWorkspace}, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_outbox_${table}_insert;
      CREATE TRIGGER sync_outbox_${table}_insert
      AFTER INSERT ON ${table}
      WHEN ${newScopeCondition}
        AND (SELECT enabled FROM sync_v2_should_enqueue) = 1
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId${scopeColumn}, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          lower(hex(randomblob(16))), lower(hex(randomblob(16))),
          (SELECT profileId FROM sync_v2_outbox_target)${scopeValue(newWorkspace)},
          (SELECT deviceId FROM sync_v2_local_device),
          '${entityType}', NEW.id, 'upsert', NULL,
          ${payloadExpr(entityType, "NEW")},
          'pending', 0, datetime('now')
        );
      END;

      DROP TRIGGER IF EXISTS sync_outbox_${table}_update;
      CREATE TRIGGER sync_outbox_${table}_update
      AFTER UPDATE ON ${table}
      WHEN (SELECT enabled FROM sync_v2_should_enqueue) = 1
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId${scopeColumn}, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        )
        SELECT lower(hex(randomblob(16))), lower(hex(randomblob(16))),
          (SELECT profileId FROM sync_v2_outbox_target)${scopeValue(oldWorkspace)},
          (SELECT deviceId FROM sync_v2_local_device),
          '${entityType}', OLD.id, 'delete', NULL, NULL,
          'pending', 0, datetime('now')
        WHERE ${oldDeleteCondition};

        INSERT INTO sync_outbox (
          id, mutationId, profileId${scopeColumn}, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        )
        SELECT lower(hex(randomblob(16))), lower(hex(randomblob(16))),
          (SELECT profileId FROM sync_v2_outbox_target)${scopeValue(newWorkspace)},
          (SELECT deviceId FROM sync_v2_local_device),
          '${entityType}', NEW.id, 'upsert', NULL,
          ${payloadExpr(entityType, "NEW", baseArg)},
          'pending', 0, datetime('now')
        WHERE ${newScopeCondition};
      END;

      DROP TRIGGER IF EXISTS sync_outbox_${table}_delete;
      CREATE TRIGGER sync_outbox_${table}_delete
      AFTER DELETE ON ${table}
      WHEN ${oldScopeCondition}
        AND (SELECT enabled FROM sync_v2_should_enqueue) = 1
      BEGIN
        INSERT INTO sync_outbox (
          id, mutationId, profileId${scopeColumn}, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount, createdAt
        ) VALUES (
          lower(hex(randomblob(16))), lower(hex(randomblob(16))),
          (SELECT profileId FROM sync_v2_outbox_target)${scopeValue(oldWorkspace)},
          (SELECT deviceId FROM sync_v2_local_device),
          '${entityType}', OLD.id, 'delete', NULL, NULL,
          'pending', 0, datetime('now')
        );
      END;
    `);
  }

  db.exec("DROP TRIGGER IF EXISTS sync_v2_tasks_reminders_scope_move;");
  db.exec("DROP TRIGGER IF EXISTS sync_outbox_tasks_reminders_scope_move;");
  if (!scopeAware) return;

  const hasTasks = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'",
  ).get();
  const hasReminders = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_reminders'",
  ).get();
  if (!hasTasks || !hasReminders) return;

  db.exec(`
    CREATE TRIGGER sync_v2_tasks_reminders_scope_move
    AFTER UPDATE OF userId, workspaceId ON tasks
    WHEN (OLD.workspaceId IS NOT NEW.workspaceId OR OLD.userId IS NOT NEW.userId)
      AND (SELECT enabled FROM sync_v2_should_log) = 1
    BEGIN
      INSERT INTO sync_changes_v2 (entityType, entityId, operation, userId, workspaceId, changedAt)
      SELECT 'task_reminder', r.id, 'delete', r.userId, OLD.workspaceId, datetime('now')
      FROM task_reminders r WHERE r.taskId = OLD.id;
      INSERT INTO sync_changes_v2 (entityType, entityId, operation, userId, workspaceId, changedAt)
      SELECT 'task_reminder', r.id, 'upsert', r.userId, NEW.workspaceId, datetime('now')
      FROM task_reminders r WHERE r.taskId = NEW.id;
    END;

    CREATE TRIGGER sync_outbox_tasks_reminders_scope_move
    AFTER UPDATE OF userId, workspaceId ON tasks
    WHEN (OLD.workspaceId IS NOT NEW.workspaceId OR OLD.userId IS NOT NEW.userId)
      AND (SELECT enabled FROM sync_v2_should_enqueue) = 1
    BEGIN
      INSERT INTO sync_outbox (
        id, mutationId, profileId, scopeKey, deviceId, entityType, entityId,
        operation, baseVersion, payload, status, retryCount, createdAt
      )
      SELECT lower(hex(randomblob(16))), lower(hex(randomblob(16))),
        (SELECT profileId FROM sync_v2_outbox_target),
        CASE WHEN OLD.workspaceId IS NULL THEN 'personal' ELSE 'workspace:' || OLD.workspaceId END,
        (SELECT deviceId FROM sync_v2_local_device),
        'task_reminder', r.id, 'delete', NULL, NULL, 'pending', 0, datetime('now')
      FROM task_reminders r WHERE r.taskId = OLD.id;

      INSERT INTO sync_outbox (
        id, mutationId, profileId, scopeKey, deviceId, entityType, entityId,
        operation, baseVersion, payload, status, retryCount, createdAt
      )
      SELECT lower(hex(randomblob(16))), lower(hex(randomblob(16))),
        (SELECT profileId FROM sync_v2_outbox_target),
        CASE WHEN NEW.workspaceId IS NULL THEN 'personal' ELSE 'workspace:' || NEW.workspaceId END,
        (SELECT deviceId FROM sync_v2_local_device),
        'task_reminder', r.id, 'upsert', NULL,
        json_object(
          'id', r.id, 'taskId', r.taskId, 'offsetMinutes', r.offsetMinutes,
          'enabled', r.enabled, 'createdAt', r.createdAt, 'userId', r.userId,
          'workspaceId', NEW.workspaceId
        ),
        'pending', 0, datetime('now')
      FROM task_reminders r WHERE r.taskId = NEW.id;
    END;
  `);
}

export const syncPersonalEntitiesMigration: Migration = {
  version: 90,
  name: "sync-v2-personal-entities",
  up: (db) => {
    // ---- 第一步：扩展 sync_changes_v2 的 entityType CHECK 约束 ----
    //
    // 原约束只允许 6 类实体，新实体的触发器写入会被数据库直接拒绝，
    // 表现为"保存任务时报错"。SQLite 无法 ALTER CHECK，必须重建表。
    //
    // 重建前先卸掉全部写它的触发器：DROP TABLE 会让它们变成悬空引用，
    // 之后任何笔记写入都会报 no such table（v88 已经踩过这个坑）。
    const changeTriggers = db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND sql LIKE '%sync_changes_v2%'
    `).all() as Array<{ name: string }>;
    for (const { name } of changeTriggers) {
      db.exec(`DROP TRIGGER IF EXISTS ${name};`);
    }

    const fkState = db.pragma("foreign_keys", { simple: true });
    db.pragma("foreign_keys = OFF");
    try {
      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE sync_changes_v2_new (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            entityType TEXT NOT NULL CHECK (
              entityType IN (
                'notebook', 'note', 'tag', 'note_tag', 'favorite', 'attachment',
                'task', 'task_reminder', 'diary', 'mindmap'
              )
            ),
            entityId TEXT NOT NULL,
            noteId TEXT,
            userId TEXT NOT NULL,
            workspaceId TEXT,
            operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
            version INTEGER,
            changedAt TEXT NOT NULL DEFAULT (datetime('now'))
          );

          -- 保留 sequence 原值：客户端游标指向的就是这些序号，
          -- 重新编号会让所有设备的游标失效并触发全量重拉。
          INSERT INTO sync_changes_v2_new (
            sequence, entityType, entityId, noteId, userId,
            workspaceId, operation, version, changedAt
          )
          SELECT sequence, entityType, entityId, noteId, userId,
                 workspaceId, operation, version, changedAt
            FROM sync_changes_v2;

          DROP TABLE sync_changes_v2;
          ALTER TABLE sync_changes_v2_new RENAME TO sync_changes_v2;

          CREATE INDEX IF NOT EXISTS idx_sync_changes_v2_user_sequence
            ON sync_changes_v2(userId, sequence);
          CREATE INDEX IF NOT EXISTS idx_sync_changes_v2_scope_sequence
            ON sync_changes_v2(workspaceId, sequence);
          CREATE INDEX IF NOT EXISTS idx_sync_changes_v2_entity
            ON sync_changes_v2(entityType, entityId, sequence);
          CREATE INDEX IF NOT EXISTS idx_sync_changes_v2_time
            ON sync_changes_v2(changedAt);
        `);
      });
      rebuild();
    } finally {
      db.pragma(`foreign_keys = ${fkState ? "ON" : "OFF"}`);
    }

    // ---- 第一步（续）：sync_outbox 与 sync_conflicts 同样带 entityType CHECK ----
    //
    // 漏掉任何一张都会让新实体在链路的某一环被数据库拒绝：
    //   sync_outbox    被拒 → 本地新增任务时直接报错，用户根本存不了任务；
    //   sync_conflicts 被拒 → 冲突无法落账，等于静默丢掉一方修改（违反 RULE 5）。
    // 卸掉全部写 sync_outbox 的触发器。
    //
    // 必须在重建**之前**：DROP TABLE 会让它们悬空，而且重建过程本身
    // （对业务表的任何写入、甚至 ALTER RENAME）都可能触发它们，
    // 报 "no such table: main.sync_outbox"。
    const outboxTriggers = db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND sql LIKE '%sync_outbox%'
    `).all() as Array<{ name: string }>;
    for (const { name } of outboxTriggers) {
      db.exec(`DROP TRIGGER IF EXISTS ${name};`);
    }

    const rebuildOutbox = db.transaction(() => {
      db.exec(`
        CREATE TABLE sync_outbox_v90 (
          id TEXT PRIMARY KEY,
          mutationId TEXT NOT NULL UNIQUE,
          profileId TEXT NOT NULL,
          deviceId TEXT NOT NULL,
          entityType TEXT NOT NULL CHECK (
            entityType IN (
              'notebook', 'note', 'tag', 'note_tag', 'favorite', 'attachment',
              'task', 'task_reminder', 'diary', 'mindmap'
            )
          ),
          entityId TEXT NOT NULL,
          operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
          baseVersion INTEGER,
          payload TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (
            status IN ('pending', 'inflight', 'failed')
          ),
          retryCount INTEGER NOT NULL DEFAULT 0,
          lastAttemptAt TEXT,
          lastError TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
        );

        INSERT INTO sync_outbox_v90 (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount,
          lastAttemptAt, lastError, createdAt
        )
        SELECT id, mutationId, profileId, deviceId, entityType, entityId,
               operation, baseVersion, payload, status, retryCount,
               lastAttemptAt, lastError, createdAt
          FROM sync_outbox;

        DROP TABLE sync_outbox;
        ALTER TABLE sync_outbox_v90 RENAME TO sync_outbox;

        CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
          ON sync_outbox(status, createdAt);
        CREATE INDEX IF NOT EXISTS idx_sync_outbox_profile
          ON sync_outbox(profileId, status);
        CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity
          ON sync_outbox(entityType, entityId, status);

        CREATE TABLE sync_conflicts_v90 (
          id TEXT PRIMARY KEY,
          profileId TEXT NOT NULL,
          entityType TEXT NOT NULL CHECK (
            entityType IN (
              'notebook', 'note', 'tag', 'note_tag', 'favorite', 'attachment',
              'task', 'task_reminder', 'diary', 'mindmap'
            )
          ),
          entityId TEXT NOT NULL,
          localVersion INTEGER,
          remoteVersion INTEGER,
          basePayload TEXT,
          localPayload TEXT,
          remotePayload TEXT,
          status TEXT NOT NULL DEFAULT 'unresolved' CHECK (
            status IN ('unresolved', 'resolved')
          ),
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          resolvedAt TEXT,
          FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
        );

        INSERT INTO sync_conflicts_v90 (
          id, profileId, entityType, entityId, localVersion, remoteVersion,
          basePayload, localPayload, remotePayload, status, createdAt, resolvedAt
        )
        SELECT id, profileId, entityType, entityId, localVersion, remoteVersion,
               basePayload, localPayload, remotePayload, status, createdAt, resolvedAt
          FROM sync_conflicts;

        DROP TABLE sync_conflicts;
        ALTER TABLE sync_conflicts_v90 RENAME TO sync_conflicts;

        CREATE INDEX IF NOT EXISTS idx_sync_conflicts_unresolved
          ON sync_conflicts(profileId, status, createdAt);
        CREATE INDEX IF NOT EXISTS idx_sync_conflicts_entity
          ON sync_conflicts(entityType, entityId);
      `);
    });

    const fkState2 = db.pragma("foreign_keys", { simple: true });
    db.pragma("foreign_keys = OFF");
    try {
      rebuildOutbox();
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `[migrations] v90 重建同步表后外键校验失败：${violations.length} 处`,
        );
      }
    } finally {
      db.pragma(`foreign_keys = ${fkState2 ? "ON" : "OFF"}`);
    }

    // 装回被卸掉的触发器。
    //
    // 顺序很关键：Outbox 捕获触发器写 sync_outbox，刚才 DROP TABLE 让它们
    // 全部悬空，必须重装（v88 已经踩过一次）。
    installSyncChangesV2Triggers(db);
    installSyncOutboxCaptureTriggers(db);

    // ---- 修复：sync_v2_local_device 视图仍读已废弃的 sync_devices ----
    //
    // v87 建视图时读 sync_devices（当时那是唯一的设备表），v88 引入
    // 安装级身份后设备写入 sync_device_identity，sync_devices 不再被填充。
    // 结果视图返回 NULL → sync_v2_should_enqueue 恒为 0 →
    // **所有实体的上行同步静默失效**：本地改了东西一切正常，
    // 但永远不会推送到任何设备，且没有任何错误提示。
    //
    // 这里以安装级身份为准，并保留 sync_devices 作为过渡兜底
    // （极老的库可能还没跑到 v88 的数据迁移）。
    db.exec(`
      DROP VIEW IF EXISTS sync_v2_local_device;
      CREATE VIEW sync_v2_local_device AS
        SELECT deviceId FROM (
          SELECT deviceId, 0 AS priority, createdAt
            FROM sync_device_identity WHERE singletonKey = 1
          UNION ALL
          SELECT id AS deviceId, 1 AS priority, createdAt
            FROM sync_devices
        )
        ORDER BY priority ASC, createdAt ASC
        LIMIT 1;
    `);

    // installSyncOutboxCaptureTriggers 会重建 sync_v2_should_enqueue，
    // 而它依赖上面这个视图。视图是运行时解析的，因此顺序不影响正确性，
    // 但显式重建一次可确保定义与最新依赖一致。
    db.exec(`
      DROP VIEW IF EXISTS sync_v2_should_enqueue;
      CREATE VIEW sync_v2_should_enqueue AS
        SELECT CASE
          WHEN (SELECT enabled FROM sync_v2_should_log) = 1
            AND (SELECT profileId FROM sync_v2_outbox_target) IS NOT NULL
            AND (SELECT deviceId FROM sync_v2_local_device) IS NOT NULL
          THEN 1 ELSE 0
        END AS enabled;
    `);

    // ---- 第二步：为新实体装触发器 ----
    installSyncPersonalEntitiesTriggers(db);
  },
};
