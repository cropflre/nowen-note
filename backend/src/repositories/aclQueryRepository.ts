import { getDb } from "../db/schema";

export interface AclOwnedResourceRow {
  userId: string;
  workspaceId: string | null;
}

export interface AclSystemRoleRow {
  role?: string;
}

export interface AclWorkspaceFeaturesRow {
  enabledFeatures?: string;
}

/**
 * Synchronous SQLite compatibility boundary for ACL helpers.
 *
 * ACL functions are used by a large number of synchronous permission helpers.
 * Runtime Adapter/async dual-database support is completed centrally in #249.
 */
export const aclQueryRepository = {
  getNoteOwnerScope(noteId: string): AclOwnedResourceRow | undefined {
    return getDb()
      .prepare('SELECT "userId", "workspaceId" FROM notes WHERE id = ?')
      .get(noteId) as AclOwnedResourceRow | undefined;
  },

  getNotebookOwnerScope(notebookId: string): AclOwnedResourceRow | undefined {
    return getDb()
      .prepare('SELECT "userId", "workspaceId" FROM notebooks WHERE id = ?')
      .get(notebookId) as AclOwnedResourceRow | undefined;
  },

  getSystemRole(userId: string): AclSystemRoleRow | undefined {
    return getDb()
      .prepare('SELECT role FROM users WHERE id = ?')
      .get(userId) as AclSystemRoleRow | undefined;
  },

  getWorkspaceFeatures(workspaceId: string): AclWorkspaceFeaturesRow | undefined {
    return getDb()
      .prepare('SELECT "enabledFeatures" FROM workspaces WHERE id = ?')
      .get(workspaceId) as AclWorkspaceFeaturesRow | undefined;
  },
};
