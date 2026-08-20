import type { Migration } from "./migrations.impl.js";

/**
 * v81: Local-first Sync V2 的本地同步状态表。
 *
 * 为什么必须落库而不是沿用前端 offlineQueue：
 * localStorage 版队列无法与业务写入同一事务提交，一定存在
 * 「笔记已改但 mutation 没入队」的窗口，等价于静默丢失用户修改。
 *
 * 本迁移只建表，不写入任何数据、不改动任何既有表，也不安装触发器。
 * Sync V2 默认关闭（NOWEN_LOCAL_FIRST_SYNC_V2），因此对现有用户完全无感：
 * 升级后这些表存在但恒为空，Offline Sync V1 行为不变。
 *
 * 外键取舍（重要）：
 * - sync_devices / sync_state / sync_outbox / sync_conflicts 对 sync_profiles
 *   建外键，切换服务器时可以整份清理同步关系；
 * - 但 entityId 一律**不**对 notes/notebooks 等业务表建外键。
 *   删除笔记后，"删除"这条 mutation 必须继续存活直到推送成功，
 *   若加外键会被级联清掉，导致删除操作永远不同步到其他设备；
 * - sync_outbox.profileId 允许 NULL：关闭同步期间仍然记录本地变更，
 *   将来开启同步时再绑定 Profile，避免这段时间的修改无法上传。
 */
export const syncV2LocalStateMigration: Migration = {
  version: 81,
  name: "sync-v2-local-state",
  up: (db) => {
    db.exec(`
      -- 一个远端服务器对应一份同步关系。切换服务器必须新建 Profile，
      -- 而不是改写 serverUrl，否则两台服务器会共用同一份游标与设备关系。
      CREATE TABLE IF NOT EXISTS sync_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        serverUrl TEXT NOT NULL,
        remoteUserId TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- 同一服务器 + 同一远端账号只应存在一份 Profile。
      -- remoteUserId 为 NULL（尚未完成首次授权）时不参与唯一性约束。
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_profiles_server_user
        ON sync_profiles(serverUrl, remoteUserId)
        WHERE remoteUserId IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sync_profiles_enabled
        ON sync_profiles(enabled);

      -- deviceId 首次创建后必须长期稳定：它是 Push 幂等与冲突归属的依据，
      -- 每次启动重新生成会让服务端把同一台设备当成无数台新设备。
      CREATE TABLE IF NOT EXISTS sync_devices (
        id TEXT PRIMARY KEY,
        profileId TEXT NOT NULL,
        deviceName TEXT,
        platform TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        lastSeenAt TEXT,
        FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sync_devices_profile
        ON sync_devices(profileId);

      -- 按 (profileId, scopeKey) 记录拉取游标。第一版 scopeKey 恒为 'personal'，
      -- Workspace 作用域在后续 Phase 接入时复用同一张表。
      CREATE TABLE IF NOT EXISTS sync_state (
        profileId TEXT NOT NULL,
        scopeKey TEXT NOT NULL,
        lastSequence INTEGER NOT NULL DEFAULT 0,
        lastSyncAt TEXT,
        lastError TEXT,
        PRIMARY KEY (profileId, scopeKey),
        FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
      );

      -- 业务写入与 Outbox 写入必须在同一事务内提交。
      -- status 只有 pending / inflight / failed，没有 "discarded" 终态：
      -- 无论重试多少次都不允许自动删除用户 mutation。
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id TEXT PRIMARY KEY,
        mutationId TEXT NOT NULL UNIQUE,
        profileId TEXT,
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
        FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE SET NULL
      );

      -- Push 按 createdAt 顺序取待发送条目，保证因果顺序
      -- （先建 notebook 再建其中的 note）。
      CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
        ON sync_outbox(status, createdAt);
      CREATE INDEX IF NOT EXISTS idx_sync_outbox_profile
        ON sync_outbox(profileId, status);
      -- Mutation Coalescing 需要按实体快速定位未发送条目。
      CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity
        ON sync_outbox(entityType, entityId, status);

      -- 幂等台账：客户端请求超时后无法确认服务端是否成功，必须允许重复 Push。
      -- 同一 mutationId 第二次到达时直接返回既有结果，不产生重复数据。
      CREATE TABLE IF NOT EXISTS sync_applied_mutations (
        mutationId TEXT PRIMARY KEY,
        deviceId TEXT NOT NULL,
        appliedAt TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sync_applied_mutations_device
        ON sync_applied_mutations(deviceId, appliedAt);

      -- 冲突必须完整保留三方内容，禁止 Last Write Wins 静默覆盖正文。
      -- 两个版本都要能恢复，否则用户会永久丢失其中一份修改。
      CREATE TABLE IF NOT EXISTS sync_conflicts (
        id TEXT PRIMARY KEY,
        profileId TEXT NOT NULL,
        entityType TEXT NOT NULL CHECK (
          entityType IN ('notebook', 'note', 'tag', 'note_tag', 'favorite', 'attachment')
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

      -- 冲突中心按未解决状态列出；同一实体可能反复冲突，因此不加唯一约束。
      CREATE INDEX IF NOT EXISTS idx_sync_conflicts_unresolved
        ON sync_conflicts(profileId, status, createdAt);
      CREATE INDEX IF NOT EXISTS idx_sync_conflicts_entity
        ON sync_conflicts(entityType, entityId);
    `);
  },
};
