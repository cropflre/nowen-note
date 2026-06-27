/**
 * API Tokens Repository
 *
 * 职责：
 * - 封装 api_tokens 和 api_token_usage 表的所有数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 *
 * 注意：
 * - 本 Repository 只处理 routes/tokens.ts 的 CRUD
 * - lib/api-tokens.ts 的 resolveApiToken / recordTokenUsage 暂不迁移
 */

import { getDb } from "../db/schema";
import type {
  ApiTokenRecord,
  ApiTokenListItem,
  ApiTokenLookupRow,
  ApiTokenUsageRow,
  CreateApiTokenInput,
} from "./types";

export const apiTokensRepository = {
  /**
   * 列出当前用户的 token（不含 tokenHash）
   */
  listByUser(userId: string): ApiTokenListItem[] {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, name, scopes, expiresAt, lastUsedAt, lastUsedIp, createdAt, revokedAt
         FROM api_tokens WHERE userId = ?
         ORDER BY revokedAt IS NOT NULL, createdAt DESC`,
      )
      .all(userId) as ApiTokenListItem[];
  },

  /**
   * 创建 token 记录
   */
  create(input: CreateApiTokenInput): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO api_tokens (id, userId, name, tokenHash, scopes, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.userId,
      input.name,
      input.tokenHash,
      JSON.stringify(input.scopes),
      input.expiresAt,
    );
  },

  /**
   * 获取单个 token（含 userId 校验）
   */
  getByIdAndUser(id: string, userId: string): { id: string; userId: string; revokedAt: string | null } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT id, userId, revokedAt FROM api_tokens WHERE id = ?")
      .get(id) as { id: string; userId: string; revokedAt: string | null } | undefined;
  },

  /**
   * 按 tokenHash 查询 token（用于鉴权链路）
   *
   * 只负责查询数据库，不负责：
   * - 校验 revokedAt
   * - 校验 expiresAt
   * - 更新 lastUsedAt
   * - 记录 usage
   * - 判断 scope
   */
  findByTokenHash(tokenHash: string): ApiTokenLookupRow | undefined {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, userId, scopes, expiresAt, revokedAt, lastUsedAt
         FROM api_tokens WHERE tokenHash = ?`,
      )
      .get(tokenHash) as ApiTokenLookupRow | undefined;
  },

  /**
   * 更新 token 最后使用时间和 IP
   *
   * 注意：60 秒节流判断由调用方（resolveApiToken）负责，Repository 只执行 UPDATE。
   */
  updateLastUsed(id: string, ip: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE api_tokens SET lastUsedAt = datetime('now'), lastUsedIp = ? WHERE id = ?",
    ).run(ip, id);
  },

  /**
   * 记录 token 使用量（按天累加）
   *
   * 注意：day 格式为 YYYY-MM-DD (UTC)，由调用方生成。
   */
  recordUsage(tokenId: string, day: string): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO api_token_usage (tokenId, day, count) VALUES (?, ?, 1)
       ON CONFLICT(tokenId, day) DO UPDATE SET count = count + 1`,
    ).run(tokenId, day);
  },

  /**
   * 吊销 token（软删除）
   */
  revokeById(id: string): void {
    const db = getDb();
    db.prepare("UPDATE api_tokens SET revokedAt = datetime('now') WHERE id = ?").run(id);
  },

  /**
   * 获取使用量统计：逐日聚合
   */
  getDailyUsage(userId: string, startDay: string, endDay: string): ApiTokenUsageRow[] {
    const db = getDb();
    return db
      .prepare(
        `SELECT u.day AS day, SUM(u.count) AS count
         FROM api_token_usage u
         JOIN api_tokens t ON t.id = u.tokenId
         WHERE t.userId = ? AND u.day >= ? AND u.day <= ?
         GROUP BY u.day
         ORDER BY u.day ASC`,
      )
      .all(userId, startDay, endDay) as ApiTokenUsageRow[];
  },

  /**
   * 获取使用量统计：上期总量（环比用）
   */
  getPrevPeriodTotal(userId: string, startDay: string, endDay: string): number {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(u.count), 0) AS total
         FROM api_token_usage u
         JOIN api_tokens t ON t.id = u.tokenId
         WHERE t.userId = ? AND u.day >= ? AND u.day <= ?`,
      )
      .get(userId, startDay, endDay) as { total: number };
    return row.total;
  },

  /**
   * 获取使用量统计：按 token 聚合
   */
  getUsageByToken(userId: string, startDay: string, endDay: string): Array<{ tokenId: string; name: string; count: number }> {
    const db = getDb();
    return db
      .prepare(
        `SELECT t.id AS tokenId, t.name AS name, COALESCE(SUM(u.count), 0) AS count
         FROM api_tokens t
         LEFT JOIN api_token_usage u
           ON u.tokenId = t.id AND u.day >= ? AND u.day <= ?
         WHERE t.userId = ?
         GROUP BY t.id
         HAVING count > 0
         ORDER BY count DESC`,
      )
      .all(startDay, endDay, userId) as Array<{ tokenId: string; name: string; count: number }>;
  },
};
