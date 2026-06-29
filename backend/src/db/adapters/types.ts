/**
 * Database Adapter 类型定义
 *
 * Phase 1 最小接口：只定义 queryOne / queryMany / execute。
 * Phase 2 扩展：withTransaction（需手写 BEGIN/COMMIT/ROLLBACK）。
 *
 * 设计原则：
 * - SQLite adapter 包装 better-sqlite3 同步 API 为 async facade
 * - PostgreSQL adapter 未来接 pg 异步 API
 * - 不定义 withTransaction（Phase 2 才实现）
 * - 禁止 db.transaction(async () => {})——会导致事务边界失真
 */

/** 写操作返回值 */
export interface DbRunResult {
  /** 影响行数（SQLite: changes, PostgreSQL: rowCount） */
  changes: number;
  /** 最后插入的行 ID（仅 SQLite；PostgreSQL 需用 RETURNING） */
  lastInsertRowid?: number | bigint;
}

/** Phase 1 最小数据库适配器接口（无事务） */
export interface DbAdapter {
  /** 查询单条记录 */
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | undefined>;

  /** 查询多条记录 */
  queryMany<T>(sql: string, params?: unknown[]): Promise<T[]>;

  /** 执行写操作（INSERT/UPDATE/DELETE） */
  execute(sql: string, params?: unknown[]): Promise<DbRunResult>;
}
