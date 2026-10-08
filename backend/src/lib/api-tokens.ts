/**
 * 长期 API Token（Personal Access Token）
 * ---------------------------------------------------------------------------
 * 支持粗粒度 scopes、过期/吊销、使用统计，以及可选的笔记本资源级授权。
 */
import crypto from "crypto";
import type { Database as BetterSqliteDB } from "better-sqlite3";
import { apiTokensRepository } from "../repositories";

export const API_TOKEN_PREFIX = "nkn_";
const TOKEN_RAW_BYTES = 32;

export const API_TOKEN_SCOPES = [
  "tasks:read",
  "tasks:write",
  "notes:read",
  "notes:write",
  "notebooks:read",
  "notebooks:write",
  "attachments:write",
  "tags:read",
  "tags:write",
  "export:import",
] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];
export type ApiTokenResourceMode = "unrestricted" | "restricted";

export function isValidScope(s: string): s is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(s);
}

/** 建表与历史库增量升级（幂等）。 */
export function initApiTokensTable(db: BetterSqliteDB) {
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

    CREATE TABLE IF NOT EXISTS api_token_resources (
      id TEXT PRIMARY KEY,
      tokenId TEXT NOT NULL,
      resourceType TEXT NOT NULL DEFAULT 'notebook',
      resourceId TEXT NOT NULL,
      permission TEXT NOT NULL DEFAULT 'read',
      includeDescendants INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tokenId) REFERENCES api_tokens(id) ON DELETE CASCADE,
      UNIQUE(tokenId, resourceType, resourceId),
      CHECK(resourceType IN ('notebook')),
      CHECK(permission IN ('read', 'write'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_token_resources_token
      ON api_token_resources(tokenId, resourceType);
    CREATE INDEX IF NOT EXISTS idx_api_token_resources_resource
      ON api_token_resources(resourceType, resourceId);
  `);

  // 老版本 api_tokens 不包含 resourceMode；PRAGMA 检查后再 ALTER，避免依赖异常文本。
  const columns = db.prepare("PRAGMA table_info(api_tokens)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "resourceMode")) {
    db.exec("ALTER TABLE api_tokens ADD COLUMN resourceMode TEXT NOT NULL DEFAULT 'unrestricted'");
  }
}

export function recordTokenUsage(_db: BetterSqliteDB, tokenId: string): void {
  try {
    apiTokensRepository.recordUsage(tokenId, new Date().toISOString().slice(0, 10));
  } catch {
    // 统计失败不能阻塞鉴权。
  }
}

export function pruneTokenUsage(_db: BetterSqliteDB, retentionDays = 90): void {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString().slice(0, 10);
    apiTokensRepository.pruneUsageBefore(cutoff);
  } catch {
    // 清理失败不阻塞启动。
  }
}

export function generateApiTokenRaw(): string {
  return API_TOKEN_PREFIX + crypto.randomBytes(TOKEN_RAW_BYTES).toString("base64url");
}

export function hashApiToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function looksLikeApiToken(bearer: string): boolean {
  return bearer.startsWith(API_TOKEN_PREFIX);
}

export interface ResolvedApiToken {
  tokenId: string;
  userId: string;
  scopes: ApiTokenScope[];
  resourceMode: ApiTokenResourceMode;
}

export function resolveApiToken(
  db: BetterSqliteDB,
  raw: string,
  ip?: string,
): ResolvedApiToken | null {
  if (!looksLikeApiToken(raw)) return null;
  const row = apiTokensRepository.findByTokenHash(hashApiToken(raw));
  if (!row || row.revokedAt) return null;
  if (row.expiresAt) {
    const expiresAt = Date.parse(row.expiresAt);
    if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) return null;
  }

  const shouldTouch = !row.lastUsedAt || Date.now() - Date.parse(row.lastUsedAt) > 60_000;
  if (shouldTouch) {
    try {
      apiTokensRepository.updateLastUsed(row.id, ip || "");
    } catch {
      // 非关键路径。
    }
  }
  recordTokenUsage(db, row.id);

  let scopes: ApiTokenScope[] = [];
  try {
    const parsed = JSON.parse(row.scopes) as string[];
    scopes = parsed.filter(isValidScope);
  } catch {
    scopes = [];
  }

  const modeRow = db.prepare("SELECT resourceMode FROM api_tokens WHERE id = ?").get(row.id) as
    | { resourceMode?: string }
    | undefined;
  const resourceMode: ApiTokenResourceMode = modeRow?.resourceMode === "restricted"
    ? "restricted"
    : "unrestricted";

  return { tokenId: row.id, userId: row.userId, scopes, resourceMode };
}

const legacyEmptyScopeFullAccess = process.env.LEGACY_EMPTY_SCOPE_FULL_ACCESS === "true";

export function hasScope(token: ResolvedApiToken, required: ApiTokenScope): boolean {
  if (token.scopes.length === 0) return legacyEmptyScopeFullAccess;
  return token.scopes.includes(required);
}

export function hasAnyScope(token: ResolvedApiToken, required: ApiTokenScope[]): boolean {
  return required.some((scope) => hasScope(token, scope));
}
