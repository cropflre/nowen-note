import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { SYNC_PERSONAL_SCOPE_KEY, SYNC_TABLES } from "./constants";
import type { SyncProfileRow, SyncStateRow } from "./types";

/**
 * SyncProfile：一份"本机 ↔ 某个远端服务器"的同步关系。
 *
 * 为什么不允许直接改写 serverUrl：
 * Server A 与 Server B 的 sequence 游标、远端用户身份、设备关系、
 * 已应用 mutation 完全无关。直接改地址会让 B 服务器沿用 A 的游标，
 * 导致大量变更被跳过或被误判为已同步。因此切换服务器必须新建 Profile。
 */

export interface CreateProfileInput {
  name: string;
  serverUrl: string;
  remoteUserId?: string | null;
}

function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function createProfile(
  db: Database.Database,
  input: CreateProfileInput,
): SyncProfileRow {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  if (!serverUrl) {
    throw new Error("[sync-v2] createProfile 需要有效的 serverUrl");
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO ${SYNC_TABLES.profiles} (
      id, name, serverUrl, remoteUserId, enabled, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(id, input.name, serverUrl, input.remoteUserId ?? null);

  return getProfile(db, id) as SyncProfileRow;
}

export function getProfile(
  db: Database.Database,
  profileId: string,
): SyncProfileRow | null {
  const row = db.prepare(`SELECT * FROM ${SYNC_TABLES.profiles} WHERE id = ?`)
    .get(profileId) as SyncProfileRow | undefined;
  return row || null;
}

export function listProfiles(db: Database.Database): SyncProfileRow[] {
  return db.prepare(`
    SELECT * FROM ${SYNC_TABLES.profiles} ORDER BY createdAt ASC
  `).all() as SyncProfileRow[];
}

/**
 * 查找同一服务器 + 同一远端账号的既有 Profile。
 *
 * 用户重新填写同一台服务器时应复用原有 Profile 及其游标，
 * 而不是新建一份从零全量拉取。
 */
export function findProfileByServer(
  db: Database.Database,
  serverUrl: string,
  remoteUserId: string | null,
): SyncProfileRow | null {
  const normalized = normalizeServerUrl(serverUrl);
  const row = remoteUserId
    ? db.prepare(`
        SELECT * FROM ${SYNC_TABLES.profiles}
        WHERE serverUrl = ? AND remoteUserId = ?
      `).get(normalized, remoteUserId)
    : db.prepare(`
        SELECT * FROM ${SYNC_TABLES.profiles}
        WHERE serverUrl = ? AND remoteUserId IS NULL
      `).get(normalized);
  return (row as SyncProfileRow | undefined) || null;
}

/**
 * 底层开关，**不保证唯一性**。
 *
 * 生产代码不应直接用它启用 Profile —— 请用 switchActiveProfile()。
 * 单独启用会绕过"最多一个 active"的业务不变量；数据库层的
 * idx_sync_profiles_single_active（v88）会挡住第二个 enabled=1，
 * 表现为 SQLITE_CONSTRAINT_UNIQUE，而不是静默出现两个 active。
 *
 * 保留导出是为了：停用（enabled=false 永远安全）、迁移脚本、测试。
 * @internal
 */
export function setProfileEnabled(
  db: Database.Database,
  profileId: string,
  enabled: boolean,
): void {
  db.prepare(`
    UPDATE ${SYNC_TABLES.profiles}
    SET enabled = ?, updatedAt = datetime('now')
    WHERE id = ?
  `).run(enabled ? 1 : 0, profileId);
}

/**
 * 切换当前唯一的 Active Profile。
 *
 * 这是**生产代码启用 Profile 的唯一入口**。
 *
 * 事务内先全部停用再启用目标，顺序不可颠倒：先启用会让
 * 数据库瞬间存在两个 enabled=1，直接触发 partial unique index 冲突。
 *
 * 事务保证不会出现"停了旧的但没启新的"或"两个同时 active"的中间态；
 * 任何一步失败则整体回滚，同步关系维持原状。
 *
 * 只改同步开关 —— 本地笔记、附件、未推送的 Outbox、冲突记录一个字都不删。
 */
export function switchActiveProfile(
  db: Database.Database,
  profileId: string,
): SyncProfileRow {
  const run = db.transaction(() => {
    const target = getProfile(db, profileId);
    if (!target) {
      throw new Error(`[sync-v2] switchActiveProfile: Profile ${profileId} 不存在`);
    }
    // 含目标自身一并停用：避免"目标已启用"时 UPDATE 无实际变化，
    // 后续启用语句反而与索引冲突。
    db.prepare(`
      UPDATE ${SYNC_TABLES.profiles}
      SET enabled = 0, updatedAt = datetime('now')
      WHERE enabled = 1
    `).run();
    setProfileEnabled(db, profileId, true);
    return getProfile(db, profileId) as SyncProfileRow;
  });
  return run();
}

/**
 * 停用全部 Profile，即回到"仅此设备"。
 *
 * 返回被停用的 Profile ID，供调用方清理对应的远端凭据。
 */
export function disableAllProfiles(db: Database.Database): string[] {
  const run = db.transaction(() => {
    const active = db.prepare(
      `SELECT id FROM ${SYNC_TABLES.profiles} WHERE enabled = 1`,
    ).all() as Array<{ id: string }>;
    db.prepare(`
      UPDATE ${SYNC_TABLES.profiles}
      SET enabled = 0, updatedAt = datetime('now')
      WHERE enabled = 1
    `).run();
    return active.map((r) => r.id);
  });
  return run();
}

/** 当前唯一的 Active Profile；"仅此设备"时为 null。 */
export function getActiveProfile(db: Database.Database): SyncProfileRow | null {
  const row = db.prepare(`
    SELECT * FROM ${SYNC_TABLES.profiles}
    WHERE enabled = 1
    ORDER BY updatedAt DESC
    LIMIT 1
  `).get() as SyncProfileRow | undefined;
  return row || null;
}

/** 首次授权成功后回填远端用户身份。 */
export function setProfileRemoteUser(
  db: Database.Database,
  profileId: string,
  remoteUserId: string,
): void {
  db.prepare(`
    UPDATE ${SYNC_TABLES.profiles}
    SET remoteUserId = ?, updatedAt = datetime('now')
    WHERE id = ?
  `).run(remoteUserId, profileId);
}

/**
 * 停用一个 Profile。
 *
 * 只停止同步关系，本地数据一个字都不删除：
 * 笔记、附件、未同步的 Outbox、冲突记录全部原样保留。
 * 这正是 "关闭同步 / 切换服务器不得删除本地数据" 的落地点。
 */
export function disableProfile(db: Database.Database, profileId: string): void {
  setProfileEnabled(db, profileId, false);
}

// ---------------------------------------------------------------------------
// 同步游标
// ---------------------------------------------------------------------------

export function getSyncState(
  db: Database.Database,
  profileId: string,
  scopeKey: string = SYNC_PERSONAL_SCOPE_KEY,
): SyncStateRow | null {
  const row = db.prepare(`
    SELECT * FROM ${SYNC_TABLES.state}
    WHERE profileId = ? AND scopeKey = ?
  `).get(profileId, scopeKey) as SyncStateRow | undefined;
  return row || null;
}

/**
 * 推进拉取游标。
 *
 * 只允许前进不允许后退：乱序 ACK 或迟到响应若把游标改小，
 * 会导致已应用的变更被重复拉取。真正需要回退时走 resetSyncState。
 */
export function advanceSyncState(
  db: Database.Database,
  profileId: string,
  sequence: number,
  scopeKey: string = SYNC_PERSONAL_SCOPE_KEY,
): void {
  db.prepare(`
    INSERT INTO ${SYNC_TABLES.state} (profileId, scopeKey, lastSequence, lastSyncAt, lastError)
    VALUES (?, ?, ?, datetime('now'), NULL)
    ON CONFLICT(profileId, scopeKey) DO UPDATE SET
      lastSequence = MAX(lastSequence, excluded.lastSequence),
      lastSyncAt = excluded.lastSyncAt,
      lastError = NULL
  `).run(profileId, scopeKey, sequence);
}

export function recordSyncError(
  db: Database.Database,
  profileId: string,
  errorCode: string,
  scopeKey: string = SYNC_PERSONAL_SCOPE_KEY,
): void {
  db.prepare(`
    INSERT INTO ${SYNC_TABLES.state} (profileId, scopeKey, lastSequence, lastSyncAt, lastError)
    VALUES (?, ?, 0, NULL, ?)
    ON CONFLICT(profileId, scopeKey) DO UPDATE SET lastError = excluded.lastError
  `).run(profileId, scopeKey, errorCode);
}

/**
 * 游标复位，用于服务端返回 resetRequired 或恢复备份之后。
 *
 * 只清游标，不动业务数据、不动 Outbox：复位意味着"重新对账"，
 * 而不是"丢弃本地修改"。
 */
export function resetSyncState(
  db: Database.Database,
  profileId: string,
  scopeKey: string = SYNC_PERSONAL_SCOPE_KEY,
): void {
  db.prepare(`
    INSERT INTO ${SYNC_TABLES.state} (profileId, scopeKey, lastSequence, lastSyncAt, lastError)
    VALUES (?, ?, 0, NULL, NULL)
    ON CONFLICT(profileId, scopeKey) DO UPDATE SET
      lastSequence = 0,
      lastSyncAt = NULL,
      lastError = NULL
  `).run(profileId, scopeKey);
}
