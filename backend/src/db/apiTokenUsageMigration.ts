import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const API_TOKEN_USAGE_SCHEMA_VERSION = 86;

export function ensureApiTokenUsageSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL DEFAULT '[]',
      expiresAt TEXT,
      lastUsedAt TEXT,
      lastUsedIp TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      revokedAt TEXT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS api_token_usage (
      tokenId TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tokenId, day),
      FOREIGN KEY (tokenId) REFERENCES api_tokens(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_api_token_usage_day ON api_token_usage(day);
  `);
}

export const apiTokenUsageMigration: Migration = {
  version: API_TOKEN_USAGE_SCHEMA_VERSION,
  name: "api-token-usage-schema",
  up: ensureApiTokenUsageSchema,
};
