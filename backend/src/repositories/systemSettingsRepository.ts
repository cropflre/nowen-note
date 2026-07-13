import { getDb } from "../db/schema";
import type { DatabaseAdapter } from "../db/adapters/types";
import { nowExpression } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import type { SystemSetting } from "./types";

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function resolveNowExpr(nowExpr?: string): string {
  if (nowExpr) return nowExpr;
  try {
    return nowExpression(getDatabaseDialect());
  } catch {
    return nowExpression("sqlite");
  }
}

/**
 * 创建 systemSettingsRepository 实例。
 *
 * 未显式注入 adapter 时，异步方法从统一数据库运行时获取 Adapter；
 * 同步方法继续仅支持 SQLite，以保持现有调用兼容。
 */
export function createSystemSettingsRepository(
  adapter?: DatabaseAdapter,
  nowExpr?: string,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const getNowExpr = () => resolveNowExpr(nowExpr);

  return {
    // ---- 同步方法（仅 SQLite） ----

    ["get"](key: string): SystemSetting | undefined {
      const db = getDb();
      return db
        .prepare("SELECT key, value, updatedAt FROM system_settings WHERE key = ?")
        .get(key) as SystemSetting | undefined;
    },

    getMany(keys: string[]): SystemSetting[] {
      if (keys.length === 0) return [];
      const db = getDb();
      const placeholders = keys.map(() => "?").join(",");
      return db
        .prepare(
          `SELECT key, value, updatedAt FROM system_settings WHERE key IN (${placeholders})`,
        )
        .all(...keys) as SystemSetting[];
    },

    getAll(): SystemSetting[] {
      const db = getDb();
      return db
        .prepare("SELECT key, value, updatedAt FROM system_settings")
        .all() as SystemSetting[];
    },

    getByPrefix(prefix: string): SystemSetting[] {
      const db = getDb();
      return db
        .prepare(
          "SELECT key, value, updatedAt FROM system_settings WHERE key LIKE ?",
        )
        .all(`${prefix}%`) as SystemSetting[];
    },

    getByPrefixes(prefixes: string[]): SystemSetting[] {
      if (prefixes.length === 0) return [];
      const db = getDb();
      const conditions = prefixes.map(() => "key LIKE ?").join(" OR ");
      const params = prefixes.map((p) => `${p}%`);
      return db
        .prepare(
          `SELECT key, value, updatedAt FROM system_settings WHERE ${conditions}`,
        )
        .all(...params) as SystemSetting[];
    },

    set(key: string, value: string): void {
      const db = getDb();
      const currentNowExpr = getNowExpr();
      db.prepare(
        `INSERT INTO system_settings (key, value, "updatedAt")
         VALUES (?, ?, ${currentNowExpr})
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = ${currentNowExpr}`,
      ).run(key, value);
    },

    setMany(entries: Array<{ key: string; value: string }>): void {
      if (entries.length === 0) return;
      const db = getDb();
      const currentNowExpr = getNowExpr();
      const upsert = db.prepare(
        `INSERT INTO system_settings (key, value, "updatedAt")
         VALUES (?, ?, ${currentNowExpr})
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = ${currentNowExpr}`,
      );
      const tx = db.transaction(() => {
        for (const { key, value } of entries) {
          upsert.run(key, value);
        }
      });
      tx();
    },

    delete(key: string): void {
      const db = getDb();
      db.prepare("DELETE FROM system_settings WHERE key = ?").run(key);
    },

    deleteMany(keys: string[]): void {
      if (keys.length === 0) return;
      const db = getDb();
      const placeholders = keys.map(() => "?").join(",");
      db.prepare(
        `DELETE FROM system_settings WHERE key IN (${placeholders})`,
      ).run(...keys);
    },

    deleteByPrefix(prefix: string): void {
      const db = getDb();
      db.prepare("DELETE FROM system_settings WHERE key LIKE ?").run(
        `${prefix}%`,
      );
    },

    // ---- Async 方法（支持运行时 Adapter / 显式注入） ----

    async getAsync(key: string): Promise<SystemSetting | undefined> {
      return getAdapter().queryOne<SystemSetting>(
        'SELECT key, value, "updatedAt" FROM system_settings WHERE key = ?',
        [key],
      );
    },

    async getManyAsync(keys: string[]): Promise<SystemSetting[]> {
      if (keys.length === 0) return [];
      const placeholders = keys.map(() => "?").join(",");
      return getAdapter().queryMany<SystemSetting>(
        `SELECT key, value, "updatedAt" FROM system_settings WHERE key IN (${placeholders})`,
        keys,
      );
    },

    async getAllAsync(): Promise<SystemSetting[]> {
      return getAdapter().queryMany<SystemSetting>(
        'SELECT key, value, "updatedAt" FROM system_settings',
      );
    },

    async getByPrefixAsync(prefix: string): Promise<SystemSetting[]> {
      return getAdapter().queryMany<SystemSetting>(
        'SELECT key, value, "updatedAt" FROM system_settings WHERE key LIKE ?',
        [`${prefix}%`],
      );
    },

    async getByPrefixesAsync(prefixes: string[]): Promise<SystemSetting[]> {
      if (prefixes.length === 0) return [];
      const conditions = prefixes.map(() => "key LIKE ?").join(" OR ");
      const params = prefixes.map((p) => `${p}%`);
      return getAdapter().queryMany<SystemSetting>(
        `SELECT key, value, "updatedAt" FROM system_settings WHERE ${conditions}`,
        params,
      );
    },

    async setAsync(key: string, value: string): Promise<void> {
      const currentNowExpr = getNowExpr();
      await getAdapter().execute(
        `INSERT INTO system_settings (key, value, "updatedAt")
         VALUES (?, ?, ${currentNowExpr})
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = ${currentNowExpr}`,
        [key, value],
      );
    },

    async deleteAsync(key: string): Promise<void> {
      await getAdapter().execute(
        "DELETE FROM system_settings WHERE key = ?",
        [key],
      );
    },

    async deleteManyAsync(keys: string[]): Promise<void> {
      if (keys.length === 0) return;
      const placeholders = keys.map(() => "?").join(",");
      await getAdapter().execute(
        `DELETE FROM system_settings WHERE key IN (${placeholders})`,
        keys,
      );
    },

    async deleteByPrefixAsync(prefix: string): Promise<void> {
      await getAdapter().execute(
        "DELETE FROM system_settings WHERE key LIKE ?",
        [`${prefix}%`],
      );
    },

    async setManyAsync(entries: Array<{ key: string; value: string }>): Promise<void> {
      if (entries.length === 0) return;
      const currentNowExpr = getNowExpr();
      await getAdapter().executeBatch(
        `INSERT INTO system_settings (key, value, "updatedAt")
         VALUES (?, ?, ${currentNowExpr})
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = ${currentNowExpr}`,
        entries.map((e) => [e.key, e.value]),
      );
    },
  };
}

/** 默认实例：同步方法仍为 SQLite；异步方法使用统一运行时 Adapter。 */
export const systemSettingsRepository = createSystemSettingsRepository();
