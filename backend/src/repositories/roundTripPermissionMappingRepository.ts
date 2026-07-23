import { getDatabaseAdapter } from "../db/runtime";

export interface RoundTripWorkspaceAccessRow {
  id: string;
  name: string;
  ownerId: string;
  actorSystemRole: string | null;
  actorWorkspaceRole: string | null;
}

export interface RoundTripPermissionMemberRow {
  sourceUserId: string;
  role: string;
  username: string;
  email: string | null;
  displayName: string | null;
}

export interface RoundTripPermissionTargetUserRow {
  id: string;
  username: string;
  email: string | null;
}

function getAdapter() {
  return getDatabaseAdapter();
}

export const roundTripPermissionMappingRepository = {
  async getWorkspaceAccess(
    actorUserId: string,
    workspaceId: string,
  ): Promise<RoundTripWorkspaceAccessRow | undefined> {
    return getAdapter().queryOne<RoundTripWorkspaceAccessRow>(
      `SELECT w.id, w.name, w."ownerId",
              actor.role AS "actorSystemRole",
              membership.role AS "actorWorkspaceRole"
         FROM workspaces w
         LEFT JOIN users actor ON actor.id = ?
         LEFT JOIN workspace_members membership
           ON membership."workspaceId" = w.id
          AND membership."userId" = ?
        WHERE w.id = ?`,
      [actorUserId, actorUserId, workspaceId],
    );
  },

  async listWorkspaceMembers(
    workspaceId: string,
  ): Promise<RoundTripPermissionMemberRow[]> {
    return getAdapter().queryMany<RoundTripPermissionMemberRow>(
      `SELECT m."userId" AS "sourceUserId", m.role,
              u.username, u.email, u."displayName"
         FROM workspace_members m
         JOIN users u ON u.id = m."userId"
        WHERE m."workspaceId" = ?
        ORDER BY CASE m.role
                   WHEN 'owner' THEN 0
                   WHEN 'admin' THEN 1
                   WHEN 'editor' THEN 2
                   ELSE 3
                 END,
                 lower(u.username), u.id`,
      [workspaceId],
    );
  },

  async listTargetUsers(): Promise<RoundTripPermissionTargetUserRow[]> {
    return getAdapter().queryMany<RoundTripPermissionTargetUserRow>(
      "SELECT id, username, email FROM users ORDER BY id",
    );
  },

  async listExistingUserIds(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const placeholders = userIds.map(() => "?").join(", ");
    const rows = await getAdapter().queryMany<{ id: string }>(
      `SELECT id FROM users WHERE id IN (${placeholders})`,
      userIds,
    );
    return new Set(rows.map((row) => row.id));
  },

  async upsertWorkspaceMembers(
    workspaceId: string,
    mappings: Array<{ targetUserId: string; role: string }>,
  ): Promise<number> {
    if (!mappings.length) return 0;
    const result = await getAdapter().executeStatements(
      mappings.map((mapping) => ({
        sql: `INSERT INTO workspace_members ("workspaceId", "userId", role)
              VALUES (?, ?, ?)
              ON CONFLICT("workspaceId", "userId")
              DO UPDATE SET role = excluded.role`,
        params: [workspaceId, mapping.targetUserId, mapping.role],
      })),
    );
    return result.changes;
  },
};
