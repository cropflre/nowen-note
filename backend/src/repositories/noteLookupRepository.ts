import { getDatabaseAdapter } from "../db/runtime";

export interface NoteWorkspaceLookup {
  workspaceId: string | null;
}

/**
 * Small read-only note lookup boundary used by routes that only need ownership
 * metadata. Keeping this query out of route handlers prevents new SQLite
 * coupling while the full notes repository is migrated in later batches.
 */
export const noteLookupRepository = {
  async getWorkspaceByIdAsync(noteId: string): Promise<NoteWorkspaceLookup | undefined> {
    return getDatabaseAdapter().queryOne<NoteWorkspaceLookup>(
      'SELECT "workspaceId" FROM notes WHERE id = ?',
      [noteId],
    );
  },
};
