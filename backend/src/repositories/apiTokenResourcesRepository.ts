import { getDatabaseAdapter } from "../db/runtime";

export type ApiTokenResourceMode = "unrestricted" | "restricted";
export type ApiTokenResourcePermission = "read" | "write";
export type ApiTokenEffectivePermission = "read" | "comment" | "write" | "manage";

export interface ApiTokenResourceInput {
  id: string;
  notebookId: string;
  permission: ApiTokenResourcePermission;
  includeDescendants: boolean;
}

export interface ApiTokenResourceRecord {
  notebookId: string;
  permission: ApiTokenResourcePermission;
  includeDescendants: boolean;
  notebookName: string | null;
  parentId: string | null;
}

export interface ApiTokenWithResourceMode {
  id: string;
  name: string;
  scopes: string;
  resourceMode: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface ApiTokenNotebookOption {
  id: string;
  name: string;
  parentId: string | null;
  workspaceId: string | null;
  userId: string;
  permission: ApiTokenEffectivePermission;
  canWrite: boolean;
}

interface NotebookAccessRow {
  id: string;
  name: string;
  parentId: string | null;
  workspaceId: string | null;
  userId: string;
  notebookOwnerId: string;
  workspaceOwnerId: string | null;
  notebookRole: string | null;
  workspaceRole: string | null;
}

function getAdapter() {
  return getDatabaseAdapter();
}

function asIsoString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeToken(row: any): ApiTokenWithResourceMode {
  return {
    id: String(row.id),
    name: String(row.name),
    scopes: String(row.scopes ?? "[]"),
    resourceMode: row.resourceMode === "restricted" ? "restricted" : "unrestricted",
    expiresAt: asIsoString(row.expiresAt),
    lastUsedAt: asIsoString(row.lastUsedAt),
    lastUsedIp: row.lastUsedIp ?? null,
    createdAt: asIsoString(row.createdAt) ?? "",
    revokedAt: asIsoString(row.revokedAt),
  };
}

function normalizeResource(row: any): ApiTokenResourceRecord {
  return {
    notebookId: String(row.notebookId),
    permission: row.permission === "write" ? "write" : "read",
    includeDescendants: row.includeDescendants === true || row.includeDescendants === 1,
    notebookName: row.notebookName ?? null,
    parentId: row.parentId ?? null,
  };
}

function roleToPermission(role: string | null | undefined): ApiTokenEffectivePermission | null {
  switch (role) {
    case "owner":
    case "admin":
    case "manage":
      return "manage";
    case "editor":
    case "write":
      return "write";
    case "commenter":
    case "comment":
      return "comment";
    case "viewer":
    case "read":
      return "read";
    default:
      return null;
  }
}

function resolveAccessRow(row: NotebookAccessRow, userId: string): ApiTokenEffectivePermission | null {
  if (row.notebookOwnerId === userId) return "manage";

  // A direct notebook rule takes precedence over workspace membership. `none` is an
  // explicit deny and must prevent the workspace role from granting access again.
  if (row.notebookRole === "none") return null;
  const notebookPermission = roleToPermission(row.notebookRole);
  if (notebookPermission) return notebookPermission;

  if (!row.workspaceId) return null;
  if (row.workspaceOwnerId === userId) return "manage";
  return roleToPermission(row.workspaceRole);
}

function canWrite(permission: ApiTokenEffectivePermission): boolean {
  return permission === "write" || permission === "manage";
}

function resourceInsertStatement(tokenId: string, resource: ApiTokenResourceInput) {
  return {
    sql: `INSERT INTO api_token_resources
            (id, "tokenId", "resourceType", "resourceId", permission, "includeDescendants")
          VALUES (?, ?, 'notebook', ?, ?, ${resource.includeDescendants ? "TRUE" : "FALSE"})`,
    params: [resource.id, tokenId, resource.notebookId, resource.permission],
  };
}

export const apiTokenResourcesRepository = {
  async listTokensByUserAsync(userId: string): Promise<ApiTokenWithResourceMode[]> {
    const rows = await getAdapter().queryMany<any>(
      `SELECT id, name, scopes, "resourceMode", "expiresAt", "lastUsedAt", "lastUsedIp", "createdAt", "revokedAt"
       FROM api_tokens
       WHERE "userId" = ?
       ORDER BY "revokedAt" IS NOT NULL, "createdAt" DESC`,
      [userId],
    );
    return rows.map(normalizeToken);
  },

  async listResourcesByTokenAsync(tokenId: string): Promise<ApiTokenResourceRecord[]> {
    const rows = await getAdapter().queryMany<any>(
      `SELECT r."resourceId" AS "notebookId", r.permission, r."includeDescendants",
              n.name AS "notebookName", n."parentId"
       FROM api_token_resources r
       LEFT JOIN notebooks n ON n.id = r."resourceId"
       WHERE r."tokenId" = ? AND r."resourceType" = 'notebook'
       ORDER BY LOWER(COALESCE(n.name, '')) ASC, r."resourceId" ASC`,
      [tokenId],
    );
    return rows.map(normalizeResource);
  },

  async listAuthorizedNotebookOptionsAsync(userId: string): Promise<ApiTokenNotebookOption[]> {
    const rows = await getAdapter().queryMany<NotebookAccessRow>(
      `SELECT n.id, n.name, n."parentId", n."workspaceId", n."userId",
              n."userId" AS "notebookOwnerId", w."ownerId" AS "workspaceOwnerId",
              nm.role AS "notebookRole", wm.role AS "workspaceRole"
       FROM notebooks n
       LEFT JOIN workspaces w ON w.id = n."workspaceId"
       LEFT JOIN notebook_members nm
         ON nm."notebookId" = n.id AND nm."userId" = ? AND nm.status != 'removed'
       LEFT JOIN workspace_members wm
         ON wm."workspaceId" = n."workspaceId" AND wm."userId" = ?
       WHERE n."isDeleted" = 0
       ORDER BY n."sortOrder" ASC, LOWER(n.name) ASC`,
      [userId, userId],
    );

    return rows.flatMap((row) => {
      const permission = resolveAccessRow(row, userId);
      if (!permission) return [];
      return [{
        id: row.id,
        name: row.name,
        parentId: row.parentId,
        workspaceId: row.workspaceId,
        userId: row.userId,
        permission,
        canWrite: canWrite(permission),
      }];
    });
  },

  async createTokenAsync(input: {
    id: string;
    userId: string;
    name: string;
    tokenHash: string;
    scopes: string[];
    expiresAt: string | null;
    resourceMode: ApiTokenResourceMode;
    resources: ApiTokenResourceInput[];
  }): Promise<void> {
    const statements: Array<{ sql: string; params?: unknown[] }> = [
      {
        sql: `INSERT INTO api_tokens
                (id, "userId", name, "tokenHash", scopes, "expiresAt", "resourceMode")
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          input.id,
          input.userId,
          input.name,
          input.tokenHash,
          JSON.stringify(input.scopes),
          input.expiresAt,
          input.resourceMode,
        ],
      },
      ...input.resources.map((resource) => resourceInsertStatement(input.id, resource)),
    ];
    await getAdapter().executeStatements(statements);
  },

  async updateTokenResourcesAsync(input: {
    tokenId: string;
    userId: string;
    resourceMode: ApiTokenResourceMode;
    resources: ApiTokenResourceInput[];
  }): Promise<void> {
    const statements: Array<{ sql: string; params?: unknown[] }> = [
      {
        sql: `UPDATE api_tokens
              SET "resourceMode" = ?
              WHERE id = ? AND "userId" = ?`,
        params: [input.resourceMode, input.tokenId, input.userId],
      },
      {
        sql: `DELETE FROM api_token_resources WHERE "tokenId" = ?`,
        params: [input.tokenId],
      },
      ...input.resources.map((resource) => resourceInsertStatement(input.tokenId, resource)),
    ];
    await getAdapter().executeStatements(statements);
  },
};
