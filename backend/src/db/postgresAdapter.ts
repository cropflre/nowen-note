/**
 * PostgreSQL Async Adapter
 *
 * 实现 DatabaseAdapter 接口，用于 PostgreSQL 数据库。
 * Repository 可以继续使用统一的 SQLite 风格参数占位符与项目约定 SQL，
 * Adapter 会在送入 node-postgres 前完成保守的方言规范化。
 */

import type { Pool, PoolClient, QueryResult } from "pg";
import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbRunResult,
  type DbStatement,
} from "./adapters/types";
import { convertSql } from "./dialect";

async function poolQuery(pool: Pool, sql: string, params: unknown[]): Promise<QueryResult> {
  return params.length > 0 ? pool.query(sql, params) : pool.query(sql);
}

async function clientQuery(client: PoolClient, sql: string, params: unknown[]): Promise<QueryResult> {
  return params.length > 0 ? client.query(sql, params) : client.query(sql);
}

function assertRequiredChanges(statement: DbStatement, changes: number): void {
  if (statement.requireChanges === undefined || changes === statement.requireChanges) return;
  throw new DbStatementChangeError(statement.requireChanges, changes);
}

export class PostgresAdapter implements DatabaseAdapter {
  constructor(private readonly pool: Pool) {}

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await poolQuery(this.pool, convertSql(sql, "postgres"), params);
    return (result.rows[0] as T) ?? undefined;
  }

  async queryMany<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await poolQuery(this.pool, convertSql(sql, "postgres"), params);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<DbRunResult> {
    const result = await poolQuery(this.pool, convertSql(sql, "postgres"), params);
    return {
      changes: result.rowCount ?? 0,
    };
  }

  async executeBatch(sql: string, paramsList: unknown[][]): Promise<DbRunResult> {
    if (paramsList.length === 0) return { changes: 0 };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let totalChanges = 0;
      const pgSql = convertSql(sql, "postgres");

      for (const params of paramsList) {
        const result = await clientQuery(client, pgSql, params);
        totalChanges += result.rowCount ?? 0;
      }

      await client.query("COMMIT");
      return { changes: totalChanges };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async executeStatements(statements: DbStatement[]): Promise<{ changes: number }> {
    if (statements.length === 0) return { changes: 0 };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let totalChanges = 0;

      for (const statement of statements) {
        const result = await clientQuery(
          client,
          convertSql(statement.sql, "postgres"),
          statement.params ?? [],
        );
        const changes = result.rowCount ?? 0;
        assertRequiredChanges(statement, changes);
        totalChanges += changes;
      }

      await client.query("COMMIT");
      return { changes: totalChanges };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
