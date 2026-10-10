/**
 * sqlite-vec is registered per SQLite connection, not per database file.
 * Restores open fresh readonly connections and replace the live connection;
 * both need the module before integrity checks and virtual-table queries.
 */
import type Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export interface SqliteVecLoadResult {
  loaded: boolean;
  error?: string;
}

const connectionStatus = new WeakMap<Database.Database, SqliteVecLoadResult>();

/** Register sqlite-vec at most once per connection (including readonly snapshots). */
export function loadSqliteVec(db: Database.Database): SqliteVecLoadResult {
  const previous = connectionStatus.get(db);
  if (previous) return previous;
  let result: SqliteVecLoadResult;
  try {
    sqliteVec.load(db);
    // Verify that the module registered, rather than only locating a binary.
    db.prepare("SELECT vec_version() AS version").get();
    result = { loaded: true };
  } catch (error) {
    result = { loaded: false, error: error instanceof Error ? error.message : String(error) };
  }
  connectionStatus.set(db, result);
  return result;
}

/** Ordinary SQLite databases work without sqlite-vec, but ones with vec0 do not. */
export function requireSqliteVecForStoredTables(db: Database.Database, context: string): void {
  const candidates = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%vec0%'",
  ).all() as Array<{ sql: string | null }>;
  const hasVecTable = candidates.some(({ sql }) => /\bUSING\s+["'`]?vec0["'`]?\s*\(/i.test(sql || ""));
  if (!hasVecTable) return;

  const loaded = loadSqliteVec(db);
  if (!loaded.loaded) {
    throw new Error(
      `${context}包含 vec0 向量索引，但 sqlite-vec 扩展无法加载：${loaded.error || "unknown"}。` +
      "请检查当前程序与 Docker 镜像中的 sqlite-vec 原生模块，不要直接覆盖现有数据库。",
    );
  }
}
