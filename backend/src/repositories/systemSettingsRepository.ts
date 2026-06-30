/**
 * System Settings Repository
 *
 * 职责：
 * - 封装 system_settings 表的所有数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";
import type { SystemSetting } from "./types";

/** 创建轻量 adapter 实例（每次调用新建，无全局生命周期） */
function getAdapter() {
  return new SqliteAdapter(getDb());
}

export const systemSettingsRepository = {
  /**
   * 获取单个设置
   */
  get(key: string): SystemSetting | undefined {
    const db = getDb();
    return db
      .prepare("SELECT key, value, updatedAt FROM system_settings WHERE key = ?")
      .get(key) as SystemSetting | undefined;
  },

  /**
   * 获取多个设置
   */
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

  /**
   * 获取所有设置
   */
  getAll(): SystemSetting[] {
    const db = getDb();
    return db
      .prepare("SELECT key, value, updatedAt FROM system_settings")
      .all() as SystemSetting[];
  },

  /**
   * 按前缀获取设置
   */
  getByPrefix(prefix: string): SystemSetting[] {
    const db = getDb();
    return db
      .prepare(
        "SELECT key, value, updatedAt FROM system_settings WHERE key LIKE ?",
      )
      .all(`${prefix}%`) as SystemSetting[];
  },

  /**
   * 按多个前缀获取设置
   */
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

  /**
   * 设置单个值（upsert）
   */
  set(key: string, value: string): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO system_settings (key, value, updatedAt)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')`,
    ).run(key, value);
  },

  /**
   * 设置多个值（批量 upsert，在事务中执行）
   */
  setMany(entries: Array<{ key: string; value: string }>): void {
    if (entries.length === 0) return;
    const db = getDb();
    const upsert = db.prepare(
      `INSERT INTO system_settings (key, value, updatedAt)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')`,
    );
    const tx = db.transaction(() => {
      for (const { key, value } of entries) {
        upsert.run(key, value);
      }
    });
    tx();
  },

  /**
   * 删除单个设置
   */
  delete(key: string): void {
    const db = getDb();
    db.prepare("DELETE FROM system_settings WHERE key = ?").run(key);
  },

  /**
   * 删除多个设置
   */
  deleteMany(keys: string[]): void {
    if (keys.length === 0) return;
    const db = getDb();
    const placeholders = keys.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM system_settings WHERE key IN (${placeholders})`,
    ).run(...keys);
  },

  /**
   * 按前缀删除设置
   */
  deleteByPrefix(prefix: string): void {
    const db = getDb();
    db.prepare("DELETE FROM system_settings WHERE key LIKE ?").run(
      `${prefix}%`,
    );
  },

  // ============================================================
  // Async 方法（Phase 1 试点，使用 SqliteAdapter）
  // ============================================================

  /** 获取单个设置（async） */
  async getAsync(key: string): Promise<SystemSetting | undefined> {
    return getAdapter().queryOne<SystemSetting>(
      "SELECT key, value, updatedAt FROM system_settings WHERE key = ?",
      [key],
    );
  },

  /** 获取多个设置（async） */
  async getManyAsync(keys: string[]): Promise<SystemSetting[]> {
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => "?").join(",");
    return getAdapter().queryMany<SystemSetting>(
      `SELECT key, value, updatedAt FROM system_settings WHERE key IN (${placeholders})`,
      keys,
    );
  },

  /** 获取所有设置（async） */
  async getAllAsync(): Promise<SystemSetting[]> {
    return getAdapter().queryMany<SystemSetting>(
      "SELECT key, value, updatedAt FROM system_settings",
    );
  },

  /** 按前缀获取设置（async） */
  async getByPrefixAsync(prefix: string): Promise<SystemSetting[]> {
    return getAdapter().queryMany<SystemSetting>(
      "SELECT key, value, updatedAt FROM system_settings WHERE key LIKE ?",
      [`${prefix}%`],
    );
  },

  /** 按多个前缀获取设置（async） */
  async getByPrefixesAsync(prefixes: string[]): Promise<SystemSetting[]> {
    if (prefixes.length === 0) return [];
    const conditions = prefixes.map(() => "key LIKE ?").join(" OR ");
    const params = prefixes.map((p) => `${p}%`);
    return getAdapter().queryMany<SystemSetting>(
      `SELECT key, value, updatedAt FROM system_settings WHERE ${conditions}`,
      params,
    );
  },

  /** 设置单个值（async，upsert） */
  async setAsync(key: string, value: string): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO system_settings (key, value, updatedAt)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')`,
      [key, value],
    );
  },

  /** 删除单个设置（async） */
  async deleteAsync(key: string): Promise<void> {
    await getAdapter().execute(
      "DELETE FROM system_settings WHERE key = ?",
      [key],
    );
  },

  /** 删除多个设置（async） */
  async deleteManyAsync(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const placeholders = keys.map(() => "?").join(",");
    await getAdapter().execute(
      `DELETE FROM system_settings WHERE key IN (${placeholders})`,
      keys,
    );
  },

  /** 按前缀删除设置（async） */
  async deleteByPrefixAsync(prefix: string): Promise<void> {
    await getAdapter().execute(
      "DELETE FROM system_settings WHERE key LIKE ?",
      [`${prefix}%`],
    );
  },

  /** 设置多个值（async，批量 upsert，使用 executeBatch 事务） */
  async setManyAsync(entries: Array<{ key: string; value: string }>): Promise<void> {
    if (entries.length === 0) return;
    await getAdapter().executeBatch(
      `INSERT INTO system_settings (key, value, updatedAt)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')`,
      entries.map((e) => [e.key, e.value]),
    );
  },
};
