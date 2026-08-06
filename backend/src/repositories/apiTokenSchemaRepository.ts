/**
 * API Token SQLite schema compatibility boundary.
 *
 * The production schema/migration remains the source of truth. This helper preserves
 * the historical idempotent startup/test hook without exposing driver-level calls
 * from business-layer library modules.
 */

export interface ApiTokenSchemaDatabase {
  exec(sql: string): unknown;
  prepare?(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

function hasColumn(
  db: ApiTokenSchemaDatabase,
  table: string,
  column: string,
): boolean {
  if (!db.prepare) return false;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name?: string;
  }>;
  return rows.some((row) => row.name === column);
}

export const apiTokenSchemaRepository = {
  initialize(db: ApiTokenSchemaDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        name TEXT NOT NULL,
        tokenHash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL DEFAULT '[]',
        resourceMode TEXT NOT NULL DEFAULT 'unrestricted',
        expiresAt TEXT,
        lastUsedAt TEXT,
        lastUsedIp TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        revokedAt TEXT,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(userId, revokedAt);
      CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(tokenHash);

      CREATE TABLE IF NOT EXISTS api_token_usage (
        tokenId TEXT NOT NULL,
        day TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tokenId, day),
        FOREIGN KEY (tokenId) REFERENCES api_tokens(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_api_token_usage_day ON api_token_usage(day);
    `);

    if (!hasColumn(db, "api_tokens", "resourceMode")) {
      db.exec(
        "ALTER TABLE api_tokens ADD COLUMN resourceMode TEXT NOT NULL DEFAULT 'unrestricted'",
      );
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS api_token_resources (
        id TEXT PRIMARY KEY,
        tokenId TEXT NOT NULL,
        resourceType TEXT NOT NULL DEFAULT 'notebook',
        resourceId TEXT NOT NULL,
        permission TEXT NOT NULL DEFAULT 'read',
        includeDescendants INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tokenId, resourceType, resourceId),
        FOREIGN KEY (tokenId) REFERENCES api_tokens(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_api_token_resources_token
        ON api_token_resources(tokenId, resourceType);
      CREATE INDEX IF NOT EXISTS idx_api_token_resources_resource
        ON api_token_resources(resourceType, resourceId);
    `);
  },
};
