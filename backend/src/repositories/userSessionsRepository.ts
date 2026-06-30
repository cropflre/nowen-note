/**
 * User Sessions Repository
 *
 * 职责：
 * - 封装 user_sessions 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 *
 * user_sessions 表结构：
 * - id TEXT PRIMARY KEY
 * - userId TEXT NOT NULL
 * - createdAt TEXT NOT NULL
 * - lastSeenAt TEXT NOT NULL
 * - expiresAt TEXT (nullable)
 * - ip TEXT DEFAULT ''
 * - userAgent TEXT DEFAULT ''
 * - deviceLabel TEXT (nullable)
 * - revokedAt TEXT (nullable)
 * - revokedReason TEXT (nullable)
 */

import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";

function getAdapter() {
  return new SqliteAdapter(getDb());
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

export const userSessionsRepository = {
  /**
   * 创建新会话。
   *
   * @param input 会话数据
   * @returns 创建的会话 ID
   */
  create(input: {
    id: string;
    userId: string;
    ip: string;
    userAgent: string;
    deviceLabel?: string;
    expiresAt?: string;
  }): string {
    const db = getDb();
    db.prepare(
      `INSERT INTO user_sessions (id, userId, ip, userAgent, deviceLabel, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      input.id,
      input.userId,
      input.ip || "",
      input.userAgent || "",
      input.deviceLabel || null,
      input.expiresAt || null
    );
    return input.id;
  },

  /**
   * 查找现有设备会话（用于复用）。
   *
   * @param userId 用户 ID
   * @param deviceLabel 设备标签
   * @returns 现有会话，或 undefined
   */
  findByDevice(userId: string, deviceLabel: string): { id: string } | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT id FROM user_sessions
         WHERE userId = ? AND deviceLabel = ? AND revokedAt IS NULL
           AND (expiresAt IS NULL OR datetime(expiresAt) > datetime('now'))
         ORDER BY lastSeenAt DESC LIMIT 1`
      )
      .get(userId, deviceLabel) as { id: string } | undefined;
  },

  /**
   * 更新会话的最后活跃时间和 IP。
   *
   * @param sessionId 会话 ID
   * @param ip IP 地址
   * @param expiresAt 过期时间（可选）
   */
  updateLastSeen(sessionId: string, ip?: string, expiresAt?: string): void {
    const db = getDb();
    if (ip !== undefined && expiresAt !== undefined) {
      db.prepare(
        `UPDATE user_sessions
         SET lastSeenAt = datetime('now'), ip = ?, expiresAt = ?
         WHERE id = ?`
      ).run(ip || "", expiresAt, sessionId);
    } else {
      db.prepare(
        "UPDATE user_sessions SET lastSeenAt = datetime('now') WHERE id = ?"
      ).run(sessionId);
    }
  },

  /**
   * 获取会话信息（用于 JWT 验证）。
   *
   * @param sessionId 会话 ID
   * @param userId 用户 ID
   * @returns 会话信息，或 undefined
   */
  getByIdAndUser(sessionId: string, userId: string): { id: string; revokedAt: string | null } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT id, revokedAt FROM user_sessions WHERE id = ? AND userId = ?")
      .get(sessionId, userId) as { id: string; revokedAt: string | null } | undefined;
  },

  /**
   * 获取会话详情（用于会话管理）。
   *
   * @param sessionId 会话 ID
   * @returns 会话信息，或 undefined
   */
  getById(sessionId: string): { id: string; userId: string; revokedAt: string | null } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT id, userId, revokedAt FROM user_sessions WHERE id = ?")
      .get(sessionId) as { id: string; userId: string; revokedAt: string | null } | undefined;
  },

  /**
   * 吊销会话。
   *
   * @param sessionId 会话 ID
   * @param reason 吊销原因
   */
  revoke(sessionId: string, reason?: string): void {
    const db = getDb();
    db.prepare(
      `UPDATE user_sessions
       SET revokedAt = datetime('now'), revokedReason = ?
       WHERE id = ? AND revokedAt IS NULL`
    ).run(reason || null, sessionId);
  },

  /**
   * 批量吊销用户的所有其他会话。
   *
   * @param userId 用户 ID
   * @param currentSessionId 当前会话 ID（不吊销）
   * @returns 吊销的行数
   */
  revokeAllOther(userId: string, currentSessionId: string): number {
    const db = getDb();
    const result = db.prepare(
      `UPDATE user_sessions
       SET revokedAt = datetime('now'), revokedReason = 'user_bulk_revoked'
       WHERE userId = ? AND revokedAt IS NULL AND id != ?`
    ).run(userId, currentSessionId);
    return result.changes;
  },

  /**
   * 批量吊销用户的所有会话。
   *
   * @param userId 用户 ID
   * @returns 吊销的行数
   */
  revokeAll(userId: string): number {
    const db = getDb();
    const result = db.prepare(
      `UPDATE user_sessions
       SET revokedAt = datetime('now'), revokedReason = 'user_bulk_revoked'
       WHERE userId = ? AND revokedAt IS NULL`
    ).run(userId);
    return result.changes;
  },

  /**
   * 清理过期和已撤销的会话。
   *
   * @param userId 用户 ID
   * @returns 删除的行数
   */
  cleanupExpired(userId: string): number {
    const db = getDb();
    const result = db.prepare(
      `DELETE FROM user_sessions
       WHERE userId = ? AND (
         revokedAt IS NOT NULL
         OR (expiresAt IS NOT NULL AND datetime(expiresAt) <= datetime('now'))
       )`
    ).run(userId);
    return result.changes;
  },

  /**
   * 列出用户的活跃会话。
   *
   * @param userId 用户 ID
   * @returns 活跃会话列表
   */
  listActiveByUser(userId: string): SessionListItem[] {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, createdAt, lastSeenAt, expiresAt, ip, userAgent, deviceLabel
         FROM user_sessions
         WHERE userId = ? AND revokedAt IS NULL
           AND (expiresAt IS NULL OR datetime(expiresAt) > datetime('now'))
         ORDER BY lastSeenAt DESC`
      )
      .all(userId) as SessionListItem[];
  },

  // ============================================================
  // Async 方法（B3-A：基础 CRUD / 查询类）
  // ============================================================

  async createAsync(input: {
    id: string;
    userId: string;
    ip: string;
    userAgent: string;
    deviceLabel?: string;
    expiresAt?: string;
  }): Promise<string> {
    await getAdapter().execute(
      `INSERT INTO user_sessions (id, userId, ip, userAgent, deviceLabel, expiresAt)
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
    return input.id;
  },

  async findByDeviceAsync(userId: string, deviceLabel: string): Promise<{ id: string } | undefined> {
    return getAdapter().queryOne<{ id: string }>(
      `SELECT id FROM user_sessions
       WHERE userId = ? AND deviceLabel = ? AND revokedAt IS NULL
         AND (expiresAt IS NULL OR datetime(expiresAt) > datetime('now'))
       ORDER BY lastSeenAt DESC LIMIT 1`,
      [userId, deviceLabel],
    );
  },

  async updateLastSeenAsync(sessionId: string, ip?: string, expiresAt?: string): Promise<void> {
    if (ip !== undefined && expiresAt !== undefined) {
      await getAdapter().execute(
        `UPDATE user_sessions
         SET lastSeenAt = datetime('now'), ip = ?, expiresAt = ?
         WHERE id = ?`,
        [ip || "", expiresAt, sessionId],
      );
    } else {
      await getAdapter().execute(
        "UPDATE user_sessions SET lastSeenAt = datetime('now') WHERE id = ?",
        [sessionId],
      );
    }
  },

  async getByIdAndUserAsync(sessionId: string, userId: string): Promise<{ id: string; revokedAt: string | null } | undefined> {
    return getAdapter().queryOne<{ id: string; revokedAt: string | null }>(
      "SELECT id, revokedAt FROM user_sessions WHERE id = ? AND userId = ?",
      [sessionId, userId],
    );
  },

  async getByIdAsync(sessionId: string): Promise<{ id: string; userId: string; revokedAt: string | null } | undefined> {
    return getAdapter().queryOne<{ id: string; userId: string; revokedAt: string | null }>(
      "SELECT id, userId, revokedAt FROM user_sessions WHERE id = ?",
      [sessionId],
    );
  },
};
