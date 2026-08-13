import { getDb } from "../db/schema";

export interface RealtimeAuthUserRecord {
  id: string;
  username: string;
  isDisabled: number;
  tokenVersion: number;
}

interface WorkspaceMemberUserRow {
  userId: string;
}

/** SQLite compatibility boundary for WebSocket authentication and broadcast recipients. */
export const realtimeAuthRepository = {
  findById(userId: string): RealtimeAuthUserRecord | undefined {
    return getDb()
      .prepare(
        'SELECT id, username, "isDisabled", "tokenVersion" FROM users WHERE id = ?',
      )
      .get(userId) as RealtimeAuthUserRecord | undefined;
  },

  listWorkspaceMemberUserIds(workspaceId: string): string[] {
    const rows = getDb()
      .prepare('SELECT "userId" AS "userId" FROM workspace_members WHERE "workspaceId" = ?')
      .all(workspaceId) as WorkspaceMemberUserRow[];
    return rows.map((row) => row.userId);
  },
};
