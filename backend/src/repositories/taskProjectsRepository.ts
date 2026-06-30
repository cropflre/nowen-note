/**
 * Task Projects Repository
 *
 * 职责：
 * - 封装 task_projects 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";

function getAdapter() {
  return new SqliteAdapter(getDb());
}

/** task_projects 记录 */
export interface TaskProjectRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** task_projects 列表项（含统计） */
export interface TaskProjectWithStats extends TaskProjectRecord {
  taskCount: number;
  completedCount: number;
  progress: number;
}

export const taskProjectsRepository = {
  /**
   * 获取项目列表（含任务统计）。
   *
   * @param userId 用户 ID
   * @param workspaceId 工作区 ID（null = 个人空间）
   * @returns 项目列表
   */
  listByUser(userId: string, workspaceId: string | null): TaskProjectWithStats[] {
    const db = getDb();
    if (workspaceId) {
      return db.prepare(
        "SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id) AS taskCount, " +
        "(SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id AND t.isCompleted = 1) AS completedCount, " +
        "CASE WHEN (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id) > 0 THEN " +
        "ROUND(100.0 * (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id AND t.isCompleted = 1) / " +
        "(SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id)) ELSE 0 END AS progress " +
        "FROM task_projects p WHERE p.workspaceId = ? ORDER BY p.sortOrder ASC, p.createdAt ASC"
      ).all(workspaceId) as TaskProjectWithStats[];
    } else {
      return db.prepare(
        "SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id) AS taskCount, " +
        "(SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id AND t.isCompleted = 1) AS completedCount, " +
        "CASE WHEN (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id) > 0 THEN " +
        "ROUND(100.0 * (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id AND t.isCompleted = 1) / " +
        "(SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id)) ELSE 0 END AS progress " +
        "FROM task_projects p WHERE p.userId = ? AND p.workspaceId IS NULL ORDER BY p.sortOrder ASC, p.createdAt ASC"
      ).all(userId) as TaskProjectWithStats[];
    }
  },

  /**
   * 获取项目详情。
   *
   * @param projectId 项目 ID
   * @returns 项目记录，或 undefined
   */
  getById(projectId: string): TaskProjectRecord | undefined {
    const db = getDb();
    return db
      .prepare("SELECT * FROM task_projects WHERE id = ?")
      .get(projectId) as TaskProjectRecord | undefined;
  },

  /**
   * 获取项目详情（含统计）。
   *
   * @param projectId 项目 ID
   * @returns 项目记录（含统计），或 undefined
   */
  getByIdWithStats(projectId: string): TaskProjectWithStats | undefined {
    const db = getDb();
    return db.prepare(
      "SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id) AS taskCount, " +
      "(SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id AND t.isCompleted = 1) AS completedCount, " +
      "CASE WHEN (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id) > 0 THEN " +
      "ROUND(100.0 * (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id AND t.isCompleted = 1) / " +
      "(SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id)) ELSE 0 END AS progress " +
      "FROM task_projects p WHERE p.id = ?"
    ).get(projectId) as TaskProjectWithStats | undefined;
  },

  /**
   * 创建项目。
   *
   * @param input 项目数据
   */
  create(input: {
    id: string;
    userId: string;
    workspaceId: string | null;
    name: string;
    icon: string | null;
    color: string | null;
    sortOrder: number;
  }): void {
    const db = getDb();
    db.prepare(
      "INSERT INTO task_projects (id, userId, workspaceId, name, icon, color, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(input.id, input.userId, input.workspaceId, input.name, input.icon, input.color, input.sortOrder);
  },

  /**
   * 更新项目。
   *
   * @param projectId 项目 ID
   * @param input 更新数据
   */
  update(projectId: string, input: {
    name: string;
    icon: string | null;
    color: string | null;
    sortOrder: number;
  }): void {
    const db = getDb();
    db.prepare(
      "UPDATE task_projects SET name = ?, icon = ?, color = ?, sortOrder = ?, updatedAt = datetime('now') WHERE id = ?"
    ).run(input.name, input.icon, input.color, input.sortOrder, projectId);
  },

  /**
   * 删除项目。
   *
   * @param projectId 项目 ID
   */
  delete(projectId: string): void {
    const db = getDb();
    db.prepare("UPDATE tasks SET projectId = NULL WHERE projectId = ?").run(projectId);
    db.prepare("DELETE FROM task_projects WHERE id = ?").run(projectId);
  },

  /**
   * 批量更新项目排序。
   *
   * @param items 排序数据
   */
  updateSortOrder(items: Array<{ id: string; sortOrder: number }>): void {
    const db = getDb();
    const stmt = db.prepare("UPDATE task_projects SET sortOrder = ?, updatedAt = datetime('now') WHERE id = ?");
    const tx = db.transaction(() => {
      for (const item of items) {
        stmt.run(item.sortOrder, item.id);
      }
    });
    tx();
  },

  /** 批量更新项目排序（async，使用 executeBatch 事务） */
  async updateSortOrderAsync(items: Array<{ id: string; sortOrder: number }>): Promise<void> {
    if (items.length === 0) return;
    await getAdapter().executeBatch(
      "UPDATE task_projects SET sortOrder = ?, updatedAt = datetime('now') WHERE id = ?",
      items.map((i) => [i.sortOrder, i.id]),
    );
  },

  /** 获取项目列表（含任务统计，async） */
  async listByUserAsync(userId: string, workspaceId: string | null): Promise<TaskProjectWithStats[]> {
    if (workspaceId) {
      return getAdapter().queryMany<TaskProjectWithStats>(
        "SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id) AS taskCount, " +
        "(SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id AND t.isCompleted = 1) AS completedCount, " +
        "CASE WHEN (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id) > 0 THEN " +
        "ROUND(100.0 * (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id AND t.isCompleted = 1) / " +
        "(SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id)) ELSE 0 END AS progress " +
        "FROM task_projects p WHERE p.workspaceId = ? ORDER BY p.sortOrder ASC, p.createdAt ASC",
        [workspaceId],
      );
    } else {
      return getAdapter().queryMany<TaskProjectWithStats>(
        "SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id) AS taskCount, " +
        "(SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id AND t.isCompleted = 1) AS completedCount, " +
        "CASE WHEN (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id) > 0 THEN " +
        "ROUND(100.0 * (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id AND t.isCompleted = 1) / " +
        "(SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id)) ELSE 0 END AS progress " +
        "FROM task_projects p WHERE p.userId = ? AND p.workspaceId IS NULL ORDER BY p.sortOrder ASC, p.createdAt ASC",
        [userId],
      );
    }
  },

  /** 获取项目详情（async） */
  async getByIdAsync(projectId: string): Promise<TaskProjectRecord | undefined> {
    return getAdapter().queryOne<TaskProjectRecord>(
      "SELECT * FROM task_projects WHERE id = ?",
      [projectId],
    );
  },

  /** 获取项目详情（含统计，async） */
  async getByIdWithStatsAsync(projectId: string): Promise<TaskProjectWithStats | undefined> {
    return getAdapter().queryOne<TaskProjectWithStats>(
      "SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id) AS taskCount, " +
      "(SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id AND t.isCompleted = 1) AS completedCount, " +
      "CASE WHEN (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id) > 0 THEN " +
      "ROUND(100.0 * (SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id AND t.isCompleted = 1) / " +
      "(SELECT COUNT(*) FROM tasks t WHERE t.projectId = p.id)) ELSE 0 END AS progress " +
      "FROM task_projects p WHERE p.id = ?",
      [projectId],
    );
  },

  /** 创建项目（async） */
  async createAsync(input: {
    id: string;
    userId: string;
    workspaceId: string | null;
    name: string;
    icon: string | null;
    color: string | null;
    sortOrder: number;
  }): Promise<void> {
    await getAdapter().execute(
      "INSERT INTO task_projects (id, userId, workspaceId, name, icon, color, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [input.id, input.userId, input.workspaceId, input.name, input.icon, input.color, input.sortOrder],
    );
  },

  /** 更新项目（async） */
  async updateAsync(projectId: string, input: {
    name: string;
    icon: string | null;
    color: string | null;
    sortOrder: number;
  }): Promise<void> {
    await getAdapter().execute(
      "UPDATE task_projects SET name = ?, icon = ?, color = ?, sortOrder = ?, updatedAt = datetime('now') WHERE id = ?",
      [input.name, input.icon, input.color, input.sortOrder, projectId],
    );
  },

  /** 删除项目（async，先解除任务关联再删除） */
  async deleteAsync(projectId: string): Promise<void> {
    await getAdapter().executeStatements([
      { sql: "UPDATE tasks SET projectId = NULL WHERE projectId = ?", params: [projectId] },
      { sql: "DELETE FROM task_projects WHERE id = ?", params: [projectId] },
    ]);
  },
};
