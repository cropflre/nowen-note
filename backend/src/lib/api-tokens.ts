/**
 * 长期 API Token（Personal Access Token）
 * ---------------------------------------------------------------------------
 * 背景：
 *   登录用的 JWT 有 30 天过期时间，而浏览器剪藏插件、CLI、自动化脚本等
 *   场景需要一个"长期有效、可随时吊销"的凭证。本模块提供：
 *     - 生成不可逆的 token（前缀 `nkn_`，便于日志里一眼识别）
 *     - 存 hash 而不是明文（像 GitHub PAT 那样，明文只返回一次）
 *     - 支持 scopes（粗粒度能力声明，如 "notes:write" / "attachments:write"）
 *     - 支持 expiresAt（可选，NULL 表示永不过期）
 *     - 支持 revoke（DELETE 路由 + 软删除）
 *     - 命中后同步 lastUsedAt，方便用户审计
 *
 * 鉴权链路：
 *   JWT 中间件会先识别 Authorization 头中的前缀：
 *     - "Bearer <jwt>"     → 走原有登录 token 路径
 *     - "Bearer nkn_xxx"   → 走本模块 resolveApiToken
 *   同等价：鉴权成功后把 userId 写入 X-User-Id，下游路由无感知差异。
 *
 * 安全：
 *   - token 使用 32 字节 crypto.randomBytes，base64url 编码后 ~43 字符
 *   - 仅存 SHA-256 hash，server 端泄露 DB 也拿不到原文
 *   - 吊销走 revokedAt 字段，index 上的 where 过滤复用 (userId, revokedAt)
 */

import crypto from "crypto";
import {
  apiTokenSchemaRepository,
  apiTokensRepository,
  type ApiTokenSchemaDatabase,
} from "../repositories";

export const API_TOKEN_PREFIX = "nkn_"; // "nowen note key"
const TOKEN_RAW_BYTES = 32;

/** 支持的 scope 常量 */
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

export function isValidScope(s: string): s is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(s);
}

/** 建表（幂等）；驱动级 exec 由 Repository 边界承接。 */
export function initApiTokensTable(db: ApiTokenSchemaDatabase): void {
  apiTokenSchemaRepository.initialize(db);
}

/**
 * 记录一次 token 使用（调用量 +1）。
 * - SQLite UPSERT 单语句原子操作，高频调用下可接受。
 * - day 用 UTC，避免服务器跨时区部署导致的漂移。
 * - 用 try/catch 包装，走错不影响主鉴权路径。
 */
export function recordTokenUsage(_db: unknown, tokenId: string): void {
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    apiTokensRepository.recordUsage(tokenId, today);
  } catch {
    /* 非关键路径，忽略 */
  }
}

/**
 * 清理超过 retentionDays 天的 usage 数据（启动时 / 定期调用）。
 * 给 90 天额度已是 “多于任何选择期” 的冲量，避免表不限制增长。
 */
export function pruneTokenUsage(_db: unknown, retentionDays = 90): void {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000)
      .toISOString()
      .slice(0, 10);
    apiTokensRepository.pruneUsageBefore(cutoff);
  } catch {
    /* 忽略 */
  }
}

/** 生成一个新 token 的明文（以 nkn_ 开头） */
export function generateApiTokenRaw(): string {
  const raw = crypto.randomBytes(TOKEN_RAW_BYTES).toString("base64url");
  return API_TOKEN_PREFIX + raw;
}

/** 对 token 明文做 SHA-256，得到 hex hash */
export function hashApiToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** 判断 Authorization 头里的 Bearer 值是否看起来像 API token（以 nkn_ 开头） */
export function looksLikeApiToken(bearer: string): boolean {
  return bearer.startsWith(API_TOKEN_PREFIX);
}

export interface ResolvedApiToken {
  tokenId: string;
  userId: string;
  scopes: ApiTokenScope[];
}

/**
 * 用明文 token 在 DB 里查找并校验（未吊销、未过期）。
 * 成功返回用户信息；失败返回 null。副作用：更新 lastUsedAt / lastUsedIp（节流：60s 一次）。
 */
export function resolveApiToken(
  db: unknown,
  raw: string,
  ip?: string,
): ResolvedApiToken | null {
  if (!looksLikeApiToken(raw)) return null;
  const h = hashApiToken(raw);
  const row = apiTokensRepository.findByTokenHash(h);
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt) {
    const t = Date.parse(row.expiresAt);
    if (!isNaN(t) && t < Date.now()) return null;
  }

  // lastUsedAt 节流：距上次写入 >= 60s 才更新，避免高频写
  const shouldTouch =
    !row.lastUsedAt || Date.now() - Date.parse(row.lastUsedAt) > 60_000;
  if (shouldTouch) {
    try {
      apiTokensRepository.updateLastUsed(row.id, ip || "");
    } catch {
      /* 非关键路径，忽略 */
    }
  }

  // 使用量统计埋点：不节流（按天粒度聚合本身就十分稀疏，UPSERT 很快）
  recordTokenUsage(db, row.id);

  let scopes: ApiTokenScope[] = [];
  try {
    const parsed = JSON.parse(row.scopes) as string[];
    scopes = parsed.filter(isValidScope);
  } catch {
    scopes = [];
  }

  return { tokenId: row.id, userId: row.userId, scopes };
}

// SEC-PAT-01: 空 scopes 默认拒绝，LEGACY_EMPTY_SCOPE_FULL_ACCESS=true 可恢复旧行为
const legacyEmptyScopeFullAccess = process.env.LEGACY_EMPTY_SCOPE_FULL_ACCESS === "true";

export function hasScope(token: ResolvedApiToken, required: ApiTokenScope): boolean {
  if (token.scopes.length === 0) return legacyEmptyScopeFullAccess;
  return token.scopes.includes(required);
}

export function hasAnyScope(token: ResolvedApiToken, required: ApiTokenScope[]): boolean {
  return required.some((s) => hasScope(token, s));
}
