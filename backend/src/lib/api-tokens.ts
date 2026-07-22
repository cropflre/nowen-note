/**
 * 长期 API Token（Personal Access Token）
 * ---------------------------------------------------------------------------
 * 支持 scopes、过期/吊销、使用统计，以及可选的笔记本资源级授权。
 *
 * 同步鉴权入口仍服务于现有 SQLite 默认运行时；所有数据库访问都通过
 * Repository 边界执行，业务库不直接依赖具体数据库驱动。
 */

import crypto from "crypto";
import {
  apiTokenSchemaRepository,
  apiTokensRepository,
  type ApiTokenSchemaDatabase,
} from "../repositories";

export const API_TOKEN_PREFIX = "nkn_";
const TOKEN_RAW_BYTES = 32;

export const API_TOKEN_SCOPES = [
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

export function isValidScope(scope: string): scope is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(scope);
}

/** 建表与历史库增量升级（幂等）；驱动级 exec 由 Repository 边界承接。 */
export function initApiTokensTable(db: ApiTokenSchemaDatabase): void {
  apiTokenSchemaRepository.initialize(db);
}

/** 记录一次 token 使用。统计失败不能阻塞鉴权。 */
export function recordTokenUsage(_db: unknown, tokenId: string): void {
  try {
    apiTokensRepository.recordUsage(tokenId, new Date().toISOString().slice(0, 10));
  } catch {
    // 非关键路径。
  }
}

/** 清理超过 retentionDays 天的 usage 数据。 */
export function pruneTokenUsage(_db: unknown, retentionDays = 90): void {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000)
      .toISOString()
      .slice(0, 10);
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

/**
 * 用明文 token 查询并校验。成功后节流更新 lastUsedAt 并记录按日 usage。
 * resourceMode 与 scopes 在同一 Repository 查询中返回，避免额外 SQLite 直连。
 */
export function resolveApiToken(
  db: unknown,
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

  const shouldTouch =
    !row.lastUsedAt || Date.now() - Date.parse(row.lastUsedAt) > 60_000;
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

  const resourceMode: ApiTokenResourceMode =
    row.resourceMode === "restricted" ? "restricted" : "unrestricted";

  return {
    tokenId: row.id,
    userId: row.userId,
    scopes,
    resourceMode,
  };
}

// SEC-PAT-01: 空 scopes 默认拒绝，可通过兼容开关恢复历史行为。
const legacyEmptyScopeFullAccess =
  process.env.LEGACY_EMPTY_SCOPE_FULL_ACCESS === "true";

export function hasScope(token: ResolvedApiToken, required: ApiTokenScope): boolean {
  if (token.scopes.length === 0) return legacyEmptyScopeFullAccess;
  return token.scopes.includes(required);
}

export function hasAnyScope(
  token: ResolvedApiToken,
  required: ApiTokenScope[],
): boolean {
  return required.some((scope) => hasScope(token, scope));
}
