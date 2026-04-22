/**
 * 用户管理路由
 *
 * 所有已登录用户：
 *   GET  /api/users/search?q=xxx      - 搜索用户（最多 20 条，仅返回公开字段，供 @提及 / 邀请）
 *
 * 仅管理员：
 *   GET    /api/users                 - 用户列表
 *   POST   /api/users                 - 创建用户
 *   PATCH  /api/users/:id             - 更新用户资料（username / email / displayName / role / isDisabled）
 *   POST   /api/users/:id/reset-password - 管理员重置某用户密码
 *   DELETE /api/users/:id             - 删除用户（不可删除自己；不可删除最后一个管理员）
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import { getDb } from "../db/schema";
import { isSystemAdmin, requireAdmin } from "../middleware/acl";
import { invalidateUserAuthCache, verifySudoFromRequest, extractClientIp } from "../lib/auth-security";
import { disconnectUser } from "../services/realtime";
import { logAudit } from "../services/audit";

const users = new Hono();

const USERNAME_REGEX = /^[A-Za-z0-9_\-.]{3,32}$/;

/**
 * H2: 管理员敏感操作的 sudo 二次验证封装。
 *     要求调用方已通过 requireAdmin 中间件，c.req 的 X-User-Id 是当前 admin。
 *     成功返回 null；失败返回 Response（调用方直接 return）。
 *
 * M6: 同时负责记录 "denied" 审计日志，便于事后追查"未通过二次验证的尝试"。
 */
function requireSudoOrDeny(
  c: any,
  action: string,
  targetInfo: { targetType: string; targetId: string; details?: Record<string, any> },
): Response | null {
  const adminId = c.req.header("X-User-Id") || "";
  const db = getDb();
  const admin = db
    .prepare("SELECT id, tokenVersion FROM users WHERE id = ?")
    .get(adminId) as { id: string; tokenVersion: number } | undefined;
  if (!admin) return c.json({ error: "管理员账号不存在" }, 401);

  const res = verifySudoFromRequest(c, admin.id, admin.tokenVersion ?? 0);
  if (!res.ok) {
    logAudit(
      adminId,
      "system",
      `${action}_denied`,
      { reason: res.reason, ...(targetInfo.details || {}) },
      {
        ip: extractClientIp(c),
        userAgent: c.req.header("user-agent") || "",
        targetType: targetInfo.targetType,
        targetId: targetInfo.targetId,
        level: "warn",
      },
    );
    return c.json({ error: res.message, code: res.code }, res.status as any);
  }
  return null;
}

type UserRow = {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  isDisabled: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

// 所有登录用户：搜索用户（供 @ 提及 / 邀请等场景使用）
users.get("/search", (c) => {
  const q = (c.req.query("q") || "").trim();
  const db = getDb();
  const limit = 20;

  let rows: Pick<UserRow, "id" | "username" | "displayName" | "avatarUrl">[];
  if (!q) {
    rows = db
      .prepare(
        `SELECT id, username, displayName, avatarUrl FROM users
         WHERE isDisabled = 0
         ORDER BY username ASC LIMIT ?`,
      )
      .all(limit) as any;
  } else {
    const like = `%${q}%`;
    rows = db
      .prepare(
        `SELECT id, username, displayName, avatarUrl FROM users
         WHERE isDisabled = 0
           AND (username LIKE ? OR displayName LIKE ? OR email LIKE ?)
         ORDER BY
           CASE WHEN username = ? THEN 0
                WHEN username LIKE ? THEN 1
                ELSE 2 END,
           username ASC
         LIMIT ?`,
      )
      .all(like, like, like, q, `${q}%`, limit) as any;
  }

  return c.json(rows);
});

// ========== 以下为管理员专属 ==========

users.get("/", requireAdmin, (c) => {
  const db = getDb();
  const search = (c.req.query("q") || "").trim();
  const role = (c.req.query("role") || "").trim();
  const status = (c.req.query("status") || "").trim(); // 'active' | 'disabled' | ''

  const conds: string[] = [];
  const params: any[] = [];
  if (search) {
    conds.push("(username LIKE ? OR email LIKE ? OR displayName LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (role === "admin" || role === "user") {
    conds.push("role = ?");
    params.push(role);
  }
  if (status === "active") conds.push("isDisabled = 0");
  if (status === "disabled") conds.push("isDisabled = 1");

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT id, username, email, displayName, avatarUrl, role, isDisabled,
              createdAt, updatedAt, lastLoginAt,
              (SELECT COUNT(*) FROM notes n WHERE n.userId = users.id AND n.isTrashed = 0) as noteCount,
              (SELECT COUNT(*) FROM notebooks nb WHERE nb.userId = users.id) as notebookCount
       FROM users ${where}
       ORDER BY createdAt ASC`,
    )
    .all(...params);
  return c.json(rows);
});

// 创建用户
users.post("/", requireAdmin, async (c) => {
  const adminId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const { username, password, email, displayName, role } = body as {
    username: string;
    password: string;
    email?: string;
    displayName?: string;
    role?: "admin" | "user";
  };

  if (!username || !USERNAME_REGEX.test(username.trim())) {
    return c.json({ error: "用户名需为 3-32 位字母/数字/_/-/." }, 400);
  }
  if (!password || password.length < 6) {
    return c.json({ error: "密码长度至少为 6 位" }, 400);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "邮箱格式不正确" }, 400);
  }
  const finalRole = role === "admin" ? "admin" : "user";

  // H2: 创建管理员账号属于高危操作，需要 sudo；普通用户则不必阻塞日常管理
  if (finalRole === "admin") {
    const denied = requireSudoOrDeny(c, "user_create_admin", {
      targetType: "user",
      targetId: "(new)",
      details: { username: username.trim() },
    });
    if (denied) return denied;
  }

  const db = getDb();
  const id = uuid();
  const passwordHash = await bcrypt.hash(password, 10);

  // C5/H5: 依赖 users.username / users.email 的 UNIQUE 约束兜底，避免 TOCTOU
  try {
    db.prepare(
      `INSERT INTO users (id, username, email, passwordHash, displayName, role)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, username.trim(), email?.trim() || null, passwordHash, displayName?.trim() || null, finalRole);
  } catch (e: any) {
    if (String(e?.code || "").startsWith("SQLITE_CONSTRAINT")) {
      const msg = String(e?.message || "");
      if (msg.includes("users.email")) return c.json({ error: "该邮箱已被注册" }, 409);
      if (msg.includes("users.username")) return c.json({ error: "该用户名已被占用" }, 409);
      return c.json({ error: "用户名或邮箱已被占用" }, 409);
    }
    throw e;
  }

  const user = db
    .prepare(
      `SELECT id, username, email, displayName, avatarUrl, role, isDisabled, createdAt, updatedAt, lastLoginAt
       FROM users WHERE id = ?`,
    )
    .get(id);

  // M6: 审计日志
  logAudit(
    adminId,
    "system",
    "user_create",
    { username: username.trim(), email: email?.trim() || null, role: finalRole },
    {
      ip: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "",
      targetType: "user",
      targetId: id,
    },
  );

  return c.json(user, 201);
});

// 更新用户
users.patch("/:id", requireAdmin, async (c) => {
  const db = getDb();
  const currentUserId = c.req.header("X-User-Id") || "";
  const targetId = c.req.param("id");
  const body = await c.req.json();

  const target = db.prepare("SELECT id, username, role, isDisabled FROM users WHERE id = ?").get(targetId) as
    | { id: string; username: string; role: string; isDisabled: number }
    | undefined;
  if (!target) return c.json({ error: "用户不存在" }, 404);

  // H2: 高危字段变更（role、isDisabled）要求 sudo
  const isHighRisk = body.role !== undefined || body.isDisabled !== undefined;
  if (isHighRisk) {
    const denied = requireSudoOrDeny(c, "user_update_sensitive", {
      targetType: "user",
      targetId,
      details: {
        targetUsername: target.username,
        roleChange: body.role !== undefined ? { from: target.role, to: body.role } : undefined,
        disableChange: body.isDisabled !== undefined ? !!body.isDisabled : undefined,
      },
    });
    if (denied) return denied;
  }

  const fields: string[] = [];
  const params: any[] = [];

  if (body.username !== undefined) {
    if (!USERNAME_REGEX.test(String(body.username).trim())) {
      return c.json({ error: "用户名需为 3-32 位字母/数字/_/-/." }, 400);
    }
    fields.push("username = ?");
    params.push(String(body.username).trim());
  }

  if (body.email !== undefined) {
    const email = body.email ? String(body.email).trim() : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: "邮箱格式不正确" }, 400);
    }
    fields.push("email = ?");
    params.push(email);
  }

  if (body.displayName !== undefined) {
    fields.push("displayName = ?");
    params.push(body.displayName ? String(body.displayName).trim() : null);
  }

  let roleChanged = false;
  if (body.role !== undefined) {
    if (body.role !== "admin" && body.role !== "user") {
      return c.json({ error: "角色必须是 admin 或 user" }, 400);
    }
    // 不允许把最后一个管理员降级为普通用户
    if (target.role === "admin" && body.role !== "admin") {
      const { c: adminCount } = db
        .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'")
        .get() as { c: number };
      if (adminCount <= 1) {
        return c.json({ error: "至少需要保留一个管理员" }, 400);
      }
    }
    if (body.role !== target.role) roleChanged = true;
    fields.push("role = ?");
    params.push(body.role);
  }

  let nowDisabled = false;
  if (body.isDisabled !== undefined) {
    const disabled = body.isDisabled ? 1 : 0;
    // 不允许禁用自己
    if (disabled && targetId === currentUserId) {
      return c.json({ error: "不能禁用自己" }, 400);
    }
    // 不允许禁用最后一个活跃管理员
    if (disabled && target.role === "admin") {
      const { c: activeAdmins } = db
        .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND isDisabled = 0 AND id != ?")
        .get(targetId) as { c: number };
      if (activeAdmins === 0) {
        return c.json({ error: "至少需要保留一个启用的管理员" }, 400);
      }
    }
    fields.push("isDisabled = ?");
    params.push(disabled);
    if (disabled && !target.isDisabled) nowDisabled = true;
  }

  if (fields.length === 0) return c.json({ error: "没有可更新的字段" }, 400);

  // C3: 禁用用户 / 角色变更 时，bump tokenVersion 让其所有旧 JWT 立即失效
  if (nowDisabled || roleChanged) {
    fields.push("tokenVersion = tokenVersion + 1");
  }

  fields.push("updatedAt = datetime('now')");
  params.push(targetId);

  try {
    db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  } catch (e: any) {
    if (String(e?.code || "").startsWith("SQLITE_CONSTRAINT")) {
      const msg = String(e?.message || "");
      if (msg.includes("users.email")) return c.json({ error: "该邮箱已被注册" }, 409);
      if (msg.includes("users.username")) return c.json({ error: "该用户名已被占用" }, 409);
      return c.json({ error: "用户名或邮箱已被占用" }, 409);
    }
    throw e;
  }

  // 清缓存 + 踢 WS 下线（不阻塞响应）
  invalidateUserAuthCache(targetId);
  if (nowDisabled) {
    try { disconnectUser(targetId, "account_disabled"); } catch {}
  } else if (roleChanged) {
    try { disconnectUser(targetId, "session_revoked"); } catch {}
  }

  // M6: 审计日志
  logAudit(
    currentUserId,
    "system",
    "user_update",
    {
      targetUsername: target.username,
      changed: {
        username: body.username !== undefined,
        email: body.email !== undefined,
        displayName: body.displayName !== undefined,
        role: roleChanged ? { from: target.role, to: body.role } : undefined,
        disabled: nowDisabled
          ? "disabled"
          : (body.isDisabled !== undefined && !body.isDisabled && target.isDisabled)
            ? "enabled"
            : undefined,
      },
    },
    {
      ip: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "",
      targetType: "user",
      targetId,
      level: nowDisabled || roleChanged ? "warn" : "info",
    },
  );

  const user = db
    .prepare(
      `SELECT id, username, email, displayName, avatarUrl, role, isDisabled, createdAt, updatedAt, lastLoginAt
       FROM users WHERE id = ?`,
    )
    .get(targetId);
  return c.json(user);
});

// 管理员重置某用户密码
users.post("/:id/reset-password", requireAdmin, async (c) => {
  const db = getDb();
  const currentUserId = c.req.header("X-User-Id") || "";
  const targetId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { newPassword } = body as { newPassword: string };

  if (!newPassword || newPassword.length < 6) {
    return c.json({ error: "新密码长度至少为 6 位" }, 400);
  }
  const target = db
    .prepare("SELECT id, username FROM users WHERE id = ?")
    .get(targetId) as { id: string; username: string } | undefined;
  if (!target) return c.json({ error: "用户不存在" }, 404);

  // H2: 重置他人密码属于高危操作，必须 sudo
  const denied = requireSudoOrDeny(c, "user_reset_password", {
    targetType: "user",
    targetId,
    details: { targetUsername: target.username },
  });
  if (denied) return denied;

  const hash = await bcrypt.hash(newPassword, 10);
  // C3: 改密后 bump tokenVersion，清理登录失败计数与账号锁
  db.prepare(
    `UPDATE users
     SET passwordHash = ?,
         tokenVersion = tokenVersion + 1,
         failedLoginAttempts = 0,
         lastFailedLoginAt = NULL,
         lockedUntil = NULL,
         updatedAt = datetime('now')
     WHERE id = ?`,
  ).run(hash, targetId);

  invalidateUserAuthCache(targetId);
  try { disconnectUser(targetId, "password_reset"); } catch {}

  // M6: 审计日志（warn 级别，方便从大量 info 中快速检索）
  logAudit(
    currentUserId,
    "system",
    "user_reset_password",
    { targetUsername: target.username },
    {
      ip: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "",
      targetType: "user",
      targetId,
      level: "warn",
    },
  );

  return c.json({ success: true });
});

/**
 * L3：删除用户前预览将要清理/转移的数据量。
 *    GET /api/users/:id/data-summary
 *    返回：{ notebooks, notes, tags, tasks, diaries, shares, ownedWorkspaces,
 *           workspaceMemberships, noteVersions, shareComments, attachments }
 *
 *    UI 删除对话框用来给管理员展示"此次会影响多少数据"，并据此决定是否改成"转移给 XX"。
 */
users.get("/:id/data-summary", requireAdmin, (c) => {
  const db = getDb();
  const targetId = c.req.param("id");
  const target = db.prepare("SELECT id, username FROM users WHERE id = ?").get(targetId) as
    | { id: string; username: string }
    | undefined;
  if (!target) return c.json({ error: "用户不存在" }, 404);

  const count = (sql: string, ...p: any[]) =>
    (db.prepare(sql).get(...p) as { c: number }).c;

  return c.json({
    userId: target.id,
    username: target.username,
    notebooks: count("SELECT COUNT(*) as c FROM notebooks WHERE userId = ?", targetId),
    notes: count("SELECT COUNT(*) as c FROM notes WHERE userId = ?", targetId),
    tags: count("SELECT COUNT(*) as c FROM tags WHERE userId = ?", targetId),
    tasks: count("SELECT COUNT(*) as c FROM tasks WHERE userId = ?", targetId),
    diaries: count("SELECT COUNT(*) as c FROM diaries WHERE userId = ?", targetId),
    shares: count("SELECT COUNT(*) as c FROM shares WHERE ownerId = ?", targetId),
    ownedWorkspaces: count("SELECT COUNT(*) as c FROM workspaces WHERE ownerId = ?", targetId),
    workspaceMemberships: count("SELECT COUNT(*) as c FROM workspace_members WHERE userId = ?", targetId),
    noteVersions: count("SELECT COUNT(*) as c FROM note_versions WHERE userId = ?", targetId),
    shareComments: count("SELECT COUNT(*) as c FROM share_comments WHERE userId = ?", targetId),
    attachments: count("SELECT COUNT(*) as c FROM attachments WHERE userId = ?", targetId),
  });
});

/**
 * L3：把被删用户的全部数据所有权迁移到另一个用户，再删除原账号。
 *
 * 适用场景：员工离职，资料需保留给接任者；合并账号。
 *
 * 调用方式：
 *    DELETE /api/users/:id                         — 删除用户 + 级联清理所有数据（原行为）
 *    DELETE /api/users/:id?transferTo=<userId>     — 先把 N 张表的 userId/ownerId 改写到目标用户，再删原用户
 *    DELETE /api/users/:id  body:{transferTo}      — 同上，兼容 body 方式（某些客户端 DELETE 不便带 query）
 *
 * 迁移覆盖表：
 *    notebooks.userId, notes.userId, tags.userId*, tasks.userId, diaries.userId,
 *    shares.ownerId, note_versions.userId, share_comments.userId, attachments.userId,
 *    workspaces.ownerId, workspace_members.userId**, workspace_invites.createdBy,
 *    note_acl.userId**, note_yupdates.userId
 *
 *    *  tags 存在 UNIQUE(userId,name) 约束：对接收方已存在同名标签时，需要重写 note_tags
 *       的 tagId 指向后再丢弃旧 tag 行，避免 UNIQUE 冲突。
 *    ** workspace_members 与 note_acl 的主键含 userId：若接收方已是同一工作区/笔记的成员，
 *       直接改写主键会 UNIQUE 冲突，需保留接收方那一行，删除原用户那一行。
 */
function transferAndDeleteUser(
  db: import("better-sqlite3").Database,
  fromId: string,
  toId: string,
): { moved: Record<string, number> } {
  const moved: Record<string, number> = {};

  const run = (sql: string, ...params: any[]) => {
    const r = db.prepare(sql).run(...params);
    return r.changes;
  };

  const tx = db.transaction(() => {
    // --- 1) tags：先处理重名冲突，避免 UNIQUE(userId,name) ---
    // 把 fromId 的 tag 若在 toId 下已同名存在，先把 note_tags 的 tagId 指到 toId 的 tag，再删原 tag。
    const conflictTags = db
      .prepare(
        `SELECT a.id AS fromTagId, b.id AS toTagId
         FROM tags a
         JOIN tags b ON b.userId = ? AND b.name = a.name
         WHERE a.userId = ?`,
      )
      .all(toId, fromId) as { fromTagId: string; toTagId: string }[];

    let tagsMergedNoteLinks = 0;
    for (const { fromTagId, toTagId } of conflictTags) {
      // 把原 tag 上的 note_tags 关联迁到目标 tag；若 (noteId, toTagId) 已存在则忽略。
      tagsMergedNoteLinks += run(
        `INSERT OR IGNORE INTO note_tags (noteId, tagId)
         SELECT noteId, ? FROM note_tags WHERE tagId = ?`,
        toTagId,
        fromTagId,
      );
      // 清掉原关联 + 原 tag（tags 的 FK 是 CASCADE，但此处直接改 tags.userId 会冲突，所以先删）
      run("DELETE FROM note_tags WHERE tagId = ?", fromTagId);
      run("DELETE FROM tags WHERE id = ?", fromTagId);
    }
    // 剩余无冲突的 tags 直接改 ownership
    moved.tags = run("UPDATE tags SET userId = ? WHERE userId = ?", toId, fromId);
    moved.tagsMergedNoteLinks = tagsMergedNoteLinks;

    // --- 2) workspace_members：PK(workspaceId, userId) 冲突时保留接收方的那一行 ---
    const memberConflicts = db
      .prepare(
        `SELECT workspaceId FROM workspace_members
         WHERE userId = ? AND workspaceId IN (SELECT workspaceId FROM workspace_members WHERE userId = ?)`,
      )
      .all(fromId, toId) as { workspaceId: string }[];
    for (const { workspaceId } of memberConflicts) {
      // 接收方已是成员：直接删掉被删用户那一行（保留接收方更高/已确认的 role）
      run("DELETE FROM workspace_members WHERE workspaceId = ? AND userId = ?", workspaceId, fromId);
    }
    moved.workspaceMemberships = run(
      "UPDATE workspace_members SET userId = ? WHERE userId = ?",
      toId,
      fromId,
    );

    // --- 3) note_acl：PK(noteId, userId) 同上 ---
    const aclConflicts = db
      .prepare(
        `SELECT noteId FROM note_acl
         WHERE userId = ? AND noteId IN (SELECT noteId FROM note_acl WHERE userId = ?)`,
      )
      .all(fromId, toId) as { noteId: string }[];
    for (const { noteId } of aclConflicts) {
      run("DELETE FROM note_acl WHERE noteId = ? AND userId = ?", noteId, fromId);
    }
    moved.noteAcl = run("UPDATE note_acl SET userId = ? WHERE userId = ?", toId, fromId);

    // --- 4) 其他表的简单 ownership 迁移 ---
    moved.notebooks = run("UPDATE notebooks SET userId = ? WHERE userId = ?", toId, fromId);
    moved.notes = run("UPDATE notes SET userId = ? WHERE userId = ?", toId, fromId);
    moved.tasks = run("UPDATE tasks SET userId = ? WHERE userId = ?", toId, fromId);
    moved.diaries = run("UPDATE diaries SET userId = ? WHERE userId = ?", toId, fromId);
    moved.shares = run("UPDATE shares SET ownerId = ? WHERE ownerId = ?", toId, fromId);
    moved.noteVersions = run(
      "UPDATE note_versions SET userId = ? WHERE userId = ?",
      toId,
      fromId,
    );
    moved.shareComments = run(
      "UPDATE share_comments SET userId = ? WHERE userId = ?",
      toId,
      fromId,
    );
    moved.attachments = run(
      "UPDATE attachments SET userId = ? WHERE userId = ?",
      toId,
      fromId,
    );
    moved.ownedWorkspaces = run(
      "UPDATE workspaces SET ownerId = ? WHERE ownerId = ?",
      toId,
      fromId,
    );
    moved.workspaceInvites = run(
      "UPDATE workspace_invites SET createdBy = ? WHERE createdBy = ?",
      toId,
      fromId,
    );
    // note_yupdates.userId 没有 FK 但仍是 ownership 标记
    moved.noteYUpdates = run(
      "UPDATE note_yupdates SET userId = ? WHERE userId = ?",
      toId,
      fromId,
    );

    // --- 5) 最后删除原用户（此时 ON DELETE CASCADE 链上已无残留数据） ---
    run("DELETE FROM users WHERE id = ?", fromId);
  });

  tx();
  return { moved };
}

// 删除用户
users.delete("/:id", requireAdmin, async (c) => {
  const db = getDb();
  const currentUserId = c.req.header("X-User-Id") || "";
  const targetId = c.req.param("id");

  // L3: 支持通过 ?transferTo= 或 body.transferTo 指定数据接收人
  const transferToQuery = c.req.query("transferTo") || "";
  let transferToBody = "";
  if (!transferToQuery) {
    try {
      const body = await c.req.json();
      if (body && typeof body.transferTo === "string") transferToBody = body.transferTo;
    } catch {
      /* DELETE 不带 body 是合法的 */
    }
  }
  const transferTo = (transferToQuery || transferToBody).trim();

  if (targetId === currentUserId) {
    return c.json({ error: "不能删除自己" }, 400);
  }
  const target = db
    .prepare("SELECT id, username, role FROM users WHERE id = ?")
    .get(targetId) as { id: string; username: string; role: string } | undefined;
  if (!target) return c.json({ error: "用户不存在" }, 404);

  if (target.role === "admin") {
    const { c: adminCount } = db
      .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'")
      .get() as { c: number };
    if (adminCount <= 1) {
      return c.json({ error: "至少需要保留一个管理员" }, 400);
    }
  }

  // L3: 校验 transferTo 合法性
  let receiver: { id: string; username: string; isDisabled: number } | undefined;
  if (transferTo) {
    if (transferTo === targetId) {
      return c.json({ error: "不能把数据转移给待删除用户本身" }, 400);
    }
    receiver = db
      .prepare("SELECT id, username, isDisabled FROM users WHERE id = ?")
      .get(transferTo) as { id: string; username: string; isDisabled: number } | undefined;
    if (!receiver) return c.json({ error: "数据接收人不存在" }, 400);
    if (receiver.isDisabled) {
      return c.json({ error: "数据接收人已被禁用，请先启用后再进行转移" }, 400);
    }
  }

  // H2: 删除用户是不可逆破坏性操作，必须 sudo
  const denied = requireSudoOrDeny(c, "user_delete", {
    targetType: "user",
    targetId,
    details: {
      targetUsername: target.username,
      targetRole: target.role,
      transferTo: receiver?.username,
    },
  });
  if (denied) return denied;

  let moved: Record<string, number> | undefined;
  if (receiver) {
    // L3 分支：先迁移再删除，全部在单个事务中完成，不会出现半迁移半删除的中间态。
    const r = transferAndDeleteUser(db, targetId, receiver.id);
    moved = r.moved;
  } else {
    // 原有路径：直接 DELETE，users 表的 ON DELETE CASCADE 连带清理 notebooks/notes/...
    db.prepare("DELETE FROM users WHERE id = ?").run(targetId);
  }

  // 清缓存 + 踢该用户所有活跃 WS 连接下线
  invalidateUserAuthCache(targetId);
  try { disconnectUser(targetId, "account_deleted"); } catch {}
  // 接收方的 ACL / workspace 关系变更，缓存也要清，避免他读到陈旧权限判断
  if (receiver) {
    invalidateUserAuthCache(receiver.id);
  }

  // M6: 审计日志（warn 级别）
  logAudit(
    currentUserId,
    "system",
    receiver ? "user_delete_with_transfer" : "user_delete",
    {
      targetUsername: target.username,
      targetRole: target.role,
      transferTo: receiver ? { id: receiver.id, username: receiver.username } : undefined,
      moved,
    },
    {
      ip: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "",
      targetType: "user",
      targetId,
      level: "warn",
    },
  );

  return c.json({ success: true, transferred: !!receiver, moved });
});

export default users;
