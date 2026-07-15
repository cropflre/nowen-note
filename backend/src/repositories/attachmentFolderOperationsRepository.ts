import { getDatabaseAdapter } from "../db/runtime";

export interface AttachmentFolderCountRecord {
  folderId: string;
  count: number;
}

/**
 * attachment_folders 与 attachments 的跨表操作。
 *
 * 文件夹路由不再直接执行统计或解绑 SQL；删除时解绑附件与删除文件夹
 * 在同一数据库事务中完成。
 */
export const attachmentFolderOperationsRepository = {
  async listCountsByUserAsync(userId: string): Promise<AttachmentFolderCountRecord[]> {
    const rows = await getDatabaseAdapter().queryMany<{
      folderId: string;
      count: number | string;
    }>(
      `SELECT "folderId", COUNT(*) AS count
       FROM attachments
       WHERE "userId" = ? AND "folderId" IS NOT NULL
       GROUP BY "folderId"`,
      [userId],
    );

    return rows.map((row) => ({
      folderId: row.folderId,
      count: Number(row.count) || 0,
    }));
  },

  async deleteFolderAndUnassignAsync(folderId: string, userId: string): Promise<void> {
    await getDatabaseAdapter().executeStatements([
      {
        sql: 'UPDATE attachments SET "folderId" = NULL WHERE "folderId" = ? AND "userId" = ?',
        params: [folderId, userId],
      },
      {
        sql: 'DELETE FROM attachment_folders WHERE id = ? AND "userId" = ?',
        params: [folderId, userId],
      },
    ]);
  },
};
