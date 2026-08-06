/**
 * User Sessions Repository
 *
 * 同步方法保留 SQLite 行为；异步方法通过 Database Runtime Provider
 * 支持 SQLite / PostgreSQL，并保持认证缓存失效语义不变。
 */

import { getDb } from "../db/schema";
import { getDatabaseAdapter } from "../db/runtime";
import { invalidateUserAuthCache } from "../lib/auth-security";

function getAdapter() {
  return getDatabaseAdapter();
}

function timestampString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** user_sessions 记录 */
export interface UserSessionRecord {
  id: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
  ip: string;
  userAgent: string;
  deviceLabel: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

/** 会话列表项（不含敏感信息） */
export interface SessionListItem {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
  ip: string;
  userAgent: string;
  deviceLabel: string | null;
}

function normalizeSessionListItem(row: any): SessionListItem {
  return {
    ...row,
    createdAt: timestampString(row.createdAt) ?? "",
    lastSeenAt: timestampString(row.lastSeenAt) ?? "",
    expiresAt: timestampString(row.expiresAt),
  };
}

export const userSessionsRepository = {
  create(input: {
    id: string;
    userId: string;
    ip: string;
    userAgent: string;
    deviceLabel?: string;
    expiresAt?: string;
  }): string {
    getDb().prepare(
      `INSERT INTO user_sessions (id, "userId", ip, "userAgent", "deviceLabel", "expiresAt")
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.userId,
      input.ip || "",
      input.userAgent || "",
      input.deviceLabel || null,
      input.expiresAt || null,
    );
    invalidateUserAuthCache(input.userId);
    return input.id;
  },

  findByDevice(userId: string, deviceLabel: string): { id: string } | undefined {
    invalidateUserAuthCache(userId);
    return getDb().prepare(
      `SELECT id FROM user_sessions
       WHERE "userId" = ? AND "deviceLabel" = ? AND "revokedAt" IS NULL
         AND ("expiresAt" IS NULL OR datetime("expiresAt") > datetime('now'))
       ORDER BY "lastSeenAt" DESC LIMIT 1`,
    ).get(userId, deviceLabel) as { id: string } | undefined;
  },

  updateLastSeen(sessionId: string, ip?: string, expiresAt?: string): void {
    const db = getDb();
    if (ip !== undefined && expiresAt !== undefined) {
      db.prepare(
        `UPDATE user_sessions
         SET "lastSeenAt" = datetime('now'), ip = ?, "expiresAt" = ?
         WHERE id = ?`,
      ).run(ip || "", expiresAt, sessionId);
    } else {
      db.prepare(`UPDATE user_sessions SET "lastSeenAt" = datetime('now') WHERE id = ?`).run(sessionId);
    }
  },

  getByIdAndUser(sessionId: string, userId: string): { id: string; revokedAt: string | null } | undefined {
    return getDb().prepare(
      `SELECT id, "revokedAt" FROM user_sessions WHERE id = ? AND "userId" = ?`,
    ).get(sessionId, userId) as any;
  },

  getById(sessionId: string): { id: string; userId: string; revokedAt: string | null } | undefined {
    return getDb().prepare(
      `SELECT id, "userId", "revokedAt" FROM user_sessions WHERE id = ?`,
    ).get(sessionId) as any;
  },

  revoke(sessionId: string, reason?: string): void {
    getDb().prepare(
      `UPDATE user_sessions
       SET "revokedAt" = datetime('now'), "revokedReason" = ?
       WHERE id = ? AND "revokedAt" IS NULL`,
    ).run(reason || null, sessionId);
  },

  revokeAllOther(userId: string, currentSessionId: string): number {
    return getDb().prepare(
      `UPDATE user_sessions
       SET "revokedAt" = datetime('now'), "revokedReason" = 'user_bulk_revoked'
       WHERE "userId" = ? AND "revokedAt" IS NULL AND id != ?`,
    ).run(userId, currentSessionId).changes;
  },

  revokeAll(userId: string): number {
    return getDb().prepare(
      `UPDATE user_sessions
       SET "revokedAt" = datetime('now'), "revokedReason" = 'user_bulk_revoked'
       WHERE "userId" = ? AND "revokedAt" IS NULL`,
    ).run(userId).changes;
  },

  cleanupExpired(userId: string): number {
    return getDb().prepare(
      `DELETE FROM user_sessions
       WHERE "userId" = ? AND (
         "revokedAt" IS NOT NULL
         OR ("expiresAt" IS NOT NULL AND datetime("expiresAt") <= datetime('now'))
       )`,
    ).run(userId).changes;
  },

  listActiveByUser(userId: string): SessionListItem[] {
    return getDb().prepare(
      `SELECT id, "createdAt", "lastSeenAt", "expiresAt", ip, "userAgent", "deviceLabel"
       FROM user_sessions
       WHERE "userId" = ? AND "revokedAt" IS NULL
         AND ("expiresAt" IS NULL OR datetime("expiresAt") > datetime('now'))
       ORDER BY "lastSeenAt" DESC`,
    ).all(userId) as SessionListItem[];
  },

  async createAsync(input: {
    id: string;
    userId: string;
    ip: string;
    userAgent: string;
    deviceLabel?: string;
    expiresAt?: string;
  }): Promise<string> {
    await getAdapter().execute(
      `INSERT INTO user_sessions (id, "userId", ip, "userAgent", "deviceLabel", "expiresAt")
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.userId,
        input.ip || "",
        input.userAgent || "",
        input.deviceLabel || null,
        input.expiresAt || null,
      ],
    );
    invalidateUserAuthCache(input.userId);
    return input.id;
  },

  async findByDeviceAsync(userId: string, deviceLabel: string): Promise<{ id: string } | undefined> {
    invalidateUserAuthCache(userId);
    return getAdapter().queryOne<{ id: string }>(
      `SELECT id FROM user_sessions
       WHERE "userId" = ? AND "deviceLabel" = ? AND "revokedAt" IS NULL
         AND ("expiresAt" IS NULL OR datetime("expiresAt") > datetime('now'))
       ORDER BY "lastSeenAt" DESC LIMIT 1`,
      [userId, deviceLabel],
    );
  },

  async updateLastSeenAsync(sessionId: string, ip?: string, expiresAt?: string): Promise<void> {
    if (ip !== undefined && expiresAt !== undefined) {
      await getAdapter().execute(
        `UPDATE user_sessions
         SET "lastSeenAt" = datetime('now'), ip = ?, "expiresAt" = ?
         WHERE id = ?`,
        [ip || "", expiresAt, sessionId],
      );
      return;
    }

    await getAdapter().execute(
      `UPDATE user_sessions SET "lastSeenAt" = datetime('now') WHERE id = ?`,
      [sessionId],
    );
  },

  async getByIdAndUserAsync(
    sessionId: string,
    userId: string,
  ): Promise<{ id: string; revokedAt: string | null } | undefined> {
    const row = await getAdapter().queryOne<{ id: string; revokedAt: unknown }>(
      `SELECT id, "revokedAt" FROM user_sessions WHERE id = ? AND "userId" = ?`,
      [sessionId, userId],
    );
    return row ? { id: row.id, revokedAt: timestampString(row.revokedAt) } : undefined;
  },

  async getByIdAsync(
    sessionId: string,
  ): Promise<{ id: string; userId: string; revokedAt: string | null } | undefined> {
    const row = await getAdapter().queryOne<{ id: string; userId: string; revokedAt: unknown }>(
      `SELECT id, "userId", "revokedAt" FROM user_sessions WHERE id = ?`,
      [sessionId],
    );
    return row ? { id: row.id, userId: row.userId, revokedAt: timestampString(row.revokedAt) } : undefined;
  },

  async revokeAsync(sessionId: string, reason?: string): Promise<void> {
    await getAdapter().execute(
      `UPDATE user_sessions
       SET "revokedAt" = datetime('now'), "revokedReason" = ?
       WHERE id = ? AND "revokedAt" IS NULL`,
      [reason || null, sessionId],
    );
  },

  async listActiveByUserAsync(userId: string): Promise<SessionListItem[]> {
    const rows = await getAdapter().queryMany<any>(
      `SELECT id, "createdAt", "lastSeenAt", "expiresAt", ip, "userAgent", "deviceLabel"
       FROM user_sessions
       WHERE "userId" = ? AND "revokedAt" IS NULL
         AND ("expiresAt" IS NULL OR datetime("expiresAt") > datetime('now'))
       ORDER BY "lastSeenAt" DESC`,
      [userId],
    );
    return rows.map(normalizeSessionListItem);
  },

  async revokeAllOtherAsync(userId: string, currentSessionId: string): Promise<number> {
    const result = await getAdapter().execute(
      `UPDATE user_sessions
       SET "revokedAt" = datetime('now'), "revokedReason" = 'user_bulk_revoked'
       WHERE "userId" = ? AND "revokedAt" IS NULL AND id != ?`,
      [userId, currentSessionId],
    );
    return result.changes;
  },

  async revokeAllAsync(userId: string): Promise<number> {
    const result = await getAdapter().execute(
      `UPDATE user_sessions
       SET "revokedAt" = datetime('now'), "revokedReason" = 'user_bulk_revoked'
       WHERE "userId" = ? AND "revokedAt" IS NULL`,
      [userId],
    );
    return result.changes;
  },

  async cleanupExpiredAsync(userId: string): Promise<number> {
    const result = await getAdapter().execute(
      `DELETE FROM user_sessions
       WHERE "userId" = ? AND (
         "revokedAt" IS NOT NULL
         OR ("expiresAt" IS NOT NULL AND datetime("expiresAt") <= datetime('now'))
       )`,
      [userId],
    );
    return result.changes;
  },
};
