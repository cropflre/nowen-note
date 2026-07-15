import { getDb } from "../db/schema";
import type { DatabaseAdapter } from "../db/adapters/types";
import { nowExpression, type DatabaseDialect } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function resolveDialect(): DatabaseDialect {
  try {
    return getDatabaseDialect();
  } catch {
    return "sqlite";
  }
}

function resolveAsyncSqlOptions(options: {
  nowExpr?: string;
  insertPrefix?: string;
  conflictClause?: string;
}) {
  const dialect = resolveDialect();
  return {
    nowExpr: options.nowExpr ?? nowExpression(dialect),
    insertPrefix: options.insertPrefix ?? (dialect === "postgres" ? "INSERT" : "INSERT OR IGNORE"),
    conflictClause: options.conflictClause
      ?? (dialect === "postgres" ? 'ON CONFLICT ("userId", "noteId") DO NOTHING' : ""),
  };
}

/** favorites 记录 */
export interface FavoriteRecord {
  userId: string;
  noteId: string;
  workspaceId: string | null;
  createdAt: string;
}

/**
 * 创建 favoritesRepository 实例。
 *
 * 未显式注入 adapter 时，异步方法从统一数据库运行时获取 Adapter；
 * 同步方法继续仅支持 SQLite，以保持现有调用兼容。
 */
export function createFavoritesRepository(
  adapter?: DatabaseAdapter,
  nowExpr?: string,
  insertPrefix?: string,
  conflictClause?: string,
) {
  const getAdapter = () => resolveAdapter(adapter);
  const syncSql = {
    nowExpr: nowExpr ?? nowExpression("sqlite"),
    insertPrefix: insertPrefix ?? "INSERT OR IGNORE",
    conflictClause: conflictClause ?? "",
  };
  const getAsyncSql = () => resolveAsyncSqlOptions({ nowExpr, insertPrefix, conflictClause });

  return {
    // ---- 同步方法（仅 SQLite） ----

    isFavorited(userId: string, noteId: string): boolean {
      const db = getDb();
      const row = db
        .prepare('SELECT 1 FROM favorites WHERE "userId" = ? AND "noteId" = ?')
        .get(userId, noteId);
      return !!row;
    },

    addFavorite(userId: string, noteId: string, workspaceId: string | null): void {
      const db = getDb();
      db.prepare(
        `${syncSql.insertPrefix} INTO favorites ("userId", "noteId", "workspaceId", "createdAt") VALUES (?, ?, ?, ${syncSql.nowExpr}) ${syncSql.conflictClause}`,
      ).run(userId, noteId, workspaceId);
    },

    removeFavorite(userId: string, noteId: string): void {
      const db = getDb();
      db.prepare('DELETE FROM favorites WHERE "userId" = ? AND "noteId" = ?').run(userId, noteId);
    },

    toggleFavorite(userId: string, noteId: string, workspaceId: string | null): boolean {
      if (this.isFavorited(userId, noteId)) {
        this.removeFavorite(userId, noteId);
        return false;
      }
      this.addFavorite(userId, noteId, workspaceId);
      return true;
    },

    listFavoriteNoteIds(userId: string, workspaceId?: string | null): string[] {
      const db = getDb();
      if (workspaceId !== undefined) {
        const rows = db
          .prepare('SELECT "noteId" FROM favorites WHERE "userId" = ? AND "workspaceId" = ? ORDER BY "createdAt" DESC')
          .all(userId, workspaceId) as { noteId: string }[];
        return rows.map((r) => r.noteId);
      }
      const rows = db
        .prepare('SELECT "noteId" FROM favorites WHERE "userId" = ? ORDER BY "createdAt" DESC')
        .all(userId) as { noteId: string }[];
      return rows.map((r) => r.noteId);
    },

    deleteByNoteId(noteId: string): number {
      const db = getDb();
      const result = db.prepare('DELETE FROM favorites WHERE "noteId" = ?').run(noteId);
      return result.changes;
    },

    deleteByUserId(userId: string): number {
      const db = getDb();
      const result = db.prepare('DELETE FROM favorites WHERE "userId" = ?').run(userId);
      return result.changes;
    },

    // ---- Async 方法（支持运行时 Adapter / 显式注入） ----

    async isFavoritedAsync(userId: string, noteId: string): Promise<boolean> {
      const row = await getAdapter().queryOne<{ present: number }>(
        'SELECT 1 AS present FROM favorites WHERE "userId" = ? AND "noteId" = ?',
        [userId, noteId],
      );
      return !!row;
    },

    async addFavoriteAsync(userId: string, noteId: string, workspaceId: string | null): Promise<void> {
      const sql = getAsyncSql();
      await getAdapter().execute(
        `${sql.insertPrefix} INTO favorites ("userId", "noteId", "workspaceId", "createdAt") VALUES (?, ?, ?, ${sql.nowExpr}) ${sql.conflictClause}`,
        [userId, noteId, workspaceId],
      );
    },

    async removeFavoriteAsync(userId: string, noteId: string): Promise<void> {
      await getAdapter().execute(
        'DELETE FROM favorites WHERE "userId" = ? AND "noteId" = ?',
        [userId, noteId],
      );
    },

    async toggleFavoriteAsync(userId: string, noteId: string, workspaceId: string | null): Promise<boolean> {
      const isFav = await this.isFavoritedAsync(userId, noteId);
      if (isFav) {
        await this.removeFavoriteAsync(userId, noteId);
        return false;
      }
      await this.addFavoriteAsync(userId, noteId, workspaceId);
      return true;
    },

    async listFavoriteNoteIdsAsync(userId: string, workspaceId?: string | null): Promise<string[]> {
      if (workspaceId !== undefined) {
        const rows = await getAdapter().queryMany<{ noteId: string }>(
          'SELECT "noteId" FROM favorites WHERE "userId" = ? AND "workspaceId" = ? ORDER BY "createdAt" DESC',
          [userId, workspaceId],
        );
        return rows.map((r) => r.noteId);
      }
      const rows = await getAdapter().queryMany<{ noteId: string }>(
        'SELECT "noteId" FROM favorites WHERE "userId" = ? ORDER BY "createdAt" DESC',
        [userId],
      );
      return rows.map((r) => r.noteId);
    },

    async deleteByNoteIdAsync(noteId: string): Promise<number> {
      const result = await getAdapter().execute(
        'DELETE FROM favorites WHERE "noteId" = ?',
        [noteId],
      );
      return result.changes;
    },

    async deleteByUserIdAsync(userId: string): Promise<number> {
      const result = await getAdapter().execute(
        'DELETE FROM favorites WHERE "userId" = ?',
        [userId],
      );
      return result.changes;
    },
  };
}

/** 默认实例：同步方法仍为 SQLite；异步方法使用统一运行时 Adapter。 */
export const favoritesRepository = createFavoritesRepository();
