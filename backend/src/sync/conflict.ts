import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { SYNC_PERSONAL_SCOPE_KEY, SYNC_TABLES } from "./constants";
import type {
  SyncConflictRow,
  SyncEntityType,
} from "./types";

/**
 * 冲突台账。
 *
 * 核心原则：宁可留下一条待处理冲突，也不要用 Last Write Wins 覆盖正文。
 * 一旦覆盖，被覆盖那一侧的内容就永久消失了——用户既无法察觉，也无法恢复。
 * 因此这里要求三方内容（base / local / remote）尽量完整落库，
 * 保证任意一方都能被还原。
 */

export interface RecordConflictInput {
  profileId: string;
  scopeKey?: string;
  entityType: SyncEntityType;
  entityId: string;
  localVersion?: number | null;
  remoteVersion?: number | null;
  basePayload?: Record<string, unknown> | null;
  localPayload?: Record<string, unknown> | null;
  remotePayload?: Record<string, unknown> | null;
}

function serialize(value: Record<string, unknown> | null | undefined): string | null {
  return value == null ? null : JSON.stringify(value);
}

/**
 * 记录一次冲突。
 *
 * 必须至少保留 local 与 remote 两侧内容，否则"两个版本都能恢复"无法成立。
 * base 允许缺失（例如本地没有留存共同祖先），此时冲突中心只提供二选一，
 * 不提供三方合并。
 */
export function recordConflict(
  db: Database.Database,
  input: RecordConflictInput,
): string {
  if (input.localPayload == null && input.remotePayload == null) {
    throw new Error(
      "[sync-v2] recordConflict 至少需要 localPayload 或 remotePayload，否则冲突无法恢复",
    );
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO ${SYNC_TABLES.conflicts} (
      id, profileId, scopeKey, entityType, entityId,
      localVersion, remoteVersion,
      basePayload, localPayload, remotePayload,
      status, createdAt, resolvedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', datetime('now'), NULL)
  `).run(
    id,
    input.profileId,
    input.scopeKey ?? SYNC_PERSONAL_SCOPE_KEY,
    input.entityType,
    input.entityId,
    input.localVersion ?? null,
    input.remoteVersion ?? null,
    serialize(input.basePayload),
    serialize(input.localPayload),
    serialize(input.remotePayload),
  );

  return id;
}

/** 冲突中心列表：只列未解决项，按发生时间正序便于逐个处理。 */
export function listUnresolvedConflicts(
  db: Database.Database,
  profileId?: string,
  scopeKey?: string,
): SyncConflictRow[] {
  if (profileId) {
    return db.prepare(`
      SELECT * FROM ${SYNC_TABLES.conflicts}
      WHERE profileId = ? AND status = 'unresolved'
        ${scopeKey ? "AND scopeKey = ?" : ""}
      ORDER BY createdAt ASC
    `).all(...(scopeKey ? [profileId, scopeKey] : [profileId])) as SyncConflictRow[];
  }
  return db.prepare(`
    SELECT * FROM ${SYNC_TABLES.conflicts}
    WHERE status = 'unresolved'
    ORDER BY createdAt ASC
  `).all() as SyncConflictRow[];
}

export function countUnresolvedConflicts(
  db: Database.Database,
  profileId?: string,
  scopeKey?: string,
): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM ${SYNC_TABLES.conflicts} WHERE status = 'unresolved'
      ${profileId ? "AND profileId = ?" : ""}
      ${profileId && scopeKey ? "AND scopeKey = ?" : ""}
  `).get(...(profileId ? (scopeKey ? [profileId,scopeKey] : [profileId]) : [])) as
    | { count: number }
    | undefined;
  return Number(row?.count || 0);
}

export function getConflict(
  db: Database.Database,
  conflictId: string,
  profileId?: string,
): SyncConflictRow | null {
  const row = db.prepare(`SELECT * FROM ${SYNC_TABLES.conflicts} WHERE id = ?
    ${profileId ? "AND profileId = ?" : ""}`)
    .get(...(profileId ? [conflictId,profileId] : [conflictId])) as SyncConflictRow | undefined;
  return row || null;
}

/**
 * 标记冲突已解决。
 *
 * 注意只改状态、不删除记录：三方内容继续保留，
 * 用户事后发现选错了仍可回到冲突详情取回另一版本。
 */
export function resolveConflict(db: Database.Database, conflictId: string): void {
  db.prepare(`
    UPDATE ${SYNC_TABLES.conflicts}
    SET status = 'resolved', resolvedAt = datetime('now')
    WHERE id = ?
  `).run(conflictId);
}
