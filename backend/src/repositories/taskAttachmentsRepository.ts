/**
 * Task Attachments Repository
 *
 * 职责：
 * - 封装 task_attachments 表的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";

function getAdapter() {
  return new SqliteAdapter(getDb());
}

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

  /** 返回某个任务的全部附件，供任务详情附件区与完整备份使用。 */
  listByTaskId(taskId: string): TaskAttachmentRecord[] {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, taskId, userId, workspaceId, filename, mimeType, size, path, createdAt
         FROM task_attachments
         WHERE taskId = ?
         ORDER BY createdAt ASC, id ASC`,
      )
      .all(taskId) as TaskAttachmentRecord[];
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

  /**
   * 获取所有附件的路径和大小（用于备份/导出）。
   *
   * @returns 附件列表
   */
  listAllForBackup(): Array<{ path: string; size: number }> {
    const db = getDb();
    return db.prepare("SELECT path, size FROM task_attachments").all() as Array<{ path: string; size: number }>;
  },

  /**
   * 获取所有附件的路径（用于清理）。
   *
   * @returns 附件路径列表
   */
  listAllPaths(): string[] {
    const db = getDb();
    const rows = db.prepare("SELECT path FROM task_attachments").all() as { path: string }[];
    return rows.map((r) => r.path);
  },

  async getByIdAsync(attachmentId: string): Promise<{ id: string; mimeType: string; path: string; filename: string } | undefined> {
    return getAdapter().queryOne<{ id: string; mimeType: string; path: string; filename: string }>(
      "SELECT id, mimeType, path, filename FROM task_attachments WHERE id = ?",
      [attachmentId],
    );
  },

  async listByTaskIdAsync(taskId: string): Promise<TaskAttachmentRecord[]> {
    return getAdapter().queryMany<TaskAttachmentRecord>(
      `SELECT id, taskId, userId, workspaceId, filename, mimeType, size, path, createdAt
       FROM task_attachments
       WHERE taskId = ?
       ORDER BY createdAt ASC, id ASC`,
      [taskId],
    );
  },

  async getByIdForPermissionAsync(attachmentId: string): Promise<{ id: string; userId: string } | undefined> {
    return getAdapter().queryOne<{ id: string; userId: string }>(
      "SELECT id, userId FROM task_attachments WHERE id = ?",
      [attachmentId],
    );
  },

  async createAsync(input: {
    id: string;
    taskId: string | null;
    userId: string;
    workspaceId: string | null;
    filename: string;
    mimeType: string;
    size: number;
    path: string;
  }): Promise<void> {
    await getAdapter().execute(
      `INSERT INTO task_attachments (id, taskId, userId, workspaceId, filename, mimeType, size, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.id, input.taskId, input.userId, input.workspaceId, input.filename, input.mimeType, input.size, input.path],
    );
  },

  async updateTaskAssociationAsync(attachmentId: string, taskId: string, workspaceId: string | null): Promise<void> {
    await getAdapter().execute(
      "UPDATE task_attachments SET taskId = ?, workspaceId = ? WHERE id = ?",
      [taskId, workspaceId, attachmentId],
    );
  },

  async getByIdForDeleteAsync(attachmentId: string): Promise<{ id: string; userId: string; taskId: string | null; workspaceId: string | null; path: string } | undefined> {
    return getAdapter().queryOne<any>(
      "SELECT id, userId, taskId, workspaceId, path FROM task_attachments WHERE id = ?",
      [attachmentId],
    );
  },

  async deleteAsync(attachmentId: string): Promise<void> {
    await getAdapter().execute("DELETE FROM task_attachments WHERE id = ?", [attachmentId]);
  },

  async listAllForBackupAsync(): Promise<Array<{ path: string; size: number }>> {
    return getAdapter().queryMany<{ path: string; size: number }>("SELECT path, size FROM task_attachments");
  },

  async listAllPathsAsync(): Promise<string[]> {
    const rows = await getAdapter().queryMany<{ path: string }>("SELECT path FROM task_attachments");
    return rows.map((r) => r.path);
  },
};
