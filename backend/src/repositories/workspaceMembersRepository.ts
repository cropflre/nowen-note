/**
 * Workspace Members Repository
 *
 * 职责：
 * - 封装 workspace_members 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";

export const workspaceMembersRepository = {
  /**
   * 获取工作区成员数量。
   *
   * @param workspaceId 工作区 ID
   * @returns 成员数量
   */
  countByWorkspace(workspaceId: string): number {
    const db = getDb();
    const row = db.prepare("SELECT COUNT(*) as c FROM workspace_members WHERE workspaceId = ?").get(workspaceId) as { c: number };
    return row.c;
  },

  /**
   * 获取成员角色。
   *
   * @param workspaceId 工作区 ID
   * @param userId 用户 ID
   * @returns 成员角色，或 undefined
   */
  getRole(workspaceId: string, userId: string): { role: string } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
      .get(workspaceId, userId) as { role: string } | undefined;
  },

  /**
   * 创建成员。
   *
   * @param workspaceId 工作区 ID
   * @param userId 用户 ID
   * @param role 角色
   */
  create(workspaceId: string, userId: string, role: string): void {
    const db = getDb();
    db.prepare(
      "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)"
    ).run(workspaceId, userId, role);
  },

  /**
   * 更新成员角色。
   *
   * @param workspaceId 工作区 ID
   * @param userId 用户 ID
   * @param role 新角色
   */
  updateRole(workspaceId: string, userId: string, role: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE workspace_members SET role = ? WHERE workspaceId = ? AND userId = ?"
    ).run(role, workspaceId, userId);
  },

  /**
   * 删除成员。
   *
   * @param workspaceId 工作区 ID
   * @param userId 用户 ID
   */
  delete(workspaceId: string, userId: string): void {
    const db = getDb();
    db.prepare("DELETE FROM workspace_members WHERE workspaceId = ? AND userId = ?").run(workspaceId, userId);
  },
};
