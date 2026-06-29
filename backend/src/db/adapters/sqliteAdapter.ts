/**
 * SQLite Async Adapter
 *
 * 包装 better-sqlite3 同步 API 为 async facade。
 * Phase 1 只实现 queryOne / queryMany / execute，不实现 withTransaction。
 *
 * 设计原则：
 * - better-sqlite3 是同步的，直接包装为 Promise 保持接口统一
 * - 不转换占位符，SQLite 继续使用 ? 占位符
 * - 不包含 PostgreSQL 逻辑
 * - 不调用 db.transaction（Phase 2 才实现事务）
 * - 禁止 db.transaction(async () => {})——会导致事务边界失真
 */

import type Database from "better-sqlite3";
import type { DbAdapter, DbRunResult } from "./types";

export class SqliteAdapter implements DbAdapter {
  constructor(private readonly db: Database.Database) {}

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async queryMany<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<DbRunResult> {
    const result = this.db.prepare(sql).run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }
}
