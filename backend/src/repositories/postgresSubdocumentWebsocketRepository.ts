import type { DatabaseAdapter } from "../db/adapters/types";

export interface PostgresSubdocumentWebsocketUserRow {
  id: string;
  username: string;
  role: string;
  tokenVersion: number;
  isDisabled: boolean | number;
}

export interface PostgresSubdocumentWebsocketSessionRow {
  revokedAt: string | Date | null;
  expiresAt: string | Date | null;
}

export interface PostgresSubdocumentNoteSnapshotRow {
  workspaceId: string | null;
  notebookId: string;
  title: string;
  updatedAt: string | Date;
}

export interface PostgresSubdocumentWebsocketRepository {
  findUser(userId: string): Promise<PostgresSubdocumentWebsocketUserRow | undefined>;
  findSession(
    sessionId: string,
    userId: string,
  ): Promise<PostgresSubdocumentWebsocketSessionRow | undefined>;
  findNoteSnapshot(noteId: string): Promise<PostgresSubdocumentNoteSnapshotRow | undefined>;
}

export function createPostgresSubdocumentWebsocketRepository(
  adapter: DatabaseAdapter,
): PostgresSubdocumentWebsocketRepository {
  return {
    findUser(userId) {
      return adapter.queryOne<PostgresSubdocumentWebsocketUserRow>(
        `SELECT id, username, role, "tokenVersion" AS "tokenVersion", "isDisabled" AS "isDisabled"
           FROM users WHERE id = ?`,
        [userId],
      );
    },

    findSession(sessionId, userId) {
      return adapter.queryOne<PostgresSubdocumentWebsocketSessionRow>(
        `SELECT "revokedAt" AS "revokedAt", "expiresAt" AS "expiresAt"
           FROM user_sessions WHERE id = ? AND "userId" = ?`,
        [sessionId, userId],
      );
    },

    findNoteSnapshot(noteId) {
      return adapter.queryOne<PostgresSubdocumentNoteSnapshotRow>(
        `SELECT "workspaceId" AS "workspaceId", "notebookId" AS "notebookId", title,
                "updatedAt" AS "updatedAt"
           FROM notes WHERE id = ?`,
        [noteId],
      );
    },
  };
}

export default createPostgresSubdocumentWebsocketRepository;
