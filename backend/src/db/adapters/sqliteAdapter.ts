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

  async executeBatch(sql: string, paramsList: unknown[][]): Promise<DbRunResult> {
    if (paramsList.length === 0) {
      return { changes: 0 };
    }

    const stmt = this.db.prepare(sql);
    let totalChanges = 0;
    let lastRowid: number | bigint = 0;

    const runBatch = this.db.transaction((items: unknown[][]) => {
      for (const params of items) {
        const result = stmt.run(...params);
        totalChanges += result.changes;
        lastRowid = result.lastInsertRowid;
      }
    });

    runBatch(paramsList);
    return { changes: totalChanges, lastInsertRowid: lastRowid };
  }

  async executeStatements(statements: Array<{ sql: string; params?: unknown[] }>): Promise<{ changes: number }> {
    if (statements.length === 0) {
      return { changes: 0 };
    }

    const run = this.db.transaction((items: Array<{ sql: string; params?: unknown[] }>) => {
      let changes = 0;
      for (const item of items) {
        const result = this.db.prepare(item.sql).run(...(item.params ?? []));
        changes += result.changes;
      }
      return changes;
    });

    const changes = run(statements);
    return { changes };
  }
}
