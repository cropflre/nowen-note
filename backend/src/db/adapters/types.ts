/**
 * Database Adapter 类型定义
 *
 * 统一数据库适配器接口，支持 SQLite 和 PostgreSQL。
 * 所有 Adapter 必须实现此接口。
 *
 * 设计原则：
 * - queryOne / queryMany / execute / executeBatch / executeStatements 为统一 API
 * - SQLite adapter 包装 better-sqlite3 同步 API 为 async facade
 * - PostgreSQL adapter 接 pg 异步 API
 * - 禁止 db.transaction(async () => {})——会导致事务边界失真
 * - executeStatements 通过 requireChanges 支持乐观锁原子回滚
 */

/** 写操作返回值 */
export interface DbRunResult {
  /** 影响行数（SQLite: changes, PostgreSQL: rowCount） */
  changes: number;
  /** 最后插入的行 ID（仅 SQLite；PostgreSQL 需用 RETURNING） */
  lastInsertRowid?: number | bigint;
}

/** 同一事务中执行的一条语句。 */
export interface DbStatement {
  sql: string;
  params?: unknown[];
  /**
   * 要求该语句恰好影响指定行数；不满足时抛错并回滚整个事务。
   * 主要用于 UPDATE ... WHERE version = ? 的乐观锁边界。
   */
  requireChanges?: number;
}

/** requireChanges 不满足时抛出的可识别错误。 */
export class DbStatementChangeError extends Error {
  constructor(
    readonly expectedChanges: number,
    readonly actualChanges: number,
  ) {
    super(`[db] transactional statement expected ${expectedChanges} changed row(s), received ${actualChanges}`);
    this.name = "DbStatementChangeError";
  }
}

/**
 * 统一数据库适配器接口。
 *
 * SqliteAdapter 和 PostgresAdapter 都必须实现此接口。
 * Repository 层通过此接口访问数据库，不直接依赖具体驱动。
 */
export interface DatabaseAdapter {
  /** 查询单条记录 */
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | undefined>;

  /** 查询多条记录 */
  queryMany<T>(sql: string, params?: unknown[]): Promise<T[]>;

  /** 执行写操作（INSERT/UPDATE/DELETE） */
  execute(sql: string, params?: unknown[]): Promise<DbRunResult>;

  /** 批量执行同一条 SQL（在事务中执行，中途失败整体回滚） */
  executeBatch(sql: string, paramsList: unknown[][]): Promise<DbRunResult>;

  /** 执行多条不同 SQL（在同一事务中执行，中途失败整体回滚） */
  executeStatements(statements: DbStatement[]): Promise<{ changes: number }>;
}

/** @deprecated Use DatabaseAdapter instead */
export type DbAdapter = DatabaseAdapter;
