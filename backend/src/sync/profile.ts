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
