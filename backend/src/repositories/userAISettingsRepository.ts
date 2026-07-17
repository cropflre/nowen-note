/**
 * 用户 AI 配置 Repository
 *
 * 所有查询都必须携带 userId，确保不同用户的配置互不影响。
 */

import { getDb } from "../db/schema";
import { getDatabaseAdapter } from "../db/runtime";
import type { DatabaseAdapter } from "../db/adapters/types";

export interface UserAISetting {
  userId: string;
  key: string;
  value: string;
  updatedAt: string;
}

export interface UserAISettingEntry {
  key: string;
  value: string;
}

function getAdapter() {
  return getDatabaseAdapter();
}

function requireUserId(userId: string): void {
  if (!userId.trim()) throw new Error("userId is required");
}

export function createUserAISettingsRepository(
  adapter: DatabaseAdapter = getAdapter(),
  nowExpr = "datetime('now')",
) {
  return {
    get(userId: string, key: string): UserAISetting | undefined {
      requireUserId(userId);
      return getDb().prepare(`
        SELECT userId, key, value, updatedAt
        FROM user_ai_settings
        WHERE userId = ? AND key = ?
      `).get(userId, key) as UserAISetting | undefined;
    },

    getMany(userId: string, keys: string[]): UserAISetting[] {
      requireUserId(userId);
      if (keys.length === 0) return [];
      const placeholders = keys.map(() => "?").join(",");
      return getDb().prepare(`
        SELECT userId, key, value, updatedAt
        FROM user_ai_settings
        WHERE userId = ? AND key IN (${placeholders})
        ORDER BY key
      `).all(userId, ...keys) as UserAISetting[];
    },

    getByPrefix(userId: string, prefix: string): UserAISetting[] {
      requireUserId(userId);
      return getDb().prepare(`
        SELECT userId, key, value, updatedAt
        FROM user_ai_settings
        WHERE userId = ? AND key LIKE ?
        ORDER BY key
      `).all(userId, `${prefix}%`) as UserAISetting[];
    },

    set(userId: string, key: string, value: string): void {
      this.setMany(userId, [{ key, value }]);
    },

    setMany(userId: string, entries: UserAISettingEntry[]): void {
      requireUserId(userId);
      if (entries.length === 0) return;
      const db = getDb();
      const upsert = db.prepare(`
        INSERT INTO user_ai_settings (userId, key, value, updatedAt)
        VALUES (?, ?, ?, ${nowExpr})
        ON CONFLICT(userId, key) DO UPDATE SET
          value = excluded.value,
          updatedAt = ${nowExpr}
      `);
      db.transaction(() => {
        for (const entry of entries) upsert.run(userId, entry.key, entry.value);
      })();
    },

    delete(userId: string, key: string): void {
      requireUserId(userId);
      getDb().prepare("DELETE FROM user_ai_settings WHERE userId = ? AND key = ?").run(userId, key);
    },

    deleteMany(userId: string, keys: string[]): void {
      requireUserId(userId);
      if (keys.length === 0) return;
      const placeholders = keys.map(() => "?").join(",");
      getDb().prepare(`
        DELETE FROM user_ai_settings
        WHERE userId = ? AND key IN (${placeholders})
      `).run(userId, ...keys);
    },

    async getAsync(userId: string, key: string): Promise<UserAISetting | undefined> {
      requireUserId(userId);
      return adapter.queryOne<UserAISetting>(`
        SELECT "userId", key, value, "updatedAt"
        FROM user_ai_settings
        WHERE "userId" = ? AND key = ?
      `, [userId, key]);
    },

    async getManyAsync(userId: string, keys: string[]): Promise<UserAISetting[]> {
      requireUserId(userId);
      if (keys.length === 0) return [];
      const placeholders = keys.map(() => "?").join(",");
      return adapter.queryMany<UserAISetting>(`
        SELECT "userId", key, value, "updatedAt"
        FROM user_ai_settings
        WHERE "userId" = ? AND key IN (${placeholders})
        ORDER BY key
      `, [userId, ...keys]);
    },

    async setAsync(userId: string, key: string, value: string): Promise<void> {
      requireUserId(userId);
      await adapter.execute(`
        INSERT INTO user_ai_settings ("userId", key, value, "updatedAt")
        VALUES (?, ?, ?, ${nowExpr})
        ON CONFLICT("userId", key) DO UPDATE SET
          value = excluded.value,
          "updatedAt" = ${nowExpr}
      `, [userId, key, value]);
    },

    async setManyAsync(userId: string, entries: UserAISettingEntry[]): Promise<void> {
      requireUserId(userId);
      if (entries.length === 0) return;
      await adapter.executeBatch(`
        INSERT INTO user_ai_settings ("userId", key, value, "updatedAt")
        VALUES (?, ?, ?, ${nowExpr})
        ON CONFLICT("userId", key) DO UPDATE SET
          value = excluded.value,
          "updatedAt" = ${nowExpr}
      `, entries.map((entry) => [userId, entry.key, entry.value]));
    },

    async deleteManyAsync(userId: string, keys: string[]): Promise<void> {
      requireUserId(userId);
      if (keys.length === 0) return;
      const placeholders = keys.map(() => "?").join(",");
      await adapter.execute(`
        DELETE FROM user_ai_settings
        WHERE "userId" = ? AND key IN (${placeholders})
      `, [userId, ...keys]);
    },
  };
}

export const userAISettingsRepository = createUserAISettingsRepository();
