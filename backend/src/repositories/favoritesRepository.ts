/**
 * Favorites Repository
 *
 * 职责：
 * - 封装 favorites 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
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

/** 创建轻量 adapter 实例 */
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

export const favoritesRepository = {
  /**
   * 检查用户是否收藏了某笔记。
   *
   * @param userId 用户 ID
   * @param noteId 笔记 ID
   * @returns 是否收藏
   */
  isFavorited(userId: string, noteId: string): boolean {
    const db = getDb();
    const row = db
      .prepare("SELECT 1 FROM favorites WHERE userId = ? AND noteId = ?")
      .get(userId, noteId);
    return !!row;
  },

  /**
   * 添加收藏。
   *
   * @param userId 用户 ID
   * @param noteId 笔记 ID
   * @param workspaceId 工作区 ID（null = 个人空间）
   */
  addFavorite(userId: string, noteId: string, workspaceId: string | null): void {
    const db = getDb();
    db.prepare(
      "INSERT OR IGNORE INTO favorites (userId, noteId, workspaceId, createdAt) VALUES (?, ?, ?, datetime('now'))"
    ).run(userId, noteId, workspaceId);
  },

  /**
   * 取消收藏。
   *
   * @param userId 用户 ID
   * @param noteId 笔记 ID
   */
  removeFavorite(userId: string, noteId: string): void {
    const db = getDb();
    db.prepare("DELETE FROM favorites WHERE userId = ? AND noteId = ?").run(userId, noteId);
  },

  /**
   * 切换收藏状态。
   *
   * @param userId 用户 ID
   * @param noteId 笔记 ID
   * @param workspaceId 工作区 ID（null = 个人空间）
   * @returns 新的收藏状态
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
   *
   * @param userId 用户 ID
   * @param workspaceId 工作区 ID（null = 个人空间，undefined = 所有空间）
   * @returns 收藏的笔记 ID 列表
   */
  listFavoriteNoteIds(userId: string, workspaceId?: string | null): string[] {
    const db = getDb();
    if (workspaceId !== undefined) {
      const rows = db
        .prepare("SELECT noteId FROM favorites WHERE userId = ? AND workspaceId = ? ORDER BY createdAt DESC")
        .all(userId, workspaceId) as { noteId: string }[];
      return rows.map((r) => r.noteId);
    } else {
      const rows = db
        .prepare("SELECT noteId FROM favorites WHERE userId = ? ORDER BY createdAt DESC")
        .all(userId) as { noteId: string }[];
      return rows.map((r) => r.noteId);
    }
  },

  /**
   * 删除笔记的所有收藏记录。
   *
   * @param noteId 笔记 ID
   * @returns 删除的行数
   */
  deleteByNoteId(noteId: string): number {
    const db = getDb();
    const result = db.prepare("DELETE FROM favorites WHERE noteId = ?").run(noteId);
    return result.changes;
  },

  /**
   * 删除用户的所有收藏记录。
   *
   * @param userId 用户 ID
   * @returns 删除的行数
   */
  deleteByUserId(userId: string): number {
    const db = getDb();
    const result = db.prepare("DELETE FROM favorites WHERE userId = ?").run(userId);
    return result.changes;
  },

  // ============================================================
  // Async 方法（批量试点，使用 SqliteAdapter）
  // ============================================================

  /** 检查用户是否收藏了某笔记（async） */
  async isFavoritedAsync(userId: string, noteId: string): Promise<boolean> {
    const row = await getAdapter().queryOne<{ id: string }>(
      "SELECT 1 FROM favorites WHERE userId = ? AND noteId = ?",
      [userId, noteId],
    );
    return !!row;
  },

  /** 添加收藏（async） */
  async addFavoriteAsync(userId: string, noteId: string, workspaceId: string | null): Promise<void> {
    await getAdapter().execute(
      "INSERT OR IGNORE INTO favorites (userId, noteId, workspaceId, createdAt) VALUES (?, ?, ?, datetime('now'))",
      [userId, noteId, workspaceId],
    );
  },

  /** 取消收藏（async） */
  async removeFavoriteAsync(userId: string, noteId: string): Promise<void> {
    await getAdapter().execute(
      "DELETE FROM favorites WHERE userId = ? AND noteId = ?",
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
      const rows = await getAdapter().queryMany<{ noteId: string }>(
        "SELECT noteId FROM favorites WHERE userId = ? AND workspaceId = ? ORDER BY createdAt DESC",
        [userId, workspaceId],
      );
      return rows.map((r) => r.noteId);
    } else {
      const rows = await getAdapter().queryMany<{ noteId: string }>(
        "SELECT noteId FROM favorites WHERE userId = ? ORDER BY createdAt DESC",
        [userId],
      );
      return rows.map((r) => r.noteId);
    }
  },

  /** 删除笔记的所有收藏记录（async） */
  async deleteByNoteIdAsync(noteId: string): Promise<number> {
    const result = await getAdapter().execute(
      "DELETE FROM favorites WHERE noteId = ?",
      [noteId],
    );
    return result.changes;
  },

  /** 删除用户的所有收藏记录（async） */
  async deleteByUserIdAsync(userId: string): Promise<number> {
    const result = await getAdapter().execute(
      "DELETE FROM favorites WHERE userId = ?",
      [userId],
    );
    return result.changes;
  },
};
