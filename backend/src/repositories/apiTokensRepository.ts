/**
 * API Tokens Repository
 *
 * 同步 API 保留 SQLite 兼容；async API 统一通过 Database Runtime Provider，
 * 并使用 SQLite / PostgreSQL 都支持的聚合与 upsert 语义。
 */

import { getDb } from "../db/schema";
import { getDatabaseAdapter } from "../db/runtime";
import type {
  ApiTokenListItem,
  ApiTokenLookupRow,
  ApiTokenUsageRow,
  CreateApiTokenInput,
} from "./types";

type ApiTokenLookupWithMode = ApiTokenLookupRow & {
  resourceMode?: string;
};

function getAdapter() {
  return getDatabaseAdapter();
}

export const apiTokensRepository = {
  listByUser(userId: string): ApiTokenListItem[] {
    return getDb().prepare(
      `SELECT id, name, scopes, "expiresAt", "lastUsedAt", "lastUsedIp", "createdAt", "revokedAt"
       FROM api_tokens WHERE "userId" = ?
       ORDER BY "revokedAt" IS NOT NULL, "createdAt" DESC`,
    ).all(userId) as ApiTokenListItem[];
  },

  create(input: CreateApiTokenInput): void {
    getDb().prepare(
      `INSERT INTO api_tokens (id, "userId", name, "tokenHash", scopes, "expiresAt")
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

  getByIdAndUser(id: string, userId: string): { id: string; userId: string; revokedAt: string | null } | undefined {
    return getDb().prepare(
      `SELECT id, "userId", "revokedAt" FROM api_tokens WHERE id = ? AND "userId" = ?`,
    ).get(id, userId) as { id: string; userId: string; revokedAt: string | null } | undefined;
  },

  findByTokenHash(tokenHash: string): ApiTokenLookupWithMode | undefined {
    return getDb().prepare(
      `SELECT id, "userId", scopes, "resourceMode", "expiresAt", "revokedAt", "lastUsedAt"
       FROM api_tokens WHERE "tokenHash" = ?`,
    ).get(tokenHash) as ApiTokenLookupWithMode | undefined;
  },

  updateLastUsed(id: string, ip: string): void {
    getDb().prepare(
      `UPDATE api_tokens SET "lastUsedAt" = datetime('now'), "lastUsedIp" = ? WHERE id = ?`,
    ).run(ip, id);
  },

  recordUsage(tokenId: string, day: string): void {
    getDb().prepare(
      `INSERT INTO api_token_usage ("tokenId", day, count) VALUES (?, ?, 1)
       ON CONFLICT("tokenId", day) DO UPDATE SET count = count + 1`,
    ).run(tokenId, day);
  },

  pruneUsageBefore(cutoffDay: string): void {
    getDb().prepare("DELETE FROM api_token_usage WHERE day < ?").run(cutoffDay);
  },

  revokeById(id: string): void {
    getDb().prepare(`UPDATE api_tokens SET "revokedAt" = datetime('now') WHERE id = ?`).run(id);
  },

  getDailyUsage(userId: string, startDay: string, endDay: string): ApiTokenUsageRow[] {
    return getDb().prepare(
      `SELECT u.day AS day, CAST(SUM(u.count) AS INTEGER) AS count
       FROM api_token_usage u
       JOIN api_tokens t ON t.id = u."tokenId"
       WHERE t."userId" = ? AND u.day >= ? AND u.day <= ?
       GROUP BY u.day
       ORDER BY u.day ASC`,
    ).all(userId, startDay, endDay) as ApiTokenUsageRow[];
  },

  getPrevPeriodTotal(userId: string, startDay: string, endDay: string): number {
    const row = getDb().prepare(
      `SELECT CAST(COALESCE(SUM(u.count), 0) AS INTEGER) AS total
       FROM api_token_usage u
       JOIN api_tokens t ON t.id = u."tokenId"
       WHERE t."userId" = ? AND u.day >= ? AND u.day <= ?`,
    ).get(userId, startDay, endDay) as { total: number };
    return row.total;
  },

  getUsageByToken(userId: string, startDay: string, endDay: string): Array<{ tokenId: string; name: string; count: number }> {
    return getDb().prepare(
      `SELECT t.id AS "tokenId", t.name AS name,
              CAST(COALESCE(SUM(u.count), 0) AS INTEGER) AS count
       FROM api_tokens t
       LEFT JOIN api_token_usage u
         ON u."tokenId" = t.id AND u.day >= ? AND u.day <= ?
       WHERE t."userId" = ?
       GROUP BY t.id, t.name
       HAVING COALESCE(SUM(u.count), 0) > 0
       ORDER BY count DESC`,
    ).all(startDay, endDay, userId) as Array<{ tokenId: string; name: string; count: number }>;
  },

  async listByUserAsync(userId: string): Promise<ApiTokenListItem[]> {
    return getAdapter().queryMany<ApiTokenListItem>(
      `SELECT id, name, scopes, "expiresAt", "lastUsedAt", "lastUsedIp", "createdAt", "revokedAt"
       FROM api_tokens WHERE "userId" = ?
       ORDER BY "revokedAt" IS NOT NULL, "createdAt" DESC`,
      [userId],
    );
  },

  async createAsync(input: CreateApiTokenInput): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO api_tokens (id, "userId", name, "tokenHash", scopes, "expiresAt")
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.id, input.userId, input.name, input.tokenHash, JSON.stringify(input.scopes), input.expiresAt],
    );
  },

  async getByIdAndUserAsync(id: string, userId: string): Promise<{ id: string; userId: string; revokedAt: string | null } | undefined> {
    return getAdapter().queryOne<{ id: string; userId: string; revokedAt: string | null }>(
      `SELECT id, "userId", "revokedAt" FROM api_tokens WHERE id = ? AND "userId" = ?`,
      [id, userId],
    );
  },

  async findByTokenHashAsync(tokenHash: string): Promise<ApiTokenLookupWithMode | undefined> {
    return getAdapter().queryOne<ApiTokenLookupWithMode>(
      `SELECT id, "userId", scopes, "resourceMode", "expiresAt", "revokedAt", "lastUsedAt"
       FROM api_tokens WHERE "tokenHash" = ?`,
      [tokenHash],
    );
  },

  async updateLastUsedAsync(id: string, ip: string): Promise<void> {
    await getAdapter().execute(
      `UPDATE api_tokens SET "lastUsedAt" = datetime('now'), "lastUsedIp" = ? WHERE id = ?`,
      [ip, id],
    );
  },

  async recordUsageAsync(tokenId: string, day: string): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO api_token_usage ("tokenId", day, count) VALUES (?, ?, 1)
       ON CONFLICT("tokenId", day) DO UPDATE SET count = api_token_usage.count + 1`,
      [tokenId, day],
    );
  },

  async pruneUsageBeforeAsync(cutoffDay: string): Promise<void> {
    await getAdapter().execute("DELETE FROM api_token_usage WHERE day < ?", [cutoffDay]);
  },

  async revokeByIdAsync(id: string): Promise<void> {
    await getAdapter().execute(
      `UPDATE api_tokens SET "revokedAt" = datetime('now') WHERE id = ?`,
      [id],
    );
  },

  async getDailyUsageAsync(userId: string, startDay: string, endDay: string): Promise<ApiTokenUsageRow[]> {
    return getAdapter().queryMany<ApiTokenUsageRow>(
      `SELECT u.day AS day, CAST(SUM(u.count) AS INTEGER) AS count
       FROM api_token_usage u
       JOIN api_tokens t ON t.id = u."tokenId"
       WHERE t."userId" = ? AND u.day >= ? AND u.day <= ?
       GROUP BY u.day
       ORDER BY u.day ASC`,
      [userId, startDay, endDay],
    );
  },

  async getPrevPeriodTotalAsync(userId: string, startDay: string, endDay: string): Promise<number> {
    const row = await getAdapter().queryOne<{ total: number }>(
      `SELECT CAST(COALESCE(SUM(u.count), 0) AS INTEGER) AS total
       FROM api_token_usage u
       JOIN api_tokens t ON t.id = u."tokenId"
       WHERE t."userId" = ? AND u.day >= ? AND u.day <= ?`,
      [userId, startDay, endDay],
    );
    return Number(row?.total ?? 0);
  },

  async getUsageByTokenAsync(userId: string, startDay: string, endDay: string): Promise<Array<{ tokenId: string; name: string; count: number }>> {
    const rows = await getAdapter().queryMany<{ tokenId: string; name: string; count: number }>(
      `SELECT t.id AS "tokenId", t.name AS name,
              CAST(COALESCE(SUM(u.count), 0) AS INTEGER) AS count
       FROM api_tokens t
       LEFT JOIN api_token_usage u
         ON u."tokenId" = t.id AND u.day >= ? AND u.day <= ?
       WHERE t."userId" = ?
       GROUP BY t.id, t.name
       HAVING COALESCE(SUM(u.count), 0) > 0
       ORDER BY count DESC`,
      [startDay, endDay, userId],
    );
    return rows.map((row) => ({ ...row, count: Number(row.count) }));
  },
};
