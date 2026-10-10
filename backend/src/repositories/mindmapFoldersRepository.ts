/**
 * Mindmap Folders Repository
 *
 * 职责：
 * - 封装 mindmap_folders 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import { getDatabaseAdapter } from "../db/runtime";
import type Database from "better-sqlite3";

function getAdapter() {
  return getDatabaseAdapter();
}

/** mindmap_folders 记录 */
export interface MindmapFolderRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const mindmapFoldersRepository = {
  /**
   * 获取文件夹深度（用于限制最多三级）。
   *
   * @param folderId 文件夹 ID
   * @returns 深度（0-3）
   */
  getFolderDepth(folderId: string | null): number {
    if (!folderId) return 0;
    const db = getDb();
    let depth = 0;
    let currentId: string | null = folderId;
    while (currentId && depth <= 3) {
      depth++;
      const row = db.prepare("SELECT parentId FROM mindmap_folders WHERE id = ?").get(currentId) as { parentId: string | null } | undefined;
      currentId = row?.parentId || null;
    }
    return depth;
  },

  /**
   * 获取文件夹列表。
   *
   * @param userId 用户 ID
   * @param workspaceId 工作区 ID（null = 个人空间）
   * @returns 文件夹列表
   */
  listByUser(userId: string, workspaceId: string | null): MindmapFolderRecord[] {
    const db = getDb();
    if (workspaceId) {
      return db
        .prepare("SELECT * FROM mindmap_folders WHERE workspaceId = ? ORDER BY sortOrder, name")
        .all(workspaceId) as MindmapFolderRecord[];
    } else {
      return db
        .prepare("SELECT * FROM mindmap_folders WHERE userId = ? AND workspaceId IS NULL ORDER BY sortOrder, name")
        .all(userId) as MindmapFolderRecord[];
    }
  },

  /**
   * 获取文件夹详情。
   *
   * @param folderId 文件夹 ID
   * @returns 文件夹记录，或 undefined
   */
  getById(folderId: string): MindmapFolderRecord | undefined {
    const db = getDb();
    return db
      .prepare("SELECT * FROM mindmap_folders WHERE id = ?")
      .get(folderId) as MindmapFolderRecord | undefined;
  },

  /**
   * 创建文件夹。
   *
   * @param input 文件夹数据
   */
  create(input: {
    id: string;
    userId: string;
    workspaceId: string | null;
    parentId: string | null;
    name: string;
  }): void {
    const db = getDb();
    db.prepare(
      "INSERT INTO mindmap_folders (id, userId, workspaceId, parentId, name) VALUES (?, ?, ?, ?, ?)"
    ).run(input.id, input.userId, input.workspaceId, input.parentId, input.name);
  },

  /**
   * 更新文件夹名称。
   *
   * @param folderId 文件夹 ID
   * @param name 新名称
   */
  updateName(folderId: string, name: string): void {
    const db = getDb();
    db.prepare("UPDATE mindmap_folders SET name = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(name, folderId);
  },

  /**
   * 更新文件夹父级。
   *
   * @param folderId 文件夹 ID
   * @param parentId 新父文件夹 ID（null = 顶层）
   */
  updateParentId(folderId: string, parentId: string | null): void {
    const db = getDb();
    db.prepare("UPDATE mindmap_folders SET parentId = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(parentId, folderId);
  },

  /**
   * 更新文件夹排序。
   *
   * @param folderId 文件夹 ID
   * @param sortOrder 新排序值
   */
  updateSortOrder(folderId: string, sortOrder: number): void {
    const db = getDb();
    db.prepare("UPDATE mindmap_folders SET sortOrder = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(sortOrder, folderId);
  },

  /**
   * 删除文件夹（子文件夹移到顶层）。
   *
   * @param folderId 文件夹 ID
   */
  delete(folderId: string): void {
    const db = getDb();
    db.prepare("UPDATE mindmap_folders SET parentId = NULL, updatedAt = datetime('now') WHERE parentId = ?").run(folderId);
    db.prepare("DELETE FROM mindmap_folders WHERE id = ?").run(folderId);
  },

  async getFolderDepthAsync(folderId: string | null): Promise<number> {
    if (!folderId) return 0;
    let depth = 0;
    let currentId: string | null = folderId;
    while (currentId && depth <= 3) {
      depth++;
      const row: { parentId: string | null } | undefined = await getAdapter().queryOne<{ parentId: string | null }>(
        `SELECT "parentId" FROM mindmap_folders WHERE id = ?`,
        [currentId],
      );
      currentId = row?.parentId || null;
    }
    return depth;
  },

  async listByUserAsync(userId: string, workspaceId: string | null): Promise<MindmapFolderRecord[]> {
    if (workspaceId) {
      return getAdapter().queryMany<MindmapFolderRecord>(
        `SELECT * FROM mindmap_folders WHERE "workspaceId" = ? ORDER BY "sortOrder", name`,
        [workspaceId],
      );
    } else {
      return getAdapter().queryMany<MindmapFolderRecord>(
        `SELECT * FROM mindmap_folders WHERE "userId" = ? AND "workspaceId" IS NULL ORDER BY "sortOrder", name`,
        [userId],
      );
    }
  },

  async getByIdAsync(folderId: string): Promise<MindmapFolderRecord | undefined> {
    return getAdapter().queryOne<MindmapFolderRecord>("SELECT * FROM mindmap_folders WHERE id = ?", [folderId]);
  },

  async createAsync(input: {
    id: string;
    userId: string;
    workspaceId: string | null;
    parentId: string | null;
    name: string;
  }): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO mindmap_folders (id, "userId", "workspaceId", "parentId", name) VALUES (?, ?, ?, ?, ?)`,
      [input.id, input.userId, input.workspaceId, input.parentId, input.name],
    );
  },

  async updateNameAsync(folderId: string, name: string): Promise<void> {
    await getAdapter().execute(
      `UPDATE mindmap_folders SET name = ?, "updatedAt" = ? WHERE id = ?`,
      [name, new Date().toISOString(), folderId],
    );
  },

  async updateParentIdAsync(folderId: string, parentId: string | null): Promise<void> {
    await getAdapter().execute(
      `UPDATE mindmap_folders SET "parentId" = ?, "updatedAt" = ? WHERE id = ?`,
      [parentId, new Date().toISOString(), folderId],
    );
  },

  async updateSortOrderAsync(folderId: string, sortOrder: number): Promise<void> {
    await getAdapter().execute(
      `UPDATE mindmap_folders SET "sortOrder" = ?, "updatedAt" = ? WHERE id = ?`,
      [sortOrder, new Date().toISOString(), folderId],
    );
  },

  async deleteAsync(folderId: string): Promise<void> {
    await getAdapter().execute(
      `UPDATE mindmap_folders SET "parentId" = NULL, "updatedAt" = ? WHERE "parentId" = ?`,
      [new Date().toISOString(), folderId],
    );
    await getAdapter().execute("DELETE FROM mindmap_folders WHERE id = ?", [folderId]);
  },
};
