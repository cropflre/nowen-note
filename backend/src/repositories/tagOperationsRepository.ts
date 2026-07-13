import { getDatabaseAdapter } from "../db/runtime";

export interface NoteWorkspaceRecord {
  workspaceId: string | null;
}

/**
 * 标签路由需要的跨表操作。
 *
 * 这里集中处理 notes / note_tags / tags 的组合访问，避免 route handler
 * 直接依赖 SQLite，并为后续 PostgreSQL Repository 迁移保留统一边界。
 */
export const tagOperationsRepository = {
  async getNoteWorkspaceByIdAsync(noteId: string): Promise<NoteWorkspaceRecord | undefined> {
    return getDatabaseAdapter().queryOne<NoteWorkspaceRecord>(
      'SELECT "workspaceId" FROM notes WHERE id = ?',
      [noteId],
    );
  },

  async deleteTagWithLinksAsync(tagId: string): Promise<void> {
    await getDatabaseAdapter().executeStatements([
      {
        sql: 'DELETE FROM note_tags WHERE "tagId" = ?',
        params: [tagId],
      },
      {
        sql: "DELETE FROM tags WHERE id = ?",
        params: [tagId],
      },
    ]);
  },
};
