/**
 * Task Dependencies Repository
 *
 * 职责：
 * - 封装 task_dependencies 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";

/** task_dependencies 记录 */
export interface TaskDependencyRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  predecessorTaskId: string;
  successorTaskId: string;
  type: string;
  createdAt: string;
}

export const taskDependenciesRepository = {
  /**
   * 获取任务的后续依赖。
   *
   * @param predecessorTaskId 前置任务 ID
   * @returns 后续任务 ID 列表
   */
  listSuccessors(predecessorTaskId: string): string[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT successorTaskId FROM task_dependencies WHERE predecessorTaskId = ?")
      .all(predecessorTaskId) as { successorTaskId: string }[];
    return rows.map((r) => r.successorTaskId);
  },

  /**
   * 获取任务的所有依赖关系（作为前置或后续）。
   *
   * @param taskId 任务 ID
   * @param userId 用户 ID
   * @param workspaceId 工作区 ID（null = 个人空间）
   * @returns 依赖关系列表
   */
  listByTask(taskId: string, userId: string, workspaceId: string | null): TaskDependencyRecord[] {
    const db = getDb();
    if (workspaceId) {
      return db
        .prepare("SELECT * FROM task_dependencies WHERE (predecessorTaskId = ? OR successorTaskId = ?) AND workspaceId = ?")
        .all(taskId, taskId, workspaceId) as TaskDependencyRecord[];
    } else {
      return db
        .prepare("SELECT * FROM task_dependencies WHERE (predecessorTaskId = ? OR successorTaskId = ?) AND userId = ? AND workspaceId IS NULL")
        .all(taskId, taskId, userId) as TaskDependencyRecord[];
    }
  },

  /**
   * 获取工作区内的所有依赖关系。
   *
   * @param userId 用户 ID
   * @param workspaceId 工作区 ID（null = 个人空间）
   * @returns 依赖关系列表
   */
  listByWorkspace(userId: string, workspaceId: string | null): TaskDependencyRecord[] {
    const db = getDb();
    if (workspaceId) {
      return db
        .prepare("SELECT * FROM task_dependencies WHERE workspaceId = ?")
        .all(workspaceId) as TaskDependencyRecord[];
    } else {
      return db
        .prepare("SELECT * FROM task_dependencies WHERE userId = ? AND workspaceId IS NULL")
        .all(userId) as TaskDependencyRecord[];
    }
  },

  /**
   * 检查依赖关系是否已存在。
   *
   * @param predecessorTaskId 前置任务 ID
   * @param successorTaskId 后续任务 ID
   * @param type 依赖类型
   * @returns 是否存在
   */
  exists(predecessorTaskId: string, successorTaskId: string, type: string): boolean {
    const db = getDb();
    const row = db
      .prepare("SELECT id FROM task_dependencies WHERE predecessorTaskId = ? AND successorTaskId = ? AND type = ?")
      .get(predecessorTaskId, successorTaskId, type);
    return !!row;
  },

  /**
   * 创建依赖关系。
   *
   * @param input 依赖关系数据
   */
  create(input: {
    id: string;
    userId: string;
    workspaceId: string | null;
    predecessorTaskId: string;
    successorTaskId: string;
    type: string;
  }): void {
    const db = getDb();
    db.prepare(
      "INSERT INTO task_dependencies (id, userId, workspaceId, predecessorTaskId, successorTaskId, type) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(input.id, input.userId, input.workspaceId, input.predecessorTaskId, input.successorTaskId, input.type);
  },

  /**
   * 获取依赖关系详情。
   *
   * @param dependencyId 依赖关系 ID
   * @returns 依赖关系记录，或 undefined
   */
  getById(dependencyId: string): TaskDependencyRecord | undefined {
    const db = getDb();
    return db
      .prepare("SELECT * FROM task_dependencies WHERE id = ?")
      .get(dependencyId) as TaskDependencyRecord | undefined;
  },

  /**
   * 删除依赖关系。
   *
   * @param dependencyId 依赖关系 ID
   */
  delete(dependencyId: string): void {
    const db = getDb();
    db.prepare("DELETE FROM task_dependencies WHERE id = ?").run(dependencyId);
  },

  /**
   * 删除涉及指定任务的所有依赖关系。
   *
   * @param taskIds 任务 ID 列表
   */
  deleteByTaskIds(taskIds: string[]): void {
    if (taskIds.length === 0) return;
    const db = getDb();
    const placeholders = taskIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM task_dependencies WHERE predecessorTaskId IN (${placeholders}) OR successorTaskId IN (${placeholders})`)
      .run(...taskIds, ...taskIds);
  },
};
