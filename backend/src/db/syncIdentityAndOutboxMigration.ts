import type { Migration } from "./migrations.impl.js";
import { installSyncOutboxCaptureTriggers } from "./syncOutboxCaptureMigration.js";

/**
 * v88: 同步身份与队列语义收口（阶段 A + B + C）。
 *
 * 三项修复放在同一迁移，因为它们互相耦合、必须原子生效：
 * - C（outbox.profileId NOT NULL）依赖 A（保证 active profile 唯一），
 *   否则"该绑哪个 profile"本身就是歧义的；
 * - C 的表重建要顺带把 deviceId 迁到 B 的安装级身份上，
 *   分两次迁移会出现"中间态里 outbox 的 deviceId 已失效"的窗口。
 *
 * ===========================================================================
 * 阶段 A：Active Profile 唯一性
 * ===========================================================================
 *
 * 问题：`sync-local.ts` 的业务入口会在事务内关掉其他 Profile，但
 * `profile.ts` 的 `setProfileEnabled(id, true)` 是公开的底层旁路，
 * 数据库也没有任何约束。因此仍可能出现两个 enabled=1，
 * 后果是两个引擎把同一批 Outbox 推向不同服务器。
 *
 * 修法：partial unique index。已验证本项目 SQLite 3.49.2 支持
 * `CREATE UNIQUE INDEX … WHERE enabled = 1`，且 enabled=0 可以有多行。
 *
 * 已有脏数据的处理（不猜哪个服务器是用户想要的）：
 * - 恰好一个 enabled → 保留；
 * - 多个 enabled     → **全部置为 disabled**，让用户重新选择同步目标。
 *   随机保留一个的风险是把数据推到错误的服务器上。
 *   本地数据一个字都不删，只是暂停同步。
 *
 * ===========================================================================
 * 阶段 B：Installation-scoped Device ID
 * ===========================================================================
 *
 * 问题：`ensureDevice(profileId)` 按 profileId 查，查不到就 randomUUID()。
 * 于是同一台电脑连 Server A 是 Device A、连 Server B 是 Device B。
 * 这是错误语义 —— 设备是物理安装实例，与连哪个服务器无关。
 *
 * 新模型：
 *   sync_device_identity   本安装实例身份（单例，deviceId 永久稳定）
 *   sync_profile_devices   Profile ↔ Device 的 membership 关系
 *
 * 迁移策略：**优先复用已有 deviceId**，取 sync_devices 中最早创建的一条
 * 作为安装身份。这样：
 * - 服务端已记录的设备关系继续有效，不会凭空多出一台设备；
 * - 与 v87 `sync_v2_local_device` 视图的取值规则完全一致
 *   （同样是 createdAt ASC + rowid ASC），因此本迁移不会改变
 *   触发器写入 outbox 时使用的 deviceId。
 *
 * sync_devices 保留不动：服务端 applied mutation 历史里记录的
 * origin deviceId 不应被重写，旧表留作兼容与诊断。
 *
 * ===========================================================================
 * 阶段 C：Outbox profileId NOT NULL
 * ===========================================================================
 *
 * 问题：`profileId?: string | null` + `listPendingMutations` 里的
 * `OR profileId IS NULL`，意味着"仅此设备"期间产生的历史 mutation
 * 会在开启同步后被全部 replay。这不是正确模型 ——
 * 首次开启同步应该由 Bootstrap/Reconcile 按**当前最终状态**建立基线，
 * 而不是重放一段历史操作流。
 *
 * v87 的触发器已保证新数据必带 profileId（无 active profile 就不写），
 * 这里补上数据库层的强约束。
 *
 * SQLite 无法 `ALTER COLUMN … SET NOT NULL`，因此重建表。
 *
 * 已有 profileId=NULL 的条目：**归档**到 sync_outbox_legacy_unbound。
 * 不发送（无法判断归属，猜错就是把数据推到错误的服务器）、
 * 不静默丢弃（保留可审计的记录）。这些条目只是同步元数据 ——
 * 对应的业务数据完好留在本地表里，后续 Bootstrap 会把它们纳入基线。
 */
export const syncIdentityAndOutboxMigration: Migration = {
  version: 88,
  name: "sync-v2-identity-and-outbox-semantics",
  up: (db) => {
    // -----------------------------------------------------------------------
    // 阶段 A：Active Profile 唯一性
    // -----------------------------------------------------------------------

    const enabledCount = (db.prepare(
      "SELECT COUNT(*) AS c FROM sync_profiles WHERE enabled = 1",
    ).get() as { c: number }).c;

    if (enabledCount > 1) {
      // 多个 active 是错误状态。不猜用户想要哪个服务器，全部停用。
      // 只改同步开关，本地笔记 / 附件 / Outbox / 冲突一个字不动。
      db.prepare(
        "UPDATE sync_profiles SET enabled = 0, updatedAt = datetime('now') WHERE enabled = 1",
      ).run();
      console.warn(
        `[migrations] v88 检测到 ${enabledCount} 个启用的同步配置，已全部停用，` +
        "需用户重新选择同步目标（本地数据未受影响）",
      );
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_profiles_single_active
        ON sync_profiles(enabled)
        WHERE enabled = 1;
    `);

    // -----------------------------------------------------------------------
    // 阶段 B：安装级设备身份
    // -----------------------------------------------------------------------

    db.exec(`
      -- 单例表：singletonKey 恒为 1，用 CHECK 约束从物理上排除第二行。
      -- deviceId 一旦生成就永不改变：重启、切服务器、重新登录、
      -- 关闭再开启同步都不影响它。
      CREATE TABLE IF NOT EXISTS sync_device_identity (
        singletonKey INTEGER PRIMARY KEY CHECK (singletonKey = 1),
        deviceId TEXT NOT NULL UNIQUE,
        deviceName TEXT,
        platform TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Profile ↔ Device 的 membership。
      -- 切换服务器只是增加/切换 membership，不重新生成物理设备身份。
      CREATE TABLE IF NOT EXISTS sync_profile_devices (
        profileId TEXT NOT NULL,
        deviceId TEXT NOT NULL,
        deviceName TEXT,
        platform TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        lastSeenAt TEXT,
        PRIMARY KEY (profileId, deviceId),
        FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sync_profile_devices_device
        ON sync_profile_devices(deviceId);
    `);

    // 复用已有 deviceId 作为安装身份：取最早创建的一条。
    // 规则与 v87 sync_v2_local_device 视图一致，因此触发器取值不变。
    const legacyDevice = db.prepare(`
      SELECT id, deviceName, platform, createdAt FROM sync_devices
      ORDER BY createdAt ASC, rowid ASC
      LIMIT 1
    `).get() as
      | { id: string; deviceName: string | null; platform: string | null; createdAt: string }
      | undefined;

    if (legacyDevice) {
      db.prepare(`
        INSERT OR IGNORE INTO sync_device_identity
          (singletonKey, deviceId, deviceName, platform, createdAt)
        VALUES (1, ?, ?, ?, ?)
      `).run(
        legacyDevice.id,
        legacyDevice.deviceName,
        legacyDevice.platform,
        legacyDevice.createdAt,
      );

      // 把所有既有 Profile 都挂到这个安装身份上。
      // 旧表里每个 Profile 各有一个 deviceId，它们指的其实是同一台机器，
      // 因此 membership 统一收敛到安装身份，同时保留各自的 lastSeenAt。
      db.prepare(`
        INSERT OR IGNORE INTO sync_profile_devices
          (profileId, deviceId, deviceName, platform, createdAt, lastSeenAt)
        SELECT profileId, ?, deviceName, platform, createdAt, lastSeenAt
        FROM sync_devices
      `).run(legacyDevice.id);
    }
    // 没有任何 sync_devices 记录时不在迁移里生成 deviceId：
    // 首次需要时由 ensureInstallationDevice() 创建，避免给
    // 从未开启同步的用户凭空写入身份数据。

    // 注意：sync_v2_local_device 视图在本迁移末尾统一重建 ——
    // 中途的 installSyncOutboxCaptureTriggers() 会把它恢复成 v87 的旧定义，
    // 所以这里先不建，避免被覆盖后产生"以为改了其实没改"的假象。

    // -----------------------------------------------------------------------
    // 阶段 C：Outbox profileId NOT NULL
    // -----------------------------------------------------------------------

    db.exec(`
      -- 归档表：保留错误设计期产生的未绑定 mutation，供审计与排查。
      -- 刻意不加外键：这些条目的 profileId 本就是 NULL。
      CREATE TABLE IF NOT EXISTS sync_outbox_legacy_unbound (
        id TEXT PRIMARY KEY,
        mutationId TEXT NOT NULL,
        deviceId TEXT,
        entityType TEXT NOT NULL,
        entityId TEXT NOT NULL,
        operation TEXT NOT NULL,
        baseVersion INTEGER,
        payload TEXT,
        status TEXT,
        retryCount INTEGER,
        lastAttemptAt TEXT,
        lastError TEXT,
        createdAt TEXT,
        archivedAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const unbound = (db.prepare(
      "SELECT COUNT(*) AS c FROM sync_outbox WHERE profileId IS NULL",
    ).get() as { c: number }).c;

    if (unbound > 0) {
      db.exec(`
        INSERT OR IGNORE INTO sync_outbox_legacy_unbound (
          id, mutationId, deviceId, entityType, entityId, operation,
          baseVersion, payload, status, retryCount, lastAttemptAt,
          lastError, createdAt
        )
        SELECT id, mutationId, deviceId, entityType, entityId, operation,
               baseVersion, payload, status, retryCount, lastAttemptAt,
               lastError, createdAt
        FROM sync_outbox WHERE profileId IS NULL;
      `);
      db.exec("DELETE FROM sync_outbox WHERE profileId IS NULL;");
      console.warn(
        `[migrations] v88 归档了 ${unbound} 条未绑定同步配置的队列元数据；` +
        "对应业务数据完好保留在本地，将由首次同步对账纳入基线",
      );
    }

    // 重建表以施加 NOT NULL。
    // 外键从 ON DELETE SET NULL 改为 CASCADE —— SET NULL 会违反新的
    // NOT NULL 约束，而 Profile 被删时其队列条目本就无处可推。
    // 注意：删除 Profile 是显式的用户动作，且业务数据不在这张表里。
    //
    // 关键顺序问题：v87 的 18 个触发器定义在业务表上但**写入 sync_outbox**。
    // 直接 DROP TABLE sync_outbox 会让它们变成悬空引用，之后任何业务写入
    // 都会报 "no such table: main.sync_outbox"。因此必须：
    //   先卸触发器 → 重建表 → 装回触发器
    const outboxTriggers = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'sync_outbox_%'
    `).all() as Array<{ name: string }>;

    for (const t of outboxTriggers) {
      db.exec(`DROP TRIGGER IF EXISTS ${t.name};`);
    }

    const fkState = db.pragma("foreign_keys", { simple: true });
    db.pragma("foreign_keys = OFF");
    try {
      db.exec(`
        CREATE TABLE sync_outbox_v88 (
          id TEXT PRIMARY KEY,
          mutationId TEXT NOT NULL UNIQUE,
          profileId TEXT NOT NULL,
          deviceId TEXT NOT NULL,
          entityType TEXT NOT NULL CHECK (
            entityType IN ('notebook', 'note', 'tag', 'note_tag', 'favorite', 'attachment')
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

        INSERT INTO sync_outbox_v88 (
          id, mutationId, profileId, deviceId, entityType, entityId,
          operation, baseVersion, payload, status, retryCount,
          lastAttemptAt, lastError, createdAt
        )
        SELECT id, mutationId, profileId, deviceId, entityType, entityId,
               operation, baseVersion, payload, status, retryCount,
               lastAttemptAt, lastError, createdAt
        FROM sync_outbox;

        DROP TABLE sync_outbox;
        ALTER TABLE sync_outbox_v88 RENAME TO sync_outbox;

        CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
          ON sync_outbox(status, createdAt);
        CREATE INDEX IF NOT EXISTS idx_sync_outbox_profile
          ON sync_outbox(profileId, status);
        CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity
          ON sync_outbox(entityType, entityId, status);
      `);

      // 重建表会丢弃指向它的触发器？不会 —— v87 的触发器写入 sync_outbox，
      // 定义在业务表上（notes/notebooks/...），不随本表重建而消失。
      // 但仍需确认外键完整性没被破坏。
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `[migrations] v88 重建 sync_outbox 后外键校验失败：${violations.length} 处`,
        );
      }
    } finally {
      db.pragma(`foreign_keys = ${fkState ? "ON" : "OFF"}`);
    }

    // 装回捕获触发器。必须在表重建之后：否则触发器引用的是已被 DROP 的表。
    // 同时会重建 sync_v2_outbox_target / sync_v2_should_enqueue 视图，
    // 因此下面要再覆盖一次 sync_v2_local_device（B 阶段的新定义）。
    installSyncOutboxCaptureTriggers(db);

    // 重新指向安装身份表：installSyncOutboxCaptureTriggers 会把
    // sync_v2_local_device 恢复成 v87 的旧定义（读 sync_devices），
    // 这里覆盖为读 sync_device_identity，回退到旧表保证过渡期可用。
    db.exec(`
      DROP VIEW IF EXISTS sync_v2_local_device;
      CREATE VIEW sync_v2_local_device AS
        SELECT deviceId FROM sync_device_identity WHERE singletonKey = 1
        UNION ALL
        SELECT id AS deviceId FROM sync_devices
        WHERE NOT EXISTS (SELECT 1 FROM sync_device_identity WHERE singletonKey = 1)
        LIMIT 1;
    `);
  },
};
