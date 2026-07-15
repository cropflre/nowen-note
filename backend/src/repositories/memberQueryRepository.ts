import { getDb } from "../db/schema";

export interface MemberRoleRecord {
  role: string;
}

/** SQLite compatibility boundary for synchronous cross-table member queries. */
export const memberQueryRepository = {
  getNotebookMemberRole(
    notebookId: string,
    userId: string,
  ): MemberRoleRecord | undefined {
    return getDb()
      .prepare(
        `SELECT role
           FROM notebook_members
          WHERE notebookId = ? AND userId = ? AND status = 'active'`,
      )
      .get(notebookId, userId) as MemberRoleRecord | undefined;
  },

  getNoteNotebookMemberRole(
    noteId: string,
    userId: string,
  ): MemberRoleRecord | undefined {
    return getDb()
      .prepare(
        `SELECT nm.role
           FROM notes n
           JOIN notebook_members nm ON nm.notebookId = n.notebookId
          WHERE n.id = ? AND nm.userId = ? AND nm.status = 'active'`,
      )
      .get(noteId, userId) as MemberRoleRecord | undefined;
  },

  listSharedNotebookIds(userId: string): string[] {
    const rows = getDb()
      .prepare(
        `SELECT nm.notebookId
           FROM notebook_members nm
           JOIN notebooks nb ON nb.id = nm.notebookId
          WHERE nm.userId = ?
            AND nm.status = 'active'
            AND nb.userId <> ?
            AND nb.isDeleted = 0
          ORDER BY nb.updatedAt DESC, nb.id ASC`,
      )
      .all(userId, userId) as { notebookId: string }[];
    return rows.map((row) => row.notebookId);
  },
};
