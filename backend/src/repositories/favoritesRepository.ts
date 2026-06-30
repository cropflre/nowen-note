/**
 * Favorites Repository
 *
 * 职责：
 * - 封装 favorites 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 * - 支持 adapter 注入（PG-PILOT-03 双库试点）
 *
 * favorites 表结构：
 * - userId TEXT NOT NULL
 * - noteId TEXT NOT NULL
 * - workspaceId TEXT (nullable, NULL=个人空间)
 * - createdAt TEXT NOT NULL
 * - PRIMARY KEY (userId, noteId)
 */

import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";
import type { DatabaseAdapter } from "../db/adapters/types";

/** 创建轻量 adapter 实例（每次调用新建，无全局生命周期） */
function getAdapter() {
  return new SqliteAdapter(getDb());
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
 * 默认使用 SQLite adapter。测试中可注入 PostgresAdapter 进行双库验证。
 *
 * @param adapter 数据库适配器（默认 SQLite）
 * @param nowExpr 当前时间表达式（SQLite: datetime('now'), PostgreSQL: NOW()）
 * @param insertPrefix INSERT 前缀（SQLite: "INSERT OR IGNORE", PostgreSQL: "INSERT"）
 * @param conflictClause 冲突子句（SQLite: "", PostgreSQL: 'ON CONFLICT ("userId", "noteId") DO NOTHING'）
 */
export function createFavoritesRepository(
  adapter: DatabaseAdapter = getAdapter(),
  nowExpr = "datetime('now')",
  insertPrefix = "INSERT OR IGNORE",
  conflictClause = "",
) {
  return {
    // ---- 同步方法（仅 SQLite） ----

    /**
     * 检查用户是否收藏了某笔记。
     */
    isFavorited(userId: string, noteId: string): boolean {
      const db = getDb();
      const row = db
        .prepare('SELECT 1 FROM favorites WHERE "userId" = ? AND "noteId" = ?')
        .get(userId, noteId);
      return !!row;
    },

    /**
     * 添加收藏。
     */
    addFavorite(userId: string, noteId: string, workspaceId: string | null): void {
      const db = getDb();
      db.prepare(
        `${insertPrefix} INTO favorites ("userId", "noteId", "workspaceId", "createdAt") VALUES (?, ?, ?, ${nowExpr}) ${conflictClause}`
      ).run(userId, noteId, workspaceId);
    },

    /**
     * 取消收藏。
     */
    removeFavorite(userId: string, noteId: string): void {
      const db = getDb();
      db.prepare('DELETE FROM favorites WHERE "userId" = ? AND "noteId" = ?').run(userId, noteId);
    },

    /**
     * 切换收藏状态。
     */
    toggleFavorite(userId: string, noteId: string, workspaceId: string | null): boolean {
      if (this.isFavorited(userId, noteId)) {
        this.removeFavorite(userId, noteId);
        return false;
      } else {
        this.addFavorite(userId, noteId, workspaceId);
        return true;
      }
    },

    /**
     * 获取用户的收藏笔记 ID 列表。
     */
    listFavoriteNoteIds(userId: string, workspaceId?: string | null): string[] {
      const db = getDb();
      if (workspaceId !== undefined) {
        const rows = db
          .prepare('SELECT "noteId" FROM favorites WHERE "userId" = ? AND "workspaceId" = ? ORDER BY "createdAt" DESC')
          .all(userId, workspaceId) as { noteId: string }[];
        return rows.map((r) => r.noteId);
      } else {
        const rows = db
          .prepare('SELECT "noteId" FROM favorites WHERE "userId" = ? ORDER BY "createdAt" DESC')
          .all(userId) as { noteId: string }[];
        return rows.map((r) => r.noteId);
      }
    },

    /**
     * 删除笔记的所有收藏记录。
     */
    deleteByNoteId(noteId: string): number {
      const db = getDb();
      const result = db.prepare('DELETE FROM favorites WHERE "noteId" = ?').run(noteId);
      return result.changes;
    },

    /**
     * 删除用户的所有收藏记录。
     */
    deleteByUserId(userId: string): number {
      const db = getDb();
      const result = db.prepare('DELETE FROM favorites WHERE "userId" = ?').run(userId);
      return result.changes;
    },

    // ---- Async 方法（支持 adapter 注入） ----

    /** 检查用户是否收藏了某笔记（async） */
    async isFavoritedAsync(userId: string, noteId: string): Promise<boolean> {
      const row = await adapter.queryOne<{ id: string }>(
        'SELECT 1 FROM favorites WHERE "userId" = ? AND "noteId" = ?',
        [userId, noteId],
      );
      return !!row;
    },

    /** 添加收藏（async） */
    async addFavoriteAsync(userId: string, noteId: string, workspaceId: string | null): Promise<void> {
      await adapter.execute(
        `${insertPrefix} INTO favorites ("userId", "noteId", "workspaceId", "createdAt") VALUES (?, ?, ?, ${nowExpr}) ${conflictClause}`,
        [userId, noteId, workspaceId],
      );
    },

    /** 取消收藏（async） */
    async removeFavoriteAsync(userId: string, noteId: string): Promise<void> {
      await adapter.execute(
        'DELETE FROM favorites WHERE "userId" = ? AND "noteId" = ?',
        [userId, noteId],
      );
    },

    /** 切换收藏状态（async） */
    async toggleFavoriteAsync(userId: string, noteId: string, workspaceId: string | null): Promise<boolean> {
      const isFav = await this.isFavoritedAsync(userId, noteId);
      if (isFav) {
        await this.removeFavoriteAsync(userId, noteId);
        return false;
      } else {
        await this.addFavoriteAsync(userId, noteId, workspaceId);
        return true;
      }
    },

    /** 获取用户的收藏笔记 ID 列表（async） */
    async listFavoriteNoteIdsAsync(userId: string, workspaceId?: string | null): Promise<string[]> {
      if (workspaceId !== undefined) {
        const rows = await adapter.queryMany<{ noteId: string }>(
          'SELECT "noteId" FROM favorites WHERE "userId" = ? AND "workspaceId" = ? ORDER BY "createdAt" DESC',
          [userId, workspaceId],
        );
        return rows.map((r) => r.noteId);
      } else {
        const rows = await adapter.queryMany<{ noteId: string }>(
          'SELECT "noteId" FROM favorites WHERE "userId" = ? ORDER BY "createdAt" DESC',
          [userId],
        );
        return rows.map((r) => r.noteId);
      }
    },

    /** 删除笔记的所有收藏记录（async） */
    async deleteByNoteIdAsync(noteId: string): Promise<number> {
      const result = await adapter.execute(
        'DELETE FROM favorites WHERE "noteId" = ?',
        [noteId],
      );
      return result.changes;
    },

    /** 删除用户的所有收藏记录（async） */
    async deleteByUserIdAsync(userId: string): Promise<number> {
      const result = await adapter.execute(
        'DELETE FROM favorites WHERE "userId" = ?',
        [userId],
      );
      return result.changes;
    },
  };
}

/** 默认实例（SQLite，保持向后兼容） */
export const favoritesRepository = createFavoritesRepository();
