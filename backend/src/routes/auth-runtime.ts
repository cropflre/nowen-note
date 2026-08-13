import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { Hono, type Context } from "hono";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";

import type { DatabaseAdapter } from "../db/adapters/types";
import {
  JWT_SECRET,
  checkAndIncrementIpRate,
  extractClientIp,
  signLoginToken,
  signRefreshToken,
  verifyLoginToken,
  verifyRefreshToken,
} from "../lib/auth-security";
import { hashRecoveryCode, verifyTotp } from "../lib/totp";

const USERNAME_REGEX = /^[A-Za-z0-9_\-.]{3,32}$/;
const SESSION_DAYS = 30;
const MAX_LOGIN_FAILURES = 5;
const LOCK_MINUTES = 15;

type AuthUserRow = {
  id: string;
  username: string;
  email: string | null;
  avatarUrl: string | null;
  displayName: string | null;
  role: string;
  isDisabled: boolean | number;
  isDemo: boolean | number;
  passwordHash: string;
  tokenVersion: number;
  mustChangePassword: boolean | number;
  twoFactorSecret: string | null;
  twoFactorBackupCodes?: string | null;
  failedLoginAttempts?: number;
  lockedUntil?: string | Date | null;
  createdAt: string | Date;
};

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function publicUser(user: AuthUserRow) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatarUrl: user.avatarUrl,
    displayName: user.displayName,
    role: user.role || "user",
    isDemo: flag(user.isDemo),
    createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt,
    mustChangePassword: flag(user.mustChangePassword) ? true : undefined,
  };
}

function validateUsername(name: unknown): string | null {
  if (typeof name !== "string" || !name) return "用户名不能为空";
  if (!USERNAME_REGEX.test(name.trim())) return "用户名需为 3-32 位字母/数字/_/-/.";
  return null;
}

function verifyPasswordCompat(input: string, storedHash: string): Promise<boolean> | boolean {
  if (!storedHash) return false;
  if (storedHash.startsWith("$2")) return bcrypt.compare(input, storedHash);
  return createHash("sha256").update(input).digest("hex") === storedHash;
}

function issueLoginTokens(params: {
  userId: string;
  username: string;
  tokenVersion: number;
  sessionId: string;
}) {
  return {
    token: signLoginToken({
      userId: params.userId,
      username: params.username,
      tokenVersion: params.tokenVersion,
      jti: params.sessionId,
    }),
    refreshToken: signRefreshToken({
      userId: params.userId,
      username: params.username,
      tokenVersion: params.tokenVersion,
      jti: params.sessionId,
    }),
  };
}

async function getRegistrationOpen(adapter: DatabaseAdapter): Promise<boolean> {
  const row = await adapter.queryOne<{ value: string }>(
    `SELECT value FROM system_settings WHERE key = 'auth_allow_registration'`,
  );
  if (!row) return true;
  return row.value === "1" || row.value === "true";
}

async function resolveAuthenticatedUser(adapter: DatabaseAdapter, c: Context) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const payload = verifyLoginToken(authHeader.slice(7));
  if (!payload?.userId) return null;

  const user = await adapter.queryOne<AuthUserRow>(
    `SELECT id, username, email, "avatarUrl", "displayName", role, "isDisabled", "isDemo",
            "passwordHash", "tokenVersion", "mustChangePassword", "twoFactorSecret", "createdAt"
       FROM users WHERE id = ?`,
    [payload.userId],
  );
  if (!user || flag(user.isDisabled) || (payload.tver ?? 0) !== (user.tokenVersion ?? 0)) return null;

  if (payload.jti) {
    const session = await adapter.queryOne<{ revokedAt: string | Date | null; expiresAt: string | Date | null }>(
      `SELECT "revokedAt", "expiresAt" FROM user_sessions WHERE id = ? AND "userId" = ?`,
      [payload.jti, user.id],
    );
    if (!session || session.revokedAt) return null;
    if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) return null;
  }

  return { user, payload };
}

async function createSession(adapter: DatabaseAdapter, params: {
  userId: string;
  ip: string;
  userAgent: string;
  deviceId?: string;
}): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  const deviceLabel = params.deviceId ? `device:${params.deviceId}` : null;

  if (deviceLabel) {
    const existing = await adapter.queryOne<{ id: string }>(
      `SELECT id FROM user_sessions
       WHERE "userId" = ? AND "deviceLabel" = ? AND "revokedAt" IS NULL
         AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
       ORDER BY "lastSeenAt" DESC LIMIT 1`,
      [params.userId, deviceLabel],
    );
    if (existing) {
      await adapter.execute(
        `UPDATE user_sessions
            SET "lastSeenAt" = CURRENT_TIMESTAMP, ip = ?, "userAgent" = ?, "expiresAt" = ?
          WHERE id = ?`,
        [params.ip || "", params.userAgent || "", expiresAt, existing.id],
      );
      return existing.id;
    }
  }

  const id = uuid();
  await adapter.execute(
    `INSERT INTO user_sessions (id, "userId", ip, "userAgent", "deviceLabel", "expiresAt")
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, params.userId, params.ip || "", params.userAgent || "", deviceLabel, expiresAt],
  );
  return id;
}

async function consumeRecoveryCode(adapter: DatabaseAdapter, userId: string, code: string): Promise<boolean> {
  if (!code) return false;
  const row = await adapter.queryOne<{ twoFactorBackupCodes: string | null }>(
    `SELECT "twoFactorBackupCodes" FROM users WHERE id = ?`,
    [userId],
  );
  if (!row?.twoFactorBackupCodes) return false;

  let hashes: string[];
  try {
    hashes = JSON.parse(row.twoFactorBackupCodes) as string[];
  } catch {
    return false;
  }
  const candidate = hashRecoveryCode(code);
  const index = hashes.indexOf(candidate);
  if (index < 0) return false;
  hashes.splice(index, 1);
  await adapter.execute(
    `UPDATE users SET "twoFactorBackupCodes" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ?`,
    [JSON.stringify(hashes), userId],
  );
  return true;
}

export default function createAuthRuntimeRouter(adapter: DatabaseAdapter) {
  const auth = new Hono();

  auth.get("/register/config", async (c) => {
    const row = await adapter.queryOne<{ count: number | string }>(`SELECT COUNT(*) AS count FROM users`);
    const userCount = Number(row?.count ?? 0);
    return c.json({
      allowRegistration: await getRegistrationOpen(adapter),
      userCount,
      hasUsers: userCount > 0,
    });
  });

  auth.put("/register/config", async (c) => {
    const authenticated = await resolveAuthenticatedUser(adapter, c);
    if (!authenticated) return c.json({ error: "未授权" }, 401);
    if (authenticated.user.role !== "admin") return c.json({ error: "仅管理员可操作" }, 403);
    const body = await c.req.json().catch(() => ({})) as { allowRegistration?: boolean };
    if (typeof body.allowRegistration !== "boolean") {
      return c.json({ error: "allowRegistration 必须是布尔值" }, 400);
    }
    await adapter.execute(
      `INSERT INTO system_settings (key, value, "updatedAt")
       VALUES ('auth_allow_registration', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = CURRENT_TIMESTAMP`,
      [body.allowRegistration ? "1" : "0"],
    );
    return c.json({ allowRegistration: body.allowRegistration });
  });

  auth.post("/register", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      username?: string;
      password?: string;
      email?: string;
      displayName?: string;
    };
    const username = body.username?.trim() || "";
    const usernameError = validateUsername(username);
    if (usernameError) return c.json({ error: usernameError }, 400);
    if (!body.password || body.password.length < 6) return c.json({ error: "密码长度至少为 6 位" }, 400);
    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return c.json({ error: "邮箱格式不正确" }, 400);
    }

    const countRow = await adapter.queryOne<{ count: number | string }>(`SELECT COUNT(*) AS count FROM users`);
    const isFirstUser = Number(countRow?.count ?? 0) === 0;
    if (!isFirstUser && !(await getRegistrationOpen(adapter))) {
      return c.json({ error: "注册通道已关闭，请联系管理员" }, 403);
    }

    const id = uuid();
    const passwordHash = await bcrypt.hash(body.password, 10);
    try {
      await adapter.execute(
        `INSERT INTO users (id, username, email, "passwordHash", role, "displayName")
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, username, body.email?.trim() || null, passwordHash, isFirstUser ? "admin" : "user", body.displayName?.trim() || null],
      );
    } catch (error: any) {
      if (String(error?.code || "") === "23505") {
        const detail = String(error?.detail || error?.message || "");
        if (/email/i.test(detail)) return c.json({ error: "该邮箱已被注册" }, 409);
        if (/username/i.test(detail)) return c.json({ error: "该用户名已被占用" }, 409);
        return c.json({ error: "用户名或邮箱已被占用" }, 409);
      }
      throw error;
    }

    await adapter.execute(`UPDATE users SET "lastLoginAt" = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
    const user = await adapter.queryOne<AuthUserRow>(
      `SELECT id, username, email, "avatarUrl", "displayName", role, "isDisabled", "isDemo",
              "passwordHash", "tokenVersion", "mustChangePassword", "twoFactorSecret", "createdAt"
         FROM users WHERE id = ?`,
      [id],
    );
    if (!user) throw new Error("registered user disappeared");
    const sessionId = await createSession(adapter, {
      userId: id,
      ip: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "",
    });
    return c.json({
      ...issueLoginTokens({ userId: id, username, tokenVersion: user.tokenVersion ?? 0, sessionId }),
      user: publicUser(user),
    }, 201);
  });

  auth.post("/login", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { username?: string; password?: string; deviceId?: string };
    const username = body.username?.trim() || "";
    if (!username || !body.password) return c.json({ error: "用户名和密码不能为空" }, 400);

    const ip = extractClientIp(c);
    const ipBlocked = checkAndIncrementIpRate(ip);
    if (ipBlocked) {
      c.header("Retry-After", String(ipBlocked.retryAfterSec));
      return c.json({ error: `登录请求过于频繁，请 ${ipBlocked.retryAfterSec} 秒后重试`, code: "RATE_LIMITED" }, 429);
    }

    const user = await adapter.queryOne<AuthUserRow>(
      `SELECT id, username, email, "avatarUrl", "displayName", role, "isDisabled", "isDemo",
              "passwordHash", "tokenVersion", "mustChangePassword", "twoFactorSecret",
              "failedLoginAttempts", "lockedUntil", "createdAt"
         FROM users WHERE username = ?`,
      [username],
    );
    if (!user) return c.json({ error: "用户名或密码错误" }, 401);
    if (flag(user.isDisabled)) return c.json({ error: "该账号已被禁用，请联系管理员", code: "ACCOUNT_DISABLED" }, 403);

    if (user.lockedUntil) {
      const lockedUntil = new Date(user.lockedUntil).getTime();
      if (lockedUntil > Date.now()) {
        const remainingSec = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
        c.header("Retry-After", String(remainingSec));
        return c.json({
          error: `账号已被临时锁定，请 ${Math.ceil(remainingSec / 60)} 分钟后再试`,
          code: "ACCOUNT_LOCKED",
          lockedUntil: new Date(lockedUntil).toISOString(),
        }, 423);
      }
      await adapter.execute(
        `UPDATE users SET "lockedUntil" = NULL, "failedLoginAttempts" = 0 WHERE id = ?`,
        [user.id],
      );
      user.failedLoginAttempts = 0;
    }

    const passwordValid = await verifyPasswordCompat(body.password, user.passwordHash);
    if (!passwordValid) {
      const attempts = Number(user.failedLoginAttempts ?? 0) + 1;
      const failedAt = new Date().toISOString();
      const lockedUntil = attempts >= MAX_LOGIN_FAILURES
        ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()
        : null;
      await adapter.execute(
        `UPDATE users
            SET "failedLoginAttempts" = ?, "lastFailedLoginAt" = ?, "lockedUntil" = ?
          WHERE id = ?`,
        [attempts, failedAt, lockedUntil, user.id],
      );
      if (lockedUntil) {
        return c.json({
          error: `密码错误次数过多，账号已被临时锁定 ${LOCK_MINUTES} 分钟`,
          code: "ACCOUNT_LOCKED",
          lockedUntil,
        }, 423);
      }
      return c.json({ error: "用户名或密码错误" }, 401);
    }

    if (!user.passwordHash.startsWith("$2")) {
      await adapter.execute(`UPDATE users SET "passwordHash" = ? WHERE id = ?`, [await bcrypt.hash(body.password, 10), user.id]);
    }
    await adapter.execute(
      `UPDATE users
          SET "failedLoginAttempts" = 0, "lastFailedLoginAt" = NULL, "lockedUntil" = NULL,
              "lastLoginAt" = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [user.id],
    );

    if (user.twoFactorSecret) {
      const ticket = jwt.sign(
        { typ: "2fa", userId: user.id, tver: user.tokenVersion ?? 0 },
        JWT_SECRET,
        { expiresIn: "5m" },
      );
      return c.json({ requires2FA: true, ticket, username: user.username });
    }

    const sessionId = await createSession(adapter, {
      userId: user.id,
      ip,
      userAgent: c.req.header("user-agent") || "",
      deviceId: body.deviceId,
    });
    return c.json({
      ...issueLoginTokens({ userId: user.id, username: user.username, tokenVersion: user.tokenVersion ?? 0, sessionId }),
      user: publicUser(user),
    });
  });

  auth.post("/2fa/verify", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { ticket?: string; code?: string; deviceId?: string };
    if (!body.ticket || !body.code) return c.json({ error: "参数缺失" }, 400);

    let ticket: { typ?: string; userId?: string; tver?: number } | null = null;
    try {
      const decoded = jwt.verify(body.ticket, JWT_SECRET) as { typ?: string; userId?: string; tver?: number };
      if (decoded.typ === "2fa" && decoded.userId) ticket = decoded;
    } catch {
      ticket = null;
    }
    if (!ticket?.userId) return c.json({ error: "登录会话已过期，请重新输入密码", code: "TFA_TICKET_EXPIRED" }, 401);

    const user = await adapter.queryOne<AuthUserRow>(
      `SELECT id, username, email, "avatarUrl", "displayName", role, "isDisabled", "isDemo",
              "passwordHash", "tokenVersion", "mustChangePassword", "twoFactorSecret", "twoFactorBackupCodes", "createdAt"
         FROM users WHERE id = ?`,
      [ticket.userId],
    );
    if (!user) return c.json({ error: "用户不存在" }, 404);
    if (flag(user.isDisabled)) return c.json({ error: "该账号已被禁用", code: "ACCOUNT_DISABLED" }, 403);
    if ((user.tokenVersion ?? 0) !== (ticket.tver ?? 0)) {
      return c.json({ error: "登录会话已失效，请重新输入密码", code: "TFA_TICKET_EXPIRED" }, 401);
    }
    if (!user.twoFactorSecret) return c.json({ error: "该账号未启用 2FA", code: "TFA_NOT_ENABLED" }, 400);

    const code = body.code.trim();
    const validTotp = verifyTotp(user.twoFactorSecret, code);
    const validRecovery = !validTotp && await consumeRecoveryCode(adapter, user.id, code);
    if (!validTotp && !validRecovery) return c.json({ error: "验证码错误", code: "TFA_INVALID_CODE" }, 400);

    const sessionId = await createSession(adapter, {
      userId: user.id,
      ip: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "",
      deviceId: body.deviceId,
    });
    return c.json({
      ...issueLoginTokens({ userId: user.id, username: user.username, tokenVersion: user.tokenVersion ?? 0, sessionId }),
      user: publicUser(user),
    });
  });

  auth.post("/refresh", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { refreshToken?: string };
    const payload = body.refreshToken ? verifyRefreshToken(body.refreshToken) : null;
    if (!payload?.userId || !payload.jti) {
      return c.json({ error: "登录已过期，请重新登录", code: "REFRESH_TOKEN_INVALID" }, 401);
    }

    const user = await adapter.queryOne<{ id: string; username: string; isDisabled: boolean | number; tokenVersion: number }>(
      `SELECT id, username, "isDisabled", "tokenVersion" FROM users WHERE id = ?`,
      [payload.userId],
    );
    if (!user) return c.json({ error: "账号不存在或已被删除", code: "USER_NOT_FOUND" }, 401);
    if (flag(user.isDisabled)) return c.json({ error: "该账号已被禁用，请联系管理员", code: "ACCOUNT_DISABLED" }, 403);
    if ((payload.tver ?? 0) !== (user.tokenVersion ?? 0)) {
      return c.json({ error: "会话已失效，请重新登录", code: "TOKEN_REVOKED" }, 401);
    }

    const session = await adapter.queryOne<{ revokedAt: string | Date | null; expiresAt: string | Date | null }>(
      `SELECT "revokedAt", "expiresAt" FROM user_sessions WHERE id = ? AND "userId" = ?`,
      [payload.jti, user.id],
    );
    if (!session) return c.json({ error: "会话已失效，请重新登录", code: "TOKEN_REVOKED" }, 401);
    if (session.revokedAt) return c.json({ error: "该会话已被下线", code: "SESSION_REVOKED" }, 401);
    if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) {
      return c.json({ error: "登录已超过 30 天，请重新登录", code: "SESSION_EXPIRED" }, 401);
    }

    await adapter.execute(`UPDATE user_sessions SET "lastSeenAt" = CURRENT_TIMESTAMP WHERE id = ?`, [payload.jti]);
    return c.json({
      token: signLoginToken({
        userId: user.id,
        username: user.username,
        tokenVersion: user.tokenVersion,
        jti: payload.jti,
      }),
    });
  });

  auth.post("/logout", async (c) => {
    const authHeader = c.req.header("Authorization");
    const loginPayload = authHeader?.startsWith("Bearer ") ? verifyLoginToken(authHeader.slice(7)) : null;
    const body = await c.req.json().catch(() => ({})) as { refreshToken?: string };
    const refreshPayload = body.refreshToken ? verifyRefreshToken(body.refreshToken) : null;
    const sessionId = loginPayload?.jti || refreshPayload?.jti;
    if (sessionId) {
      await adapter.execute(
        `UPDATE user_sessions
            SET "revokedAt" = CURRENT_TIMESTAMP, "revokedReason" = 'user_logout'
          WHERE id = ? AND "revokedAt" IS NULL`,
        [sessionId],
      );
    }
    return c.json({ success: true });
  });

  auth.get("/verify", async (c) => {
    const authenticated = await resolveAuthenticatedUser(adapter, c);
    if (!authenticated) return c.json({ error: "Token 无效或已过期", code: "TOKEN_INVALID" }, 401);
    return c.json({ user: publicUser(authenticated.user) });
  });

  auth.get("/sessions", async (c) => {
    const authenticated = await resolveAuthenticatedUser(adapter, c);
    if (!authenticated) return c.json({ error: "未授权" }, 401);
    const currentSessionId = authenticated.payload.jti || null;
    await adapter.execute(
      `DELETE FROM user_sessions
        WHERE "userId" = ? AND ("revokedAt" IS NOT NULL OR ("expiresAt" IS NOT NULL AND "expiresAt" <= CURRENT_TIMESTAMP))`,
      [authenticated.user.id],
    );
    const rows = await adapter.queryMany<any>(
      `SELECT id, "createdAt", "lastSeenAt", "expiresAt", ip, "userAgent", "deviceLabel"
         FROM user_sessions
        WHERE "userId" = ? AND "revokedAt" IS NULL
          AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)
        ORDER BY "lastSeenAt" DESC`,
      [authenticated.user.id],
    );
    return c.json({
      sessions: rows.map((row) => ({ ...row, current: row.id === currentSessionId })),
      currentSessionId,
    });
  });

  auth.delete("/sessions/:id", async (c) => {
    const authenticated = await resolveAuthenticatedUser(adapter, c);
    if (!authenticated) return c.json({ error: "未授权" }, 401);
    const sessionId = c.req.param("id");
    const session = await adapter.queryOne<{ id: string; userId: string; revokedAt: string | Date | null }>(
      `SELECT id, "userId", "revokedAt" FROM user_sessions WHERE id = ?`,
      [sessionId],
    );
    if (!session || session.userId !== authenticated.user.id) return c.json({ error: "会话不存在" }, 404);
    if (session.revokedAt) return c.json({ success: true, alreadyRevoked: true });
    await adapter.execute(
      `UPDATE user_sessions SET "revokedAt" = CURRENT_TIMESTAMP, "revokedReason" = 'user_revoked' WHERE id = ?`,
      [sessionId],
    );
    return c.json({ success: true });
  });

  auth.delete("/sessions", async (c) => {
    const authenticated = await resolveAuthenticatedUser(adapter, c);
    if (!authenticated) return c.json({ error: "未授权" }, 401);
    const currentSessionId = authenticated.payload.jti || null;
    const keepCurrent = c.req.query("keepCurrent") !== "0";
    const params: unknown[] = [authenticated.user.id];
    let sql = `UPDATE user_sessions SET "revokedAt" = CURRENT_TIMESTAMP, "revokedReason" = 'user_bulk_revoked'
                WHERE "userId" = ? AND "revokedAt" IS NULL`;
    if (keepCurrent && currentSessionId) {
      sql += ` AND id != ?`;
      params.push(currentSessionId);
    }
    const result = await adapter.execute(sql, params);
    return c.json({ success: true, revoked: result.changes });
  });

  return auth;
}
