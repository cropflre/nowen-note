import { getDatabaseAdapter } from "../db/runtime";

export interface MindmapFolderCountRecord {
  folderId: string;
  count: number;
}

/** Cross-table mindmap folder operations used by route handlers. */
export const mindmapFolderOperationsRepository = {
  async listCountsByFolderIdsAsync(folderIds: string[]): Promise<MindmapFolderCountRecord[]> {
    if (folderIds.length === 0) return [];
    const placeholders = folderIds.map(() => "?").join(",");
    const rows = await getDatabaseAdapter().queryMany<{
      folderId: string;
      count: number | string;
    }>(
      `SELECT "folderId", COUNT(*) AS count
       FROM mindmaps
       WHERE "folderId" IN (${placeholders})
       GROUP BY "folderId"`,
      folderIds,
    );

    return rows.map((row) => ({
      folderId: row.folderId,
      count: Number(row.count) || 0,
    }));
  },

  async deleteFolderAndUnassignAsync(folderId: string): Promise<void> {
    const now = new Date().toISOString();
    await getDatabaseAdapter().executeStatements([
      {
        sql: 'UPDATE mindmaps SET "folderId" = NULL, "updatedAt" = ? WHERE "folderId" = ?',
        params: [now, folderId],
      },
      {
        sql: 'UPDATE mindmap_folders SET "parentId" = NULL, "updatedAt" = ? WHERE "parentId" = ?',
        params: [now, folderId],
      },
      {
        sql: "DELETE FROM mindmap_folders WHERE id = ?",
        params: [folderId],
      },
    ]);
  },
};
