/**
 * Database Adapters 入口
 *
 * Phase 1：只导出类型定义和 SQLite adapter。
 * Phase 2：未来导出 PostgreSQL adapter。
 */

export type { DbAdapter, DbRunResult } from "./types";
export { SqliteAdapter } from "./sqliteAdapter";
