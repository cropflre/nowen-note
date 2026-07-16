/**
 * PostgreSQL Async Adapter
 *
 * 实现 DatabaseAdapter 接口，用于 PostgreSQL 数据库。
 * Repository 可以继续使用统一的 SQLite 风格参数占位符与项目约定 SQL，
 * Adapter 会在送入 node-postgres 前完成保守的方言规范化。
 */

import type { Pool } from "pg";
import type { DatabaseAdapter, DbRunResult } from "./adapters/types";
import { convertSql } from "./dialect";

export class PostgresAdapter implements DatabaseAdapter {
  constructor(private readonly pool: Pool) {}

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const pgSql = convertSql(sql, "postgres");
    const result = await this.pool.query(pgSql, params);
    return (result.rows[0] as T) ?? undefined;
  }

  async queryMany<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const pgSql = convertSql(sql, "postgres");
    const result = await this.pool.query(pgSql, params);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<DbRunResult> {
    const pgSql = convertSql(sql, "postgres");
    const result = await this.pool.query(pgSql, params);
    return {
      changes: result.rowCount ?? 0,
    };
  }

  async executeBatch(sql: string, paramsList: unknown[][]): Promise<DbRunResult> {
    if (paramsList.length === 0) {
      return { changes: 0 };
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let totalChanges = 0;
      const pgSql = convertSql(sql, "postgres");

      for (const params of paramsList) {
        const result = await client.query(pgSql, params);
        totalChanges += result.rowCount ?? 0;
      }

      await client.query("COMMIT");
      return { changes: totalChanges };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async executeStatements(statements: Array<{ sql: string; params?: unknown[] }>): Promise<{ changes: number }> {
    if (statements.length === 0) {
      return { changes: 0 };
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let totalChanges = 0;

      for (const stmt of statements) {
        const pgSql = convertSql(stmt.sql, "postgres");
        const result = await client.query(pgSql, stmt.params ?? []);
        totalChanges += result.rowCount ?? 0;
      }

      await client.query("COMMIT");
      return { changes: totalChanges };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
