import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import {
  JWT_SECRET,
  JWT_EXPIRES_IN,
  signLoginToken,
  signSudoToken,
  SUDO_TOKEN_TTL_SEC,
  verifySudoFromRequest,
  verifyLoginToken,
  extractClientIp,
  checkAndIncrementIpRate,
  checkAccountLock,
  recordLoginFailure,
  resetLoginFailure,
  bumpTokenVersion,
  invalidateUserAuthCache,
} from "../lib/auth-security";
import {
  generateTotpSecret,
  verifyTotp,
  buildOtpAuthUri,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "../lib/totp";
import { logAudit } from "../services/audit";
import jwt from "jsonwebtoken";
import { disconnectUser } from "../services/realtime";

const auth = new Hono();

// ========== 会话管理辅助 ==========
//
// Phase 6: 登录即落一条 user_sessions，JWT 中间件根据 jti 校验 revokedAt。
// 下面的 helper 让 auth/users 路由无须自己拼 SQL。

/** 新建一条会话记录并返回 sessionId（= JWT 的 jti） */
function createSession(params: {
  userId: string;
  ip: string;
  userAgent: string;
  expiresInDays?: number;
}): string {
  const id = uuid();
  const days = params.expiresInDays ?? 30; // 与 JWT_EXPIRES_IN 对齐
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO user_sessions (id, userId, ip, userAgent, expiresAt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, params.userId, params.ip || "", params.userAgent || "", expiresAt);
  return id;
}

/** 标记 session 为已吊销。适用于"单端下线"，不提升 tokenVersion，其它端不受影响。 */
function revokeSession(sessionId: string, reason: string) {
  const db = getDb();
  db.prepare(
    `UPDATE user_sessions
     SET revokedAt = datetime('now'), revokedReason = ?
     WHERE id = ? AND revokedAt IS NULL`,
  ).run(reason, sessionId);
}

// ========== 工具 ==========

function getRegistrationOpen(): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM system_settings WHERE key = 'auth_allow_registration'")
    .get() as { value: string } | undefined;
  // 默认允许注册。管理员可在设置中关闭。
  if (!row) return true;
  return row.value === "1" || row.value === "true";
}

function setRegistrationOpen(open: boolean) {
  const db = getDb();
  db.prepare(
    `INSERT INTO system_settings (key, value, updatedAt)
     VALUES ('auth_allow_registration', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')`,
  ).run(open ? "1" : "0");
}

const USERNAME_REGEX = /^[A-Za-z0-9_\-.]{3,32}$/;

function validateUsername(name: string): string | null {
  if (!name || typeof name !== "string") return "用户名不能为空";
  if (!USERNAME_REGEX.test(name.trim())) return "用户名需为 3-32 位字母/数字/_/-/.";
  return null;
}

function verifyPasswordCompat(input: string, storedHash: string): boolean {
  if (!storedHash) return false;
  if (storedHash.startsWith("$2")) {
    return bcrypt.compareSync(input, storedHash);
  }
  const crypto = require("crypto");
  const sha256 = crypto.createHash("sha256").update(input).digest("hex");
  return sha256 === storedHash;
}

// 从请求中解析当前 userId（auth 路由未走全局 JWT 中间件，必要处手动解析）
// 同时校验 tokenVersion，禁用/改密后旧 token 不再可用。
function extractUserId(c: any): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const payload = verifyLoginToken(token);
  if (!payload) return null;

  const db = getDb();
  const user = db
    .prepare("SELECT id, tokenVersion FROM users WHERE id = ?")
    .get(payload.userId) as { id: string; tokenVersion: number } | undefined;
  if (!user) return null;
  // 旧 token 没有 tver 字段，按 0 比对：一旦 DB 中 tokenVersion > 0 则拒绝
  if ((payload.tver ?? 0) !== user.tokenVersion) return null;
  return user.id;
}

// ========== 注册配置（公开读取，管理员写入） ==========

auth.get("/register/config", (c) => {
  return c.json({ allowRegistration: getRegistrationOpen() });
});

auth.put("/register/config", async (c) => {
  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "未授权" }, 401);
  const db = getDb();
  const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined;
  if (!me || me.role !== "admin") return c.json({ error: "仅管理员可操作" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as { allowRegistration?: boolean };
  if (typeof body.allowRegistration !== "boolean") {
    return c.json({ error: "allowRegistration 必须是布尔值" }, 400);
  }
  setRegistrationOpen(body.allowRegistration);
  return c.json({ allowRegistration: getRegistrationOpen() });
});

// ========== 注册 ==========

auth.post("/register", async (c) => {
  const body = await c.req.json();
  const { username, password, email, displayName } = body as {
    username: string;
    password: string;
    email?: string;
    displayName?: string;
  };

  const usernameErr = validateUsername(username);
  if (usernameErr) return c.json({ error: usernameErr }, 400);
  if (!password || password.length < 6) {
    return c.json({ error: "密码长度至少为 6 位" }, 400);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "邮箱格式不正确" }, 400);
  }

  const db = getDb();

  // 首个用户允许注册并自动成为 admin（即使关闭注册开关也放行，方便新部署引导）
  const userCountRow = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  const isFirstUser = userCountRow.c === 0;

  if (!isFirstUser && !getRegistrationOpen()) {
    return c.json({ error: "注册通道已关闭，请联系管理员" }, 403);
  }

  const id = uuid();
  const passwordHash = await bcrypt.hash(password, 10);
  const role = isFirstUser ? "admin" : "user";
  const trimmedUsername = username.trim();
  const trimmedEmail = email?.trim() || null;

  // 直接 INSERT 依赖 DB 唯一约束（schema 已在 users.username / email 上声明 UNIQUE）。
  // 避免"先 SELECT 再 INSERT"的 TOCTOU 竞态：并发注册同名账号时，只有一个能写入成功，
  // 另一个会抛 SQLITE_CONSTRAINT_UNIQUE。
  try {
    db.prepare(
      `INSERT INTO users (id, username, email, passwordHash, role, displayName)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, trimmedUsername, trimmedEmail, passwordHash, role, displayName?.trim() || null);
  } catch (e: any) {
    if (String(e?.code || "").startsWith("SQLITE_CONSTRAINT")) {
      const msg = String(e?.message || "");
      if (msg.includes("users.email")) return c.json({ error: "该邮箱已被注册" }, 409);
      if (msg.includes("users.username")) return c.json({ error: "该用户名已被占用" }, 409);
      return c.json({ error: "用户名或邮箱已被占用" }, 409);
    }
    throw e;
  }

  db.prepare("UPDATE users SET lastLoginAt = datetime('now') WHERE id = ?").run(id);
  const created = db
    .prepare("SELECT tokenVersion FROM users WHERE id = ?")
    .get(id) as { tokenVersion: number };

  // Phase 6: 注册即建立一条 session，sessionId 写入 jti
  const sessionId = createSession({
    userId: id,
    ip: extractClientIp(c),
    userAgent: c.req.header("user-agent") || "",
  });
  const token = signLoginToken({
    userId: id,
    username: trimmedUsername,
    tokenVersion: created.tokenVersion,
    jti: sessionId,
  });

  const user = db
    .prepare(
      "SELECT id, username, email, avatarUrl, displayName, role, createdAt FROM users WHERE id = ?",
    )
    .get(id);

  return c.json({ token, user }, 201);
});

// ========== 登录 ==========

auth.post("/login", async (c) => {
  const body = await c.req.json();
  const { username, password } = body as { username: string; password: string };

  if (!username || !password) {
    return c.json({ error: "用户名和密码不能为空" }, 400);
  }

  // H1: IP 维度速率限制
  const ip = extractClientIp(c);
  const ipBlocked = checkAndIncrementIpRate(ip);
  if (ipBlocked) {
    c.header("Retry-After", String(ipBlocked.retryAfterSec));
    return c.json(
      { error: `登录请求过于频繁，请 ${ipBlocked.retryAfterSec} 秒后重试`, code: "RATE_LIMITED" },
      429,
    );
  }

  const db = getDb();
  const user = db
    .prepare(
      `SELECT id, username, email, avatarUrl, displayName, role, isDisabled, passwordHash,
              tokenVersion, mustChangePassword, twoFactorSecret, createdAt
       FROM users WHERE username = ?`,
    )
    .get(username) as any;

  if (!user) {
    // 统一错误文案，防止通过响应差异枚举用户名
    return c.json({ error: "用户名或密码错误" }, 401);
  }

  if (user.isDisabled) {
    return c.json({ error: "该账号已被禁用，请联系管理员", code: "ACCOUNT_DISABLED" }, 403);
  }

  // H1: 账号锁定检查（达到失败阈值后被锁 15 分钟）
  const lock = checkAccountLock(db, user.id);
  if (lock) {
    c.header("Retry-After", String(lock.remainingSec));
    return c.json(
      {
        error: `账号已被临时锁定，请 ${Math.ceil(lock.remainingSec / 60)} 分钟后再试`,
        code: "ACCOUNT_LOCKED",
        lockedUntil: lock.lockedUntil,
      },
      423, // Locked
    );
  }

  // 校验密码（兼容旧的 SHA256 和新的 bcrypt）
  let isValid = false;
  if (user.passwordHash.startsWith("$2")) {
    isValid = await bcrypt.compare(password, user.passwordHash);
  } else {
    const crypto = require("crypto");
    const sha256 = crypto.createHash("sha256").update(password).digest("hex");
    isValid = sha256 === user.passwordHash;

    if (isValid) {
      const newHash = await bcrypt.hash(password, 10);
      db.prepare("UPDATE users SET passwordHash = ? WHERE id = ?").run(newHash, user.id);
    }
  }

  if (!isValid) {
    const fail = recordLoginFailure(db, user.id);
    if (fail.lockedUntil) {
      return c.json(
        {
          error: "密码错误次数过多，账号已被临时锁定 15 分钟",
          code: "ACCOUNT_LOCKED",
          lockedUntil: fail.lockedUntil,
        },
        423,
      );
    }
    return c.json({ error: "用户名或密码错误" }, 401);
  }

  // 登录成功：清理失败计数，刷新 lastLoginAt
  resetLoginFailure(db, user.id);
  db.prepare("UPDATE users SET lastLoginAt = datetime('now') WHERE id = ?").run(user.id);

  // Phase 6: 2FA 拦截
  //
  //   用户开了 2FA → 不直接下发 login token，改发一张短期 2fa ticket（5 分钟）。
  //   前端再调 POST /auth/2fa/verify 提交 TOTP 或 recovery code 换取真正的 token。
  //   这里的 ticket 用专用 typ="2fa" 签发，JWT_SECRET，绑定 userId + tokenVersion，
  //   防止被当作 login token 混用，也防止密码改掉后 ticket 仍然可用。
  if (user.twoFactorSecret) {
    const ticket = jwt.sign(
      { typ: "2fa", userId: user.id, tver: user.tokenVersion ?? 0 },
      JWT_SECRET,
      { expiresIn: "5m" },
    );
    return c.json({
      requires2FA: true,
      ticket,
      // 提示用户账号 + 部分信息，前端展示"正在登录为 xxx"
      username: user.username,
    });
  }

  // Phase 6: 登录成功即建立 session
  const sessionId = createSession({
    userId: user.id,
    ip,
    userAgent: c.req.header("user-agent") || "",
  });
  const token = signLoginToken({
    userId: user.id,
    username: user.username,
    tokenVersion: user.tokenVersion ?? 0,
    jti: sessionId,
  });

  return c.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      displayName: user.displayName,
      role: user.role || "user",
      createdAt: user.createdAt,
      mustChangePassword: user.mustChangePassword ? true : undefined,
    },
  });
});

// ========== 修改账号安全信息（用户名 + 密码） ==========

auth.post("/change-password", async (c) => {
  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "未授权" }, 401);

  const body = await c.req.json();
  const { currentPassword, newUsername, newPassword } = body as {
    currentPassword: string;
    newUsername?: string;
    newPassword?: string;
  };

  if (!currentPassword) {
    return c.json({ error: "必须提供当前密码" }, 400);
  }

  if (!newUsername && !newPassword) {
    return c.json({ error: "请填写要修改的用户名或新密码" }, 400);
  }

  if (newPassword && newPassword.length < 6) {
    return c.json({ error: "新密码长度至少为6位" }, 400);
  }
  if (newUsername) {
    const err = validateUsername(newUsername);
    if (err) return c.json({ error: err }, 400);
  }

  const db = getDb();
  const user = db.prepare("SELECT id, username, passwordHash FROM users WHERE id = ?").get(userId) as any;
  if (!user) return c.json({ error: "用户不存在" }, 404);

  if (!verifyPasswordCompat(currentPassword, user.passwordHash)) {
    return c.json({ error: "当前密码错误" }, 403);
  }

  const updates: string[] = [];
  const params: any[] = [];

  if (newUsername && newUsername !== user.username) {
    updates.push("username = ?");
    params.push(newUsername.trim());
  }

  if (newPassword) {
    const newHash = await bcrypt.hash(newPassword, 10);
    updates.push("passwordHash = ?");
    params.push(newHash);
    // 密码修改后清零 mustChangePassword
    updates.push("mustChangePassword = 0");
    // 使其它端旧 token 立即失效（当前 token 会在返回时重新下发）
    updates.push("tokenVersion = tokenVersion + 1");
  }

  updates.push("updatedAt = datetime('now')");
  params.push(userId);

  try {
    db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  } catch (e: any) {
    if (String(e?.code || "").startsWith("SQLITE_CONSTRAINT") && String(e?.message || "").includes("username")) {
      return c.json({ error: "该用户名已被使用" }, 409);
    }
    throw e;
  }

  // 若修改了密码，为当前会话重新下发新 token，避免立即被自己失效
  //
  // Phase 6: 同时建立一条新的 user_sessions 记录（带 jti）。因为 bump tokenVersion
  // 会使旧 jti 对应的 token 在中间件里被拒（tver 不匹配），所以给当前端下发新 token 时
  // 也要分配一个新 sessionId。旧会话记录留在 DB 里，revokedAt 仍为 NULL 也无所谓——
  // 它们对应的 token 已经因 tver 不匹配而不可用。
  let newToken: string | undefined;
  if (newPassword) {
    const updated = db
      .prepare("SELECT id, username, tokenVersion FROM users WHERE id = ?")
      .get(userId) as { id: string; username: string; tokenVersion: number };
    const sessionId = createSession({
      userId: updated.id,
      ip: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "",
    });
    newToken = signLoginToken({
      userId: updated.id,
      username: updated.username,
      tokenVersion: updated.tokenVersion,
      jti: sessionId,
    });
  }

  return c.json({ success: true, message: "账户信息更新成功", token: newToken });
});

// ========== Sudo 二次验证（H2）==========
//
// 管理员对破坏性极强的操作（delete user、reset-password、role change、disable admin、
// factory-reset）必须先调用 /auth/sudo 输入当前密码，换取一张 5 分钟有效的 sudo token，
// 后续敏感请求通过 Header `X-Sudo-Token: <token>` 传递。
//
// 设计说明：
//   - 普通用户也可签发 sudo token，但当前只有 admin 路由强制校验（为未来扩展留口子）
//   - 同一账号连续失败 3 次以上走 IP 限流（checkAndIncrementIpRate 已在登录路径覆盖，
//     此处复用 IP 限流避免暴力探测密码）
//   - 不记录失败计数到 DB（避免通过乱刷 sudo 把自己账号锁了），仅 IP 限流
auth.post("/sudo", async (c) => {
  // 复用 IP 限流（这是一个与登录同等敏感的密码校验接口）
  const ip = extractClientIp(c);
  const ipBlocked = checkAndIncrementIpRate(ip);
  if (ipBlocked) {
    c.header("Retry-After", String(ipBlocked.retryAfterSec));
    return c.json(
      { error: `请求过于频繁，请 ${ipBlocked.retryAfterSec} 秒后重试`, code: "RATE_LIMITED" },
      429,
    );
  }

  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "未授权", code: "UNAUTHENTICATED" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const { password } = body as { password?: string };
  if (!password) return c.json({ error: "请输入当前密码" }, 400);

  const db = getDb();
  const user = db
    .prepare("SELECT id, username, passwordHash, tokenVersion, role FROM users WHERE id = ?")
    .get(userId) as { id: string; username: string; passwordHash: string; tokenVersion: number; role: string } | undefined;
  if (!user) return c.json({ error: "用户不存在" }, 404);

  if (!verifyPasswordCompat(password, user.passwordHash)) {
    logAudit(user.id, "auth", "sudo_failed", { role: user.role }, {
      ip,
      userAgent: c.req.header("user-agent") || "",
      level: "warn",
    });
    return c.json({ error: "密码错误", code: "SUDO_PASSWORD_WRONG" }, 403);
  }

  const sudoToken = signSudoToken(user.id, user.tokenVersion ?? 0);
  logAudit(user.id, "auth", "sudo_granted", { role: user.role, ttlSec: SUDO_TOKEN_TTL_SEC }, {
    ip,
    userAgent: c.req.header("user-agent") || "",
  });
  return c.json({ sudoToken, expiresIn: SUDO_TOKEN_TTL_SEC });
});

// ========== 恢复出厂设置（仅 admin，需要 sudo）==========

auth.post("/factory-reset", async (c) => {
  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "未授权" }, 401);

  const db = getDb();
  const me = db
    .prepare("SELECT id, username, role, tokenVersion FROM users WHERE id = ?")
    .get(userId) as { id: string; username: string; role: string; tokenVersion: number } | undefined;
  if (!me || me.role !== "admin") return c.json({ error: "仅管理员可恢复出厂设置" }, 403);

  // H2: sudo 二次验证
  const sudoRes = verifySudoFromRequest(c, me.id, me.tokenVersion ?? 0);
  if (!sudoRes.ok) {
    logAudit(me.id, "auth", "factory_reset_denied", { reason: sudoRes.reason }, {
      ip: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "",
      level: "warn",
    });
    return c.json(
      { error: sudoRes.message, code: sudoRes.code },
      sudoRes.status as any,
    );
  }

  const body = await c.req.json();
  const { confirmText } = body as { confirmText: string };

  if (confirmText !== "RESET") {
    return c.json({ error: "校验码不正确" }, 400);
  }

  // C4: 出厂默认密码改用 bcrypt；同时 mustChangePassword=1 强制首登修改；
  //     bump tokenVersion 让其他端已有的 token 全部失效。
  const defaultHash = await bcrypt.hash("admin123", 10);

  const resetTransaction = db.transaction(() => {
    db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
    db.prepare("DELETE FROM note_tags").run();
    db.prepare("DELETE FROM attachments").run();
    db.prepare("DELETE FROM tasks").run();
    db.prepare("DELETE FROM notes").run();
    db.prepare("DELETE FROM tags").run();
    db.prepare("DELETE FROM notebooks").run();
    db.prepare(
      `UPDATE users
       SET username = 'admin',
           passwordHash = ?,
           role = 'admin',
           isDisabled = 0,
           mustChangePassword = 1,
           failedLoginAttempts = 0,
           lastFailedLoginAt = NULL,
           lockedUntil = NULL,
           tokenVersion = tokenVersion + 1,
           updatedAt = datetime('now')
       WHERE id = ?`,
    ).run(defaultHash, userId);
  });

  try {
    resetTransaction();
    // 下发一张新 token，这样管理员当前 tab 不会立刻被踢下线。
    const updated = db
      .prepare("SELECT id, username, tokenVersion FROM users WHERE id = ?")
      .get(userId) as { id: string; username: string; tokenVersion: number };
    // Phase 6: factory-reset 会 bump tokenVersion，需要给当前端重新签一张带新 jti 的 token
    const sessionId = createSession({
      userId: updated.id,
      ip: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "",
    });
    const newToken = signLoginToken({
      userId: updated.id,
      username: updated.username,
      tokenVersion: updated.tokenVersion,
      jti: sessionId,
    });
    console.log("💥 系统已恢复出厂设置：数据已清空，密码已重置为 admin123（bcrypt），首登强制修改");
    // M6: 审计日志（高危操作，单独标 warn 级别以便筛选）
    logAudit(userId, "system", "factory_reset", { performedBy: me.username }, {
      ip: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "",
      targetType: "system",
      targetId: "global",
      level: "warn",
    });
    return c.json({
      success: true,
      message: "系统已恢复出厂设置，请立即修改默认密码 admin123",
      token: newToken,
      mustChangePassword: true,
    });
  } catch (error) {
    console.error("恢复出厂设置失败:", error);
    return c.json({ error: "恢复出厂设置失败" }, 500);
  }
});

// ========== 2FA（TOTP） ==========
//
// 流程：
//   1. 已登录用户调用 POST /auth/2fa/setup
//        服务端生成 base32 secret 但**暂不写入 users.twoFactorSecret**，只签一张短期
//        "pending" token（typ="2fa-setup"，5 分钟）。返回 secret 和 otpauth:// URI 供前端展示。
//        前端可以拿这个 URI 渲染二维码让用户用 Authenticator App 扫描。
//   2. 用户 App 里出现 6 位数，调用 POST /auth/2fa/activate 提交 (pending, code)
//        服务端先校验 pending token（里面就带着 secret，这样无需额外 DB 临时表），
//        再校验 code 对该 secret 合法，成功后写入 users.twoFactorSecret 并生成 8 个
//        一次性恢复码（hash 存储、明文只返回这一次）。
//   3. 关闭 2FA：POST /auth/2fa/disable，必须带 sudo token + 当前 TOTP（或 recovery code），
//        避免攻击者拿到 session 后直接关 2FA。
//   4. 登录第二步：POST /auth/2fa/verify，输入之前登录返回的 ticket + TOTP/恢复码，
//        成功后建 session 并下发真正的 login token。

/** 2FA setup pending token 的 payload */
interface TwoFaSetupTokenPayload {
  typ: "2fa-setup";
  userId: string;
  secret: string; // base32
  iat?: number;
  exp?: number;
}

/** 2FA login ticket（登录第一步颁发，第二步消费）的 payload */
interface TwoFaTicketPayload {
  typ: "2fa";
  userId: string;
  tver: number;
  iat?: number;
  exp?: number;
}

function verifyTwoFaSetupToken(token: string): TwoFaSetupTokenPayload | null {
  try {
    const p = jwt.verify(token, JWT_SECRET) as TwoFaSetupTokenPayload;
    if (p.typ !== "2fa-setup") return null;
    return p;
  } catch {
    return null;
  }
}

function verifyTwoFaTicket(token: string): TwoFaTicketPayload | null {
  try {
    const p = jwt.verify(token, JWT_SECRET) as TwoFaTicketPayload;
    if (p.typ !== "2fa") return null;
    return p;
  } catch {
    return null;
  }
}

/** 尝试用 recovery code 匹配并消费：命中则从 users.twoFactorBackupCodes 中移除对应条目 */
function consumeRecoveryCode(userId: string, input: string): boolean {
  if (!input) return false;
  const db = getDb();
  const row = db
    .prepare("SELECT twoFactorBackupCodes FROM users WHERE id = ?")
    .get(userId) as { twoFactorBackupCodes: string | null } | undefined;
  if (!row || !row.twoFactorBackupCodes) return false;
  let hashes: string[] = [];
  try {
    hashes = JSON.parse(row.twoFactorBackupCodes);
  } catch {
    return false;
  }
  const target = hashRecoveryCode(input);
  const idx = hashes.indexOf(target);
  if (idx < 0) return false;
  hashes.splice(idx, 1);
  db.prepare("UPDATE users SET twoFactorBackupCodes = ? WHERE id = ?").run(
    JSON.stringify(hashes),
    userId,
  );
  return true;
}

auth.post("/2fa/setup", async (c) => {
  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "未授权" }, 401);
  const db = getDb();
  const user = db
    .prepare("SELECT id, username, twoFactorSecret FROM users WHERE id = ?")
    .get(userId) as { id: string; username: string; twoFactorSecret: string | null } | undefined;
  if (!user) return c.json({ error: "用户不存在" }, 404);
  if (user.twoFactorSecret) {
    return c.json({ error: "已启用 2FA，如需重新绑定请先关闭", code: "TFA_ALREADY_ENABLED" }, 409);
  }

  const secret = generateTotpSecret();
  const otpauthUri = buildOtpAuthUri({
    issuer: "Nowen Note",
    account: user.username,
    secretBase32: secret,
  });
  // pending token 里直接带 secret（而不是写进 DB 临时表），5 分钟有效
  const pending = jwt.sign(
    { typ: "2fa-setup", userId, secret },
    JWT_SECRET,
    { expiresIn: "5m" },
  );
  return c.json({ secret, otpauthUri, pending });
});

auth.post("/2fa/activate", async (c) => {
  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "未授权" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { pending?: string; code?: string };
  if (!body.pending || !body.code) {
    return c.json({ error: "参数缺失" }, 400);
  }
  const payload = verifyTwoFaSetupToken(body.pending);
  if (!payload || payload.userId !== userId) {
    return c.json({ error: "绑定会话已失效，请重新生成二维码", code: "TFA_SETUP_EXPIRED" }, 400);
  }
  if (!verifyTotp(payload.secret, body.code)) {
    return c.json({ error: "验证码错误", code: "TFA_INVALID_CODE" }, 400);
  }

  const recoveryCodes = generateRecoveryCodes(8);
  const hashes = recoveryCodes.map(hashRecoveryCode);
  const db = getDb();
  db.prepare(
    `UPDATE users
     SET twoFactorSecret = ?, twoFactorEnabledAt = datetime('now'),
         twoFactorBackupCodes = ?, updatedAt = datetime('now')
     WHERE id = ?`,
  ).run(payload.secret, JSON.stringify(hashes), userId);

  logAudit(userId, "auth", "2fa_enabled", {}, {
    ip: extractClientIp(c),
    userAgent: c.req.header("user-agent") || "",
  });
  // 明文 recovery codes 只返回这一次
  return c.json({ success: true, recoveryCodes });
});

auth.post("/2fa/disable", async (c) => {
  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "未授权" }, 401);
  const db = getDb();
  const user = db
    .prepare("SELECT id, tokenVersion, twoFactorSecret FROM users WHERE id = ?")
    .get(userId) as { id: string; tokenVersion: number; twoFactorSecret: string | null } | undefined;
  if (!user) return c.json({ error: "用户不存在" }, 404);
  if (!user.twoFactorSecret) {
    return c.json({ error: "当前未启用 2FA" }, 400);
  }

  // 必须带 sudo：防止攻击者仅凭被盗的 session 就关掉 2FA
  const sudoRes = verifySudoFromRequest(c, user.id, user.tokenVersion ?? 0);
  if (!sudoRes.ok) {
    return c.json({ error: sudoRes.message, code: sudoRes.code }, sudoRes.status as any);
  }

  const body = (await c.req.json().catch(() => ({}))) as { code?: string };
  const code = (body.code || "").trim();
  // 可用 TOTP，也可用 recovery code
  const okTotp = !!code && verifyTotp(user.twoFactorSecret, code);
  const okRecovery = !okTotp && consumeRecoveryCode(user.id, code);
  if (!okTotp && !okRecovery) {
    return c.json({ error: "验证码错误", code: "TFA_INVALID_CODE" }, 400);
  }

  db.prepare(
    `UPDATE users
     SET twoFactorSecret = NULL, twoFactorEnabledAt = NULL, twoFactorBackupCodes = NULL,
         updatedAt = datetime('now')
     WHERE id = ?`,
  ).run(userId);

  logAudit(userId, "auth", "2fa_disabled", { via: okTotp ? "totp" : "recovery" }, {
    ip: extractClientIp(c),
    userAgent: c.req.header("user-agent") || "",
    level: "warn",
  });
  return c.json({ success: true });
});

auth.post("/2fa/verify", async (c) => {
  // 登录第二步：凭登录第一步颁发的 ticket + TOTP/恢复码，换取真正的 login token
  const body = (await c.req.json().catch(() => ({}))) as { ticket?: string; code?: string };
  if (!body.ticket || !body.code) {
    return c.json({ error: "参数缺失" }, 400);
  }
  const ticket = verifyTwoFaTicket(body.ticket);
  if (!ticket) {
    return c.json({ error: "登录会话已过期，请重新输入密码", code: "TFA_TICKET_EXPIRED" }, 401);
  }

  const db = getDb();
  const user = db
    .prepare(
      `SELECT id, username, email, avatarUrl, displayName, role, isDisabled,
              tokenVersion, mustChangePassword, twoFactorSecret, createdAt
       FROM users WHERE id = ?`,
    )
    .get(ticket.userId) as any;
  if (!user) return c.json({ error: "用户不存在" }, 404);
  if (user.isDisabled) {
    return c.json({ error: "该账号已被禁用", code: "ACCOUNT_DISABLED" }, 403);
  }
  // ticket 发放后若 tokenVersion 变化（改密、禁用），则拒绝
  if ((user.tokenVersion ?? 0) !== (ticket.tver ?? 0)) {
    return c.json({ error: "登录会话已失效，请重新输入密码", code: "TFA_TICKET_EXPIRED" }, 401);
  }
  if (!user.twoFactorSecret) {
    // 理论上不会命中：ticket 只在启用 2FA 时颁发。保险起见返回错误而非直接放行。
    return c.json({ error: "该账号未启用 2FA", code: "TFA_NOT_ENABLED" }, 400);
  }

  const code = (body.code || "").trim();
  const okTotp = verifyTotp(user.twoFactorSecret, code);
  const okRecovery = !okTotp && consumeRecoveryCode(user.id, code);
  if (!okTotp && !okRecovery) {
    logAudit(user.id, "auth", "2fa_verify_failed", {}, {
      ip: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "",
      level: "warn",
    });
    return c.json({ error: "验证码错误", code: "TFA_INVALID_CODE" }, 400);
  }

  // 登录成功：建 session、下发 token
  const sessionId = createSession({
    userId: user.id,
    ip: extractClientIp(c),
    userAgent: c.req.header("user-agent") || "",
  });
  const token = signLoginToken({
    userId: user.id,
    username: user.username,
    tokenVersion: user.tokenVersion ?? 0,
    jti: sessionId,
  });
  logAudit(user.id, "auth", "2fa_verify_ok", { via: okTotp ? "totp" : "recovery" }, {
    ip: extractClientIp(c),
    userAgent: c.req.header("user-agent") || "",
  });
  return c.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      displayName: user.displayName,
      role: user.role || "user",
      createdAt: user.createdAt,
      mustChangePassword: user.mustChangePassword ? true : undefined,
    },
  });
});

/** 返回当前用户 2FA 状态 + 剩余恢复码数量（不返回明文） */
auth.get("/2fa/status", (c) => {
  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "未授权" }, 401);
  const db = getDb();
  const row = db
    .prepare(
      `SELECT twoFactorSecret, twoFactorEnabledAt, twoFactorBackupCodes
       FROM users WHERE id = ?`,
    )
    .get(userId) as
    | { twoFactorSecret: string | null; twoFactorEnabledAt: string | null; twoFactorBackupCodes: string | null }
    | undefined;
  if (!row) return c.json({ error: "用户不存在" }, 404);
  let remaining = 0;
  if (row.twoFactorBackupCodes) {
    try {
      remaining = (JSON.parse(row.twoFactorBackupCodes) as string[]).length;
    } catch {
      /* ignore */
    }
  }
  return c.json({
    enabled: !!row.twoFactorSecret,
    enabledAt: row.twoFactorEnabledAt,
    recoveryCodesRemaining: remaining,
  });
});

/** 重新生成恢复码（作废旧的，必须带 sudo） */
auth.post("/2fa/regenerate-recovery-codes", async (c) => {
  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "未授权" }, 401);
  const db = getDb();
  const user = db
    .prepare("SELECT id, tokenVersion, twoFactorSecret FROM users WHERE id = ?")
    .get(userId) as { id: string; tokenVersion: number; twoFactorSecret: string | null } | undefined;
  if (!user) return c.json({ error: "用户不存在" }, 404);
  if (!user.twoFactorSecret) {
    return c.json({ error: "当前未启用 2FA" }, 400);
  }

  const sudoRes = verifySudoFromRequest(c, user.id, user.tokenVersion ?? 0);
  if (!sudoRes.ok) {
    return c.json({ error: sudoRes.message, code: sudoRes.code }, sudoRes.status as any);
  }

  const recoveryCodes = generateRecoveryCodes(8);
  const hashes = recoveryCodes.map(hashRecoveryCode);
  db.prepare("UPDATE users SET twoFactorBackupCodes = ? WHERE id = ?").run(
    JSON.stringify(hashes),
    userId,
  );
  logAudit(userId, "auth", "2fa_recovery_regenerated", {}, {
    ip: extractClientIp(c),
    userAgent: c.req.header("user-agent") || "",
  });
  return c.json({ recoveryCodes });
});

// ========== 会话管理 ==========
//
//   GET    /auth/sessions               列出当前用户的活跃会话
//   DELETE /auth/sessions                一键下线其他端（默认保留 current）
//   DELETE /auth/sessions/:id            下线指定 session
//
// 使用场景：用户在「安全设置」里看到所有正登录的设备；发现陌生设备立即吊销。
// 实现原则：吊销只更新 user_sessions.revokedAt，不 bump tokenVersion，这样**不会**误踢
// 其他端（比如想只下线手机而保留桌面端）。

auth.get("/sessions", (c) => {
  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "未授权" }, 401);

  // 当前请求的 session 从 Authorization 的 JWT 里解出，让前端可以标注"当前设备"
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const payload = token ? verifyLoginToken(token) : null;
  const currentSessionId = payload?.jti || null;

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, createdAt, lastSeenAt, expiresAt, ip, userAgent, deviceLabel
       FROM user_sessions
       WHERE userId = ? AND revokedAt IS NULL
         AND (expiresAt IS NULL OR datetime(expiresAt) > datetime('now'))
       ORDER BY lastSeenAt DESC`,
    )
    .all(userId) as Array<{
      id: string;
      createdAt: string;
      lastSeenAt: string;
      expiresAt: string | null;
      ip: string;
      userAgent: string;
      deviceLabel: string | null;
    }>;

  return c.json({
    sessions: rows.map((r) => ({
      ...r,
      current: r.id === currentSessionId,
    })),
    currentSessionId,
  });
});

auth.delete("/sessions/:id", (c) => {
  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "未授权" }, 401);
  const sessionId = c.req.param("id");
  const db = getDb();
  const sess = db
    .prepare("SELECT id, userId, revokedAt FROM user_sessions WHERE id = ?")
    .get(sessionId) as { id: string; userId: string; revokedAt: string | null } | undefined;
  if (!sess || sess.userId !== userId) {
    return c.json({ error: "会话不存在" }, 404);
  }
  if (sess.revokedAt) {
    return c.json({ success: true, alreadyRevoked: true });
  }
  revokeSession(sessionId, "user_revoked");
  logAudit(userId, "auth", "session_revoked", { sessionId }, {
    ip: extractClientIp(c),
    userAgent: c.req.header("user-agent") || "",
  });
  return c.json({ success: true });
});

/** 一键下线：默认保留当前 session（?keepCurrent=0 可全部下线） */
auth.delete("/sessions", (c) => {
  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "未授权" }, 401);

  const keepCurrent = c.req.query("keepCurrent") !== "0";
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const payload = token ? verifyLoginToken(token) : null;
  const currentSessionId = payload?.jti || null;

  const db = getDb();
  let info;
  if (keepCurrent && currentSessionId) {
    info = db
      .prepare(
        `UPDATE user_sessions
         SET revokedAt = datetime('now'), revokedReason = 'user_bulk_revoked'
         WHERE userId = ? AND revokedAt IS NULL AND id != ?`,
      )
      .run(userId, currentSessionId);
  } else {
    info = db
      .prepare(
        `UPDATE user_sessions
         SET revokedAt = datetime('now'), revokedReason = 'user_bulk_revoked'
         WHERE userId = ? AND revokedAt IS NULL`,
      )
      .run(userId);
  }
  logAudit(userId, "auth", "session_bulk_revoked", { count: info.changes, keepCurrent }, {
    ip: extractClientIp(c),
    userAgent: c.req.header("user-agent") || "",
  });
  return c.json({ success: true, revoked: info.changes });
});

// ========== 登出（吊销当前会话） ==========
//
// 前端在本地清 token 的同时调用此接口，确保服务端的 user_sessions 也被吊销，
// 这样即使 token 未过期被复用（如日志泄露、浏览器缓存），中间件依旧会拦截。
auth.post("/logout", (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ success: true });
  }
  const token = authHeader.slice(7);
  const payload = verifyLoginToken(token);
  if (payload?.jti) {
    revokeSession(payload.jti, "user_logout");
  }
  return c.json({ success: true });
});

// ========== 验证 token（前端刷新时调用） ==========

auth.get("/verify", (c) => {
  const userId = extractUserId(c);
  if (!userId) return c.json({ error: "Token 无效或已过期", code: "TOKEN_INVALID" }, 401);

  const db = getDb();
  const user = db
    .prepare(
      `SELECT id, username, email, avatarUrl, displayName, role, isDisabled, mustChangePassword, createdAt
       FROM users WHERE id = ?`,
    )
    .get(userId) as any;

  if (!user) return c.json({ error: "用户不存在", code: "USER_NOT_FOUND" }, 401);
  if (user.isDisabled) return c.json({ error: "该账号已被禁用", code: "ACCOUNT_DISABLED" }, 403);

  const { isDisabled, mustChangePassword, ...safe } = user;
  return c.json({
    user: {
      ...safe,
      role: safe.role || "user",
      mustChangePassword: mustChangePassword ? true : undefined,
    },
  });
});

export { JWT_SECRET, JWT_EXPIRES_IN };
export default auth;
