import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";

export interface MindmapFolderCountRecord {
  folderId: string;
  count: number;
}

/** Cross-table mindmap folder operations used by route handlers. */
export const mindmapFolderOperationsRepository = {
  async listDeletedLegacyFolderIdsAsync(notebookIds: string[]): Promise<string[]> {
    if (notebookIds.length === 0) return [];
    const adapter = getDatabaseAdapter();
    const deleted: string[] = [];
    for (let offset = 0; offset < notebookIds.length; offset += 400) {
      const ids = notebookIds.slice(offset, offset + 400);
      const rows = await adapter.queryMany<{ id: string }>(
        'SELECT id FROM notebooks WHERE id IN (' + ids.map(() => '?').join(',') + ') AND "isDeleted" = ?',
        [...ids, getDatabaseDialect() === 'postgres' ? true : 1],
      );
      deleted.push(...rows.map(row => row.id));
    }
    return deleted;
  },

  async listCountsByFolderIdsAsync(folderIds: string[]): Promise<MindmapFolderCountRecord[]> {
    if (folderIds.length === 0) return [];
    const placeholders = folderIds.map(() => "?").join(",");
    const rows = await getDatabaseAdapter().queryMany<{
      folderId: string;
      count: number | string;
    }>(
      `SELECT "folderId", COUNT(*) AS count
       FROM mindmaps map
       WHERE "folderId" IN (${placeholders})
         AND NOT EXISTS (SELECT 1 FROM knowledge_tree_nodes tree
           WHERE tree."resourceType" = 'mindmap' AND tree."resourceId" = map.id AND tree."isDeleted" = ?)
       GROUP BY "folderId"`,
      [...folderIds, getDatabaseDialect() === 'postgres' ? true : 1],
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
