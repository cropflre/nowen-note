import type Database from "better-sqlite3";

export const knowledgeCapabilitiesRepository = {
  getWorkspaceOwnerId(db: Database.Database, workspaceId: string): string | null {
    return ((db.prepare("SELECT ownerId FROM workspaces WHERE id = ?").get(workspaceId) as
      | { ownerId: string }
      | undefined)?.ownerId) || null;
  },

  getWorkspaceRole(
    db: Database.Database,
    workspaceId: string,
    userId: string,
  ): { role: string } | undefined {
    return db.prepare(
      "SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?",
    ).get(workspaceId, userId) as { role: string } | undefined;
  },
};
