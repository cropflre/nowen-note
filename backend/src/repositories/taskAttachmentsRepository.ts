/**
 * Task Attachments Repository
 *
 * 职责：
 * - 封装 task_attachments 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";

/** task_attachments 记录 */
export interface TaskAttachmentRecord {
  id: string;
  taskId: string | null;
  userId: string;
  workspaceId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
}

export const taskAttachmentsRepository = {
  /**
   * 获取附件详情（用于下载）。
   *
   * @param attachmentId 附件 ID
   * @returns 附件记录，或 undefined
   */
  getById(attachmentId: string): { id: string; mimeType: string; path: string; filename: string } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT id, mimeType, path, filename FROM task_attachments WHERE id = ?")
      .get(attachmentId) as { id: string; mimeType: string; path: string; filename: string } | undefined;
  },

  /**
   * 获取附件详情（用于权限校验）。
   *
   * @param attachmentId 附件 ID
   * @returns 附件记录，或 undefined
   */
  getByIdForPermission(attachmentId: string): { id: string; userId: string } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT id, userId FROM task_attachments WHERE id = ?")
      .get(attachmentId) as { id: string; userId: string } | undefined;
  },

  /**
   * 创建附件。
   *
   * @param input 附件数据
   */
  create(input: {
    id: string;
    taskId: string | null;
    userId: string;
    workspaceId: string | null;
    filename: string;
    mimeType: string;
    size: number;
    path: string;
  }): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO task_attachments (id, taskId, userId, workspaceId, filename, mimeType, size, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(input.id, input.taskId, input.userId, input.workspaceId, input.filename, input.mimeType, input.size, input.path);
  },

  /**
   * 更新附件的任务关联。
   *
   * @param attachmentId 附件 ID
   * @param taskId 任务 ID
   * @param workspaceId 工作区 ID
   */
  updateTaskAssociation(attachmentId: string, taskId: string, workspaceId: string | null): void {
    const db = getDb();
    db.prepare("UPDATE task_attachments SET taskId = ?, workspaceId = ? WHERE id = ?")
      .run(taskId, workspaceId, attachmentId);
  },

  /**
   * 获取附件详情（用于删除）。
   *
   * @param attachmentId 附件 ID
   * @returns 附件记录，或 undefined
   */
  getByIdForDelete(attachmentId: string): { id: string; userId: string; taskId: string | null; workspaceId: string | null; path: string } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT id, userId, taskId, workspaceId, path FROM task_attachments WHERE id = ?")
      .get(attachmentId) as any;
  },

  /**
   * 删除附件。
   *
   * @param attachmentId 附件 ID
   */
  delete(attachmentId: string): void {
    const db = getDb();
    db.prepare("DELETE FROM task_attachments WHERE id = ?").run(attachmentId);
  },
};
