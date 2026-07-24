/**
 * SQLite Async Adapter
 *
 * 包装 better-sqlite3 同步 API 为 async facade。
 *
 * 设计原则：
 * - better-sqlite3 是同步的，直接包装为 Promise 保持接口统一
 * - 不转换占位符，SQLite 继续使用 ? 占位符
 * - 禁止 db.transaction(async () => {})——会导致事务边界失真
 * - executeStatements 支持 requireChanges 乐观锁原子回滚
 */

import type Database from "better-sqlite3";
import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbRunResult,
  type DbStatement,
} from "./types";

function assertRequiredChanges(statement: DbStatement, changes: number): void {
  if (statement.requireChanges === undefined || changes === statement.requireChanges) return;
  throw new DbStatementChangeError(statement.requireChanges, changes);
}

export class SqliteAdapter implements DatabaseAdapter {
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

  async executeStatements(statements: DbStatement[]): Promise<{ changes: number }> {
    if (statements.length === 0) {
      return { changes: 0 };
    }

    const run = this.db.transaction((items: DbStatement[]) => {
      let changes = 0;
      for (const item of items) {
        const result = this.db.prepare(item.sql).run(...(item.params ?? []));
        assertRequiredChanges(item, result.changes);
        changes += result.changes;
      }
      return changes;
    });

    const changes = run(statements);
    return { changes };
  }
}
