/**
 * 认证 / 登录安全工具集中处（Phase 5 安全加固）
 *
 * 职责：
 *   1. JWT_SECRET 的统一加载（生产环境强制环境变量）
 *   2. 登录接口的 IP / 账号双维度速率限制 + 账号锁定
 *   3. 签发 / 校验带 tokenVersion 的 JWT（支持"禁用用户立即失效"）
 *
 * 设计要点：
 *   - JWT 里新增 `tver` 字段（= users.tokenVersion）。用户密码重置、被禁用、
 *     恢复出厂设置时，后端会 `tokenVersion++`，旧 token 在校验时 `tver` 不匹配
 *     即被拒，无需维护黑名单。
 *   - 登录失败阈值：同一账号连续 5 次失败锁定 15 分钟；同一 IP 每分钟最多 10 次。
 *   - 内存计数器对单实例够用，多实例部署需外置 Redis（本项目 20 人规模够用）。
 */

import jwt from "jsonwebtoken";
import crypto from "crypto";
import type { Context } from "hono";

// ========== JWT Secret 初始化 ==========

const DEV_FALLBACK_SECRET = "nowen-note-secret-key-change-in-production";

function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    return fromEnv;
  }

  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    // 生产环境：JWT_SECRET 未设置或过短 → 拒绝启动
    console.error(
      "\n❌ [FATAL] 生产环境必须通过环境变量 JWT_SECRET 设置一个长度 >= 16 的强随机密钥。\n" +
      "   示例：export JWT_SECRET=$(openssl rand -base64 48)\n" +
      "   未设置时启动会被拒绝以避免使用硬编码密钥导致 token 被伪造。\n",
    );
    process.exit(1);
  }

  // 开发环境：给出明显警告，允许使用默认值继续
  console.warn(
    "\n⚠️  [SECURITY] JWT_SECRET 未设置（或长度 < 16），正在使用开发期默认密钥。\n" +
    "   上线前请务必配置强随机密钥：openssl rand -base64 48\n",
  );
  return fromEnv || DEV_FALLBACK_SECRET;
}

export const JWT_SECRET: string = resolveJwtSecret();
export const JWT_EXPIRES_IN = "30d";

// ========== 多种 Token 的 typ 标签 ==========
//
// C1：不同用途的 JWT 必须带 `typ` 字段并在校验时严格比对，防止"跨场景伪造"：
//   - "login"   登录 token（访问 /api/*、WS 鉴权）
//   - "share"   分享访问 token（由访客输入密码后换取，仅能访问指定 shareId）
//   - "sudo"    管理员二次验证 token（敏感操作必须同时带 login token + sudo token）
//
// 同时 share token 使用独立的 secret（SHARE_JWT_SECRET）：即便 JWT_SECRET 泄露也无法
// 伪造登录 token，反之亦然；sudo token 则继续使用 JWT_SECRET 但通过 typ 区分。
export type TokenType = "login" | "share" | "sudo";

/** 派生独立的分享 token secret：
 *   - 若显式设置了 SHARE_JWT_SECRET（生产推荐），直接使用；
 *   - 否则从 JWT_SECRET 做 HKDF-SHA256 派生出一个不同值（避免两者同 secret 可相互伪造）。
 */
function resolveShareJwtSecret(): string {
  const explicit = process.env.SHARE_JWT_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  // 用 HMAC(JWT_SECRET, "share-token-v1") 派生，保证与登录 secret 不同
  return crypto.createHmac("sha256", JWT_SECRET).update("nowen-share-token-v1").digest("hex");
}

export const SHARE_JWT_SECRET: string = resolveShareJwtSecret();

/** 签发登录 token（带 tokenVersion 与 typ="login"）
 *
 *  jti：Phase 6 会话管理用。同一用户每次登录会分配新的 sessionId 并写入 JWT 的 jti。
 *       JWT 中间件会据此校验 user_sessions.revokedAt 是否为 null，以实现"单端下线"而不必
 *       提升 tokenVersion（避免误伤所有端）。
 */
export function signLoginToken(payload: {
  userId: string;
  username: string;
  tokenVersion: number;
  jti?: string;
}): string {
  return jwt.sign(
    {
      typ: "login",
      userId: payload.userId,
      username: payload.username,
      tver: payload.tokenVersion,
      ...(payload.jti ? { jti: payload.jti } : {}),
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

/** 登录 token 的 payload 结构 */
export interface LoginTokenPayload {
  userId: string;
  username: string;
  /** typ 字段：新 token 恒为 "login"；旧 token 无此字段，兼容时按 login 处理 */
  typ?: TokenType;
  /** tokenVersion；旧版 token 没有此字段，按 0 处理 */
  tver?: number;
  /** 会话 ID（user_sessions.id）；旧 token 无此字段，按"无 session 追踪"处理 */
  jti?: string;
  iat?: number;
  exp?: number;
}

/** 校验登录 token。成功返回 payload，失败返回 null */
export function verifyLoginToken(token: string): LoginTokenPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as LoginTokenPayload;
    // C1: 非 login 类型的 token（sudo）不得用于登录认证
    if (payload.typ && payload.typ !== "login") return null;
    return payload;
  } catch {
    return null;
  }
}

// ========== 分享访问 Token（独立 secret + typ="share"）==========

export interface ShareTokenPayload {
  typ: "share";
  shareId: string;
  noteId: string;
  iat?: number;
  exp?: number;
}

/** 签发分享访问 token（访客通过密码验证后换取，1 小时有效） */
export function signShareAccessToken(params: { shareId: string; noteId: string }): string {
  return jwt.sign(
    { typ: "share", shareId: params.shareId, noteId: params.noteId },
    SHARE_JWT_SECRET,
    { expiresIn: "1h" },
  );
}

/** 校验分享访问 token，必须同时满足 typ==="share" 与期望的 shareId。 */
export function verifyShareAccessToken(token: string, expectedShareId: string): ShareTokenPayload | null {
  try {
    const payload = jwt.verify(token, SHARE_JWT_SECRET) as ShareTokenPayload;
    if (payload.typ !== "share") return null;
    if (payload.shareId !== expectedShareId) return null;
    return payload;
  } catch {
    return null;
  }
}

// ========== Sudo Token（管理员敏感操作二次验证）==========
//
// H2：管理员对破坏性极强的操作（删除用户、重置他人密码、factory-reset、角色变更、
//     禁用其他管理员等）要求先输入当前密码换一张 sudo token，再用这张 token 调用该操作。
//     这样即使 login token 被盗取（XSS / CSRF 拿到 header），攻击者也无法直接做这类操作。
//
// 设计：
//   - sudo token 有效期 5 分钟（`SUDO_TOKEN_TTL`），一次 sudo 会话可连续执行多个敏感操作
//   - 绑定到具体 userId，且带 tokenVersion 防止改密后的旧 sudo token 复用
//   - 通过 HTTP Header `X-Sudo-Token` 传递

export interface SudoTokenPayload {
  typ: "sudo";
  userId: string;
  tver: number;
  iat?: number;
  exp?: number;
}

export const SUDO_TOKEN_TTL_SEC = 5 * 60;

export function signSudoToken(userId: string, tokenVersion: number): string {
  return jwt.sign(
    { typ: "sudo", userId, tver: tokenVersion },
    JWT_SECRET,
    { expiresIn: SUDO_TOKEN_TTL_SEC },
  );
}

/**
 * 校验 sudo token。
 * 要求：typ==="sudo" + userId 与当前请求者一致 + tver 与 DB 一致。
 * 调用方在受保护路由中使用 `requireSudo(c)` 更方便。
 */
export function verifySudoToken(
  token: string,
  expectedUserId: string,
  expectedTokenVersion: number,
): SudoTokenPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as SudoTokenPayload;
    if (payload.typ !== "sudo") return null;
    if (payload.userId !== expectedUserId) return null;
    if ((payload.tver ?? -1) !== expectedTokenVersion) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * 从 Hono Context 中读取 X-Sudo-Token 并校验。
 * 返回统一结果供路由直接 return。
 */
export function verifySudoFromRequest(
  c: Context,
  expectedUserId: string,
  expectedTokenVersion: number,
):
  | { ok: true }
  | { ok: false; status: 401 | 403; code: string; reason: string; message: string } {
  const token = c.req.header("x-sudo-token") || c.req.header("X-Sudo-Token");
  if (!token) {
    return {
      ok: false,
      status: 403,
      code: "SUDO_REQUIRED",
      reason: "missing",
      message: "该操作需要二次密码验证，请先调用 /api/auth/sudo",
    };
  }
  const payload = verifySudoToken(token, expectedUserId, expectedTokenVersion);
  if (!payload) {
    return {
      ok: false,
      status: 403,
      code: "SUDO_INVALID",
      reason: "invalid_or_expired",
      message: "二次验证已过期，请重新输入密码",
    };
  }
  return { ok: true };
}

// ========== 登录速率限制 + 账号锁定 ==========

// IP 维度：windowMs 内最多 maxAttempts 次（不区分成功失败，因为登录接口本身就是被爆破的目标）
const IP_WINDOW_MS = 60_000;
const IP_MAX_ATTEMPTS = 10;

// 账号维度：连续 N 次失败后锁定
const ACCOUNT_MAX_FAIL = 5;
const ACCOUNT_LOCK_MS = 15 * 60_000; // 15 分钟
const ACCOUNT_FAIL_WINDOW_MS = 30 * 60_000; // 失败计数的滑动窗口：30 分钟无失败自动清零

interface IpBucket {
  count: number;
  resetAt: number;
}
const ipBuckets = new Map<string, IpBucket>();

/** 从 Hono Context 中提取客户端 IP */
export function extractClientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

/**
 * IP 维度速率限制检查。返回 null 表示通过，返回对象表示被拒绝。
 * 此函数是 check-and-increment 的原子操作。
 */
export function checkAndIncrementIpRate(ip: string): { retryAfterSec: number } | null {
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + IP_WINDOW_MS });
    cleanupIpBucketsIfNeeded();
    return null;
  }
  if (bucket.count >= IP_MAX_ATTEMPTS) {
    return { retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count++;
  return null;
}

function cleanupIpBucketsIfNeeded() {
  if (ipBuckets.size <= 2000) return;
  const now = Date.now();
  for (const [k, v] of ipBuckets.entries()) {
    if (v.resetAt <= now) ipBuckets.delete(k);
  }
}

// ========== 账号锁定（基于 DB 字段，服务重启后仍有效） ==========

export interface AccountLockRow {
  id: string;
  failedLoginAttempts: number;
  lastFailedLoginAt: string | null;
  lockedUntil: string | null;
}

/**
 * 登录前检查账号锁状态。返回 null 表示可以继续登录；返回对象表示被锁定。
 * 会自动清理过期锁和过期的失败计数。
 */
export function checkAccountLock(
  db: import("better-sqlite3").Database,
  userId: string,
): { lockedUntil: string; remainingSec: number } | null {
  const row = db
    .prepare(
      "SELECT id, failedLoginAttempts, lastFailedLoginAt, lockedUntil FROM users WHERE id = ?",
    )
    .get(userId) as AccountLockRow | undefined;
  if (!row) return null;

  const now = Date.now();

  // 锁定期内
  if (row.lockedUntil) {
    const lockTs = Date.parse(row.lockedUntil);
    if (!isNaN(lockTs) && lockTs > now) {
      return {
        lockedUntil: row.lockedUntil,
        remainingSec: Math.ceil((lockTs - now) / 1000),
      };
    }
    // 锁已过期，清除锁
    db.prepare("UPDATE users SET lockedUntil = NULL, failedLoginAttempts = 0 WHERE id = ?").run(
      userId,
    );
    return null;
  }

  // 失败计数滑动窗口过期则清零
  if (row.failedLoginAttempts > 0 && row.lastFailedLoginAt) {
    const lastTs = Date.parse(row.lastFailedLoginAt);
    if (!isNaN(lastTs) && now - lastTs > ACCOUNT_FAIL_WINDOW_MS) {
      db.prepare("UPDATE users SET failedLoginAttempts = 0 WHERE id = ?").run(userId);
    }
  }
  return null;
}

/**
 * 记录一次登录失败。达到阈值则自动锁定账号。
 * 返回：本次处理后的计数与锁定信息（如果刚刚触发锁定）。
 */
export function recordLoginFailure(
  db: import("better-sqlite3").Database,
  userId: string,
): { attempts: number; lockedUntil: string | null } {
  const row = db
    .prepare("SELECT failedLoginAttempts FROM users WHERE id = ?")
    .get(userId) as { failedLoginAttempts: number } | undefined;
  if (!row) return { attempts: 0, lockedUntil: null };

  const nextAttempts = row.failedLoginAttempts + 1;
  const nowIso = new Date().toISOString();

  if (nextAttempts >= ACCOUNT_MAX_FAIL) {
    const lockedUntil = new Date(Date.now() + ACCOUNT_LOCK_MS).toISOString();
    db.prepare(
      `UPDATE users
       SET failedLoginAttempts = ?, lastFailedLoginAt = ?, lockedUntil = ?
       WHERE id = ?`,
    ).run(nextAttempts, nowIso, lockedUntil, userId);
    return { attempts: nextAttempts, lockedUntil };
  }

  db.prepare(
    `UPDATE users
     SET failedLoginAttempts = ?, lastFailedLoginAt = ?
     WHERE id = ?`,
  ).run(nextAttempts, nowIso, userId);
  return { attempts: nextAttempts, lockedUntil: null };
}

/** 登录成功后重置失败计数与锁定 */
export function resetLoginFailure(db: import("better-sqlite3").Database, userId: string) {
  db.prepare(
    `UPDATE users
     SET failedLoginAttempts = 0, lastFailedLoginAt = NULL, lockedUntil = NULL
     WHERE id = ?`,
  ).run(userId);
}

/** 使该用户所有已签发的 JWT 立即失效（tokenVersion++）。返回新的 tokenVersion */
export function bumpTokenVersion(db: import("better-sqlite3").Database, userId: string): number {
  db.prepare("UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?").run(userId);
  const row = db.prepare("SELECT tokenVersion FROM users WHERE id = ?").get(userId) as
    | { tokenVersion: number }
    | undefined;
  // 同时清理 JWT 中间件的缓存，确保新状态立即生效
  invalidateUserAuthCache(userId);
  return row?.tokenVersion ?? 0;
}

// ========== JWT 中间件的用户态缓存 ==========
//
// 放在这里而不是 index.ts，是为了避免 users.ts/auth.ts 和 index.ts 之间的循环依赖。
// index.ts 的 JWT 中间件从这里读缓存并填充；其他模块（users.ts / auth.ts）在改变用户
// 状态（禁用、改密、删除、factory-reset、bump tokenVersion）后主动 invalidate 即可。

export interface AuthCacheEntry {
  username: string;
  tokenVersion: number;
  isDisabled: number;
  role: string;
  expireAt: number;
}

export const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new Map<string, AuthCacheEntry>();

export function getCachedAuthUser(userId: string): AuthCacheEntry | null {
  const hit = authCache.get(userId);
  if (hit && hit.expireAt > Date.now()) return hit;
  return null;
}

export function setCachedAuthUser(userId: string, entry: Omit<AuthCacheEntry, "expireAt">) {
  authCache.set(userId, { ...entry, expireAt: Date.now() + AUTH_CACHE_TTL_MS });
}

export function invalidateUserAuthCache(userId: string) {
  authCache.delete(userId);
}
