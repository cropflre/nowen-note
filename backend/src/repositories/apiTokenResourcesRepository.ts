import { getDatabaseAdapter } from "../db/runtime";

export type ApiTokenResourceMode = "unrestricted" | "restricted";
export type ApiTokenResourcePermission = "read" | "write";

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
}

function getAdapter() {
  return getDatabaseAdapter();
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

function resourceInsertStatement(resource: ApiTokenResourceInput) {
  return {
    sql: `INSERT INTO api_token_resources
            (id, "tokenId", "resourceType", "resourceId", permission, "includeDescendants")
          VALUES (?, ?, 'notebook', ?, ?, ${resource.includeDescendants ? "TRUE" : "FALSE"})`,
    params: [resource.id, "__TOKEN_ID__", resource.notebookId, resource.permission] as unknown[],
  };
}

function bindTokenId(
  statement: ReturnType<typeof resourceInsertStatement>,
  tokenId: string,
) {
  return {
    sql: statement.sql,
    params: statement.params.map((value) => value === "__TOKEN_ID__" ? tokenId : value),
  };
}

export const apiTokenResourcesRepository = {
  async listTokensByUserAsync(userId: string): Promise<ApiTokenWithResourceMode[]> {
    return getAdapter().queryMany<ApiTokenWithResourceMode>(
      `SELECT id, name, scopes, "resourceMode", "expiresAt", "lastUsedAt", "lastUsedIp", "createdAt", "revokedAt"
       FROM api_tokens
       WHERE "userId" = ?
       ORDER BY "revokedAt" IS NOT NULL, "createdAt" DESC`,
      [userId],
    );
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

  async listNotebookOptionsAsync(): Promise<ApiTokenNotebookOption[]> {
    return getAdapter().queryMany<ApiTokenNotebookOption>(
      `SELECT id, name, "parentId", "workspaceId", "userId"
       FROM notebooks
       WHERE "isDeleted" = 0
       ORDER BY "sortOrder" ASC, LOWER(name) ASC`,
    );
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
      ...input.resources.map((resource) =>
        bindTokenId(resourceInsertStatement(resource), input.id)
      ),
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
      ...input.resources.map((resource) =>
        bindTokenId(resourceInsertStatement(resource), input.tokenId)
      ),
    ];
    await getAdapter().executeStatements(statements);
  },
};
