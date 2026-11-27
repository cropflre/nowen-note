/**
 * 工作区路由（Phase 1 - 多用户协作）
 *
 * 端点：
 *   GET    /api/workspaces                - 当前用户可访问的所有工作区
 *   GET    /api/workspaces/all            - [系统管理员] 所有工作区（运维面板用）
 *   POST   /api/workspaces                - 创建工作区
 *   GET    /api/workspaces/:id            - 查看工作区详情（系统管理员旁路）
 *   PUT    /api/workspaces/:id            - 更新工作区（owner/admin / 系统管理员）
 *   DELETE /api/workspaces/:id            - 删除工作区（owner / 系统管理员）
 *
 *   GET    /api/workspaces/:id/members    - 成员列表（系统管理员旁路）
 *   PUT    /api/workspaces/:id/members/:userId  - 修改成员角色（owner/admin / 系统管理员）
 *   DELETE /api/workspaces/:id/members/:userId  - 移除成员（owner/admin / 系统管理员）
 *   POST   /api/workspaces/:id/leave      - 主动退出工作区
 *
 *   POST   /api/workspaces/:id/invites    - 生成邀请码（owner/admin / 系统管理员）
 *   GET    /api/workspaces/:id/invites    - 查看邀请码列表（owner/admin / 系统管理员）
 *   DELETE /api/workspaces/:id/invites/:inviteId - 撤销邀请码
 *   POST   /api/workspaces/join           - 使用邀请码加入
 *
 * 系统管理员（users.role='admin'）通过 requireWorkspaceRole 内的旁路逻辑，
 * 视同任意工作区的 owner，可执行所有写操作；这是"运维兜底"语义。
 */
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import {
  getUserWorkspaceRole,
  isSystemAdmin,
  requireAdmin,
  requireWorkspaceRole,
  resolveWorkspaceFeatures,
  WorkspaceRole,
  type EnabledFeaturesConfig,
  type WorkspaceFeature,
} from "../middleware/acl";
import { workspaceInvitesRepository, noteAclRepository, workspaceMembersRepository } from "../repositories";
import {
  normalizeWorkspaceIcon,
  workspaceIconForRead,
} from "../lib/workspace-icon";
import { broadcastToUser } from "../services/realtime";
import { transferWorkspaceNotesToOwner } from "../services/workspace-deletion";

const app = new Hono();

function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  let code = "";
  for (let i = 0; i < 10; i++) {
    code += chars.charAt(bytes[i] % chars.length);
  }
  return code;
}

function isOwnerOrSystemAdmin(workspaceId: string, userId: string): boolean {
  return isSystemAdmin(userId) || getUserWorkspaceRole(workspaceId, userId) === "owner";
}

function broadcastWorkspaceMembershipChanged(
  userIds: string[],
  payload: {
    workspaceId: string;
    workspaceName?: string;
    action: "added" | "role_updated" | "removed" | "deleted" | "owner_transferred";
    role?: WorkspaceRole;
  },
): void {
  const uniqueIds = new Set(userIds.filter(Boolean));
  for (const uid of uniqueIds) {
    broadcastToUser(uid, {
      type: "workspace:membership-changed",
      ...payload,
    } as any);
  }
}

function normalizeWorkspaceRow<T extends Record<string, any>>(row: T): T {
  return { ...row, icon: workspaceIconForRead(row.icon) };
}

function broadcastWorkspaceProfileUpdated(workspaceId: string, workspace: Record<string, any>): void {
  const members = workspaceMembersRepository.listByWorkspaceWithUser(workspaceId) as Array<{ userId?: string }>;
  for (const member of members) {
    if (!member.userId) continue;
    broadcastToUser(member.userId, {
      type: "workspace:updated",
      workspaceId,
      workspace,
    } as any);
  }
}

// ===================== 工作区 CRUD =====================

// 获取当前用户的所有工作区（包括自己拥有的 + 受邀加入的）
app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";

  const rows = db
    .prepare(
      `
      SELECT w.*, m.role,
             (SELECT COUNT(*) FROM workspace_members WHERE workspaceId = w.id) AS memberCount,
             (SELECT COUNT(*) FROM notebooks WHERE workspaceId = w.id) AS notebookCount
      FROM workspaces w
      JOIN workspace_members m ON m.workspaceId = w.id
      WHERE m.userId = ?
      ORDER BY w.createdAt ASC
    `,
    )
    .all(userId) as Array<Record<string, any>>;

  return c.json(rows.map(normalizeWorkspaceRow));
});

// 系统管理员：列出所有工作区（包含自己未加入的），用于"工作区管理"面板
//   - 必须放在 /:id 之前，否则会被 :id 路由吃掉
//   - 返回字段比 GET / 多 ownerName / ownerUsername，便于列表渲染
app.get("/all", requireAdmin, (c) => {
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT w.*,
             u.username AS ownerUsername,
             COALESCE(NULLIF(u.displayName, ''), u.username) AS ownerName,
             (SELECT COUNT(*) FROM workspace_members WHERE workspaceId = w.id) AS memberCount,
             (SELECT COUNT(*) FROM notebooks WHERE workspaceId = w.id) AS notebookCount
      FROM workspaces w
      LEFT JOIN users u ON u.id = w.ownerId
      ORDER BY w.createdAt ASC
      `,
    )
    .all() as Array<Record<string, any>>;

  return c.json(rows.map(normalizeWorkspaceRow));
});

// 创建工作区
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const { name, description, icon } = body as {
    name: string;
    description?: string;
    icon?: string;
  };

  if (!name || !name.trim()) return c.json({ error: "工作区名称不能为空" }, 400);
  const normalizedIcon = normalizeWorkspaceIcon(icon);
  if (!normalizedIcon.ok) {
    return c.json({ error: normalizedIcon.error, code: "INVALID_WORKSPACE_ICON" }, 400);
  }

  const id = uuid();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO workspaces (id, name, description, icon, ownerId) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, name.trim(), typeof description === "string" ? description : "", normalizedIcon.icon, userId);
    workspaceMembersRepository.create(id, userId, "owner");
  });
  tx();

  const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Record<string, any>;
  return c.json(
    normalizeWorkspaceRow({ ...workspace, role: "owner", memberCount: 1, notebookCount: 0 }),
    201,
  );
});

// 查看工作区详情
app.get("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  // 系统管理员可访问任意工作区（视同 owner）
  const sysAdmin = isSystemAdmin(userId);
  const role = sysAdmin ? "owner" : getUserWorkspaceRole(id, userId);
  if (!role) return c.json({ error: "无权访问该工作区" }, 403);

  const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Record<string, any> | undefined;
  if (!ws) return c.json({ error: "工作区不存在" }, 404);

  const memberCount = workspaceMembersRepository.countByWorkspace(id);
  const notebookCount = (
    db.prepare("SELECT COUNT(*) as c FROM notebooks WHERE workspaceId = ?").get(id) as {
      c: number;
    }
  ).c;

  return c.json(normalizeWorkspaceRow({ ...ws, role, memberCount, notebookCount }));
});

// 更新工作区（仅 owner/admin）
app.put("/:id", requireWorkspaceRole("admin"), async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const body = await c.req.json();

  const fields: string[] = [];
  const params: any[] = [];
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "工作区名称不能为空" }, 400);
    }
    fields.push("name = ?");
    params.push(body.name.trim());
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return c.json({ error: "工作区描述格式无效" }, 400);
    }
    fields.push("description = ?");
    params.push(body.description);
  }
  if (body.icon !== undefined) {
    const normalizedIcon = normalizeWorkspaceIcon(body.icon);
    if (!normalizedIcon.ok) {
      return c.json({ error: normalizedIcon.error, code: "INVALID_WORKSPACE_ICON" }, 400);
    }
    fields.push("icon = ?");
    params.push(normalizedIcon.icon);
  }
  if (fields.length === 0) return c.json({ error: "无可更新字段" }, 400);

  fields.push("updatedAt = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE workspaces SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Record<string, any> | undefined;
  if (!row) return c.json({ error: "工作区不存在" }, 404);
  const ws = normalizeWorkspaceRow(row);
  broadcastWorkspaceProfileUpdated(id, ws);
  return c.json(ws);
});

// 删除工作区（仅 owner）
app.delete("/:id", requireWorkspaceRole("owner"), (c) => {
  const db = getDb();
  const actorUserId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  // CASCADE 会连带删除 workspace_members / workspace_invites
  // 但 notebooks 和 notes 的 workspaceId 会悬空 → 需要清理：回退到所有者的个人空间
  const ws = db.prepare("SELECT ownerId, name FROM workspaces WHERE id = ?").get(id) as
    | { ownerId: string; name: string }
    | undefined;
  if (!ws) return c.json({ error: "工作区不存在" }, 404);

  const memberIds = (workspaceMembersRepository.listByWorkspaceWithUser(id) as Array<{ userId?: string }>)
    .map((m) => m.userId)
    .filter((uid): uid is string => Boolean(uid) && uid !== actorUserId);

  const tx = db.transaction(() => {
    // 把所有工作区笔记本和笔记归属权转给 owner 的个人空间
    transferWorkspaceNotesToOwner(db, id, ws.ownerId);
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  });
  tx();

  broadcastWorkspaceMembershipChanged(memberIds, {
    workspaceId: id,
    workspaceName: ws.name,
    action: "deleted",
  });

  return c.json({ success: true });
});

// 转让工作区所有权（仅 owner / 系统管理员）
app.post("/:id/transfer-owner", requireWorkspaceRole("owner"), async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { targetUserId?: string };
  const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId.trim() : "";
  if (!targetUserId) {
    return c.json({ error: "请选择接收所有权的成员" }, 400);
  }

  const ws = db.prepare("SELECT id, name, ownerId FROM workspaces WHERE id = ?").get(id) as
    | { id: string; name: string; ownerId: string }
    | undefined;
  if (!ws) return c.json({ error: "工作区不存在" }, 404);
  if (targetUserId === ws.ownerId) {
    return c.json({ error: "目标成员已经是工作区所有者" }, 400);
  }

  const target = workspaceMembersRepository.getRole(id, targetUserId);
  if (!target) return c.json({ error: "目标用户不是该工作区成员" }, 404);

  const tx = db.transaction(() => {
    db.prepare("UPDATE workspaces SET ownerId = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(targetUserId, id);
    workspaceMembersRepository.updateRole(id, targetUserId, "owner");
    if (workspaceMembersRepository.getRole(id, ws.ownerId)) {
      workspaceMembersRepository.updateRole(id, ws.ownerId, "admin");
    }
  });
  tx();

  const updatedRow = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Record<string, any> | undefined;
  if (updatedRow) {
    broadcastWorkspaceProfileUpdated(id, normalizeWorkspaceRow(updatedRow));
  }
  broadcastWorkspaceMembershipChanged([ws.ownerId, targetUserId], {
    workspaceId: id,
    workspaceName: ws.name,
    action: "owner_transferred",
  });

  return c.json({ success: true, ownerId: targetUserId });
});

// ===================== 成员管理 =====================

app.get("/:id/members", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  // 系统管理员视同 owner，允许查看任意工作区成员列表
  const role = isSystemAdmin(userId) ? "owner" : getUserWorkspaceRole(id, userId);
  if (!role) return c.json({ error: "无权访问该工作区" }, 403);

  const members = workspaceMembersRepository.listByWorkspaceWithUser(id);

  return c.json(members);
});

// 直接添加站内用户为成员（仅 owner/admin）
app.post("/:id/members", requireWorkspaceRole("admin"), async (c) => {
  const db = getDb();
  const actorUserId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    userId?: string;
    role?: WorkspaceRole;
  };
  const targetUserId = typeof body.userId === "string" ? body.userId.trim() : "";
  const validRoles: WorkspaceRole[] = ["admin", "editor", "commenter", "viewer"];
  const targetRole: WorkspaceRole = body.role && validRoles.includes(body.role) ? body.role : "editor";

  if (!targetUserId) return c.json({ error: "请选择要添加的用户" }, 400);
  if (targetRole === "admin" && !isOwnerOrSystemAdmin(id, actorUserId)) {
    return c.json({ error: "仅工作区所有者可添加管理员" }, 403);
  }

  const ws = db.prepare("SELECT id, name FROM workspaces WHERE id = ?").get(id) as { id: string; name: string } | undefined;
  if (!ws) return c.json({ error: "工作区不存在" }, 404);

  const user = db.prepare("SELECT id, username, isDisabled FROM users WHERE id = ?").get(targetUserId) as
    | { id: string; username: string; isDisabled: number }
    | undefined;
  if (!user || user.isDisabled) {
    return c.json({ error: "目标用户不存在或已停用" }, 404);
  }

  if (workspaceMembersRepository.getRole(id, targetUserId)) {
    return c.json({ error: "该用户已是工作区成员" }, 409);
  }

  workspaceMembersRepository.create(id, targetUserId, targetRole);
  broadcastWorkspaceMembershipChanged([targetUserId], {
    workspaceId: id,
    workspaceName: ws.name,
    action: "added",
    role: targetRole,
  });

  return c.json({ success: true, userId: targetUserId, role: targetRole }, 201);
});

// 修改成员角色（仅 owner/admin；普通 admin 不可操作同级 admin 或提权为 admin）
app.put("/:id/members/:userId", requireWorkspaceRole("admin"), async (c) => {
  const db = getDb();
  const actorUserId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");
  const body = await c.req.json();
  const { role } = body as { role: WorkspaceRole };

  const validRoles: WorkspaceRole[] = ["admin", "editor", "commenter", "viewer"];
  if (!validRoles.includes(role)) {
    return c.json({ error: "无效的角色" }, 400);
  }
  if (targetUserId === actorUserId) {
    return c.json({ error: "不能修改自己的角色" }, 400);
  }

  // 不能修改 owner 的角色
  const target = workspaceMembersRepository.getRole(id, targetUserId);
  if (!target) return c.json({ error: "成员不存在" }, 404);
  if (target.role === "owner") {
    return c.json({ error: "不能修改 owner 的角色" }, 400);
  }
  const canManageAdmins = isOwnerOrSystemAdmin(id, actorUserId);
  if (!canManageAdmins && (target.role === "admin" || role === "admin")) {
    return c.json({ error: "仅工作区所有者可调整管理员角色" }, 403);
  }

  workspaceMembersRepository.updateRole(id, targetUserId, role);
  const ws = db.prepare("SELECT name FROM workspaces WHERE id = ?").get(id) as { name?: string } | undefined;
  broadcastWorkspaceMembershipChanged([targetUserId], {
    workspaceId: id,
    workspaceName: ws?.name,
    action: "role_updated",
    role,
  });

  return c.json({ success: true });
});

// 移除成员（仅 owner/admin；普通 admin 不可移除同级 admin）
app.delete("/:id/members/:userId", requireWorkspaceRole("admin"), (c) => {
  const db = getDb();
  const actorUserId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");

  if (targetUserId === actorUserId) {
    return c.json({ error: "不能移除自己，请使用退出工作区" }, 400);
  }

  const target = workspaceMembersRepository.getRole(id, targetUserId);
  if (!target) return c.json({ error: "成员不存在" }, 404);
  if (target.role === "owner") {
    return c.json({ error: "不能移除 owner" }, 400);
  }
  if (target.role === "admin" && !isOwnerOrSystemAdmin(id, actorUserId)) {
    return c.json({ error: "仅工作区所有者可移除管理员" }, 403);
  }

  const ws = db.prepare("SELECT name FROM workspaces WHERE id = ?").get(id) as { name?: string } | undefined;
  const tx = db.transaction(() => {
    workspaceMembersRepository.delete(id, targetUserId);
    // 同步清理 note_acl
    noteAclRepository.deleteByUserAndWorkspace(targetUserId, id);
  });
  tx();

  broadcastWorkspaceMembershipChanged([targetUserId], {
    workspaceId: id,
    workspaceName: ws?.name,
    action: "removed",
  });

  return c.json({ success: true });
});

// 主动退出
app.post("/:id/leave", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const row = workspaceMembersRepository.getRole(id, userId);
  if (!row) return c.json({ error: "您不是该工作区成员" }, 404);
  if (row.role === "owner") {
    return c.json({ error: "owner 不能退出工作区，请先转让或删除工作区" }, 400);
  }

  workspaceMembersRepository.delete(id, userId);
  return c.json({ success: true });
});

// ===================== 邀请码 =====================

app.post("/:id/invites", requireWorkspaceRole("admin"), async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();
  const { role, maxUses, expiresAt } = body as {
    role?: WorkspaceRole;
    maxUses?: number;
    expiresAt?: string;
  };

  const validRoles: WorkspaceRole[] = ["admin", "editor", "commenter", "viewer"];
  const inviteRole = role && validRoles.includes(role) ? role : "editor";
  if (inviteRole === "admin" && !isOwnerOrSystemAdmin(id, userId)) {
    return c.json({ error: "仅工作区所有者可创建管理员邀请码" }, 403);
  }

  const inviteId = uuid();
  const code = generateInviteCode();

  workspaceInvitesRepository.create({
    id: inviteId,
    workspaceId: id,
    code,
    role: inviteRole,
    maxUses: maxUses ?? 10,
    expiresAt: expiresAt || null,
    createdBy: userId,
  });

  const invite = workspaceInvitesRepository.getById(inviteId);
  return c.json(invite, 201);
});

app.get("/:id/invites", requireWorkspaceRole("admin"), (c) => {
  const id = c.req.param("id");
  const invites = workspaceInvitesRepository.listByWorkspace(id);
  return c.json(invites);
});

app.delete("/:id/invites/:inviteId", requireWorkspaceRole("admin"), (c) => {
  const id = c.req.param("id");
  const inviteId = c.req.param("inviteId");
  workspaceInvitesRepository.delete(inviteId, id);
  return c.json({ success: true });
});

// 使用邀请码加入（独立端点，不需要 workspaceId 参数）
app.post("/join", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const { code } = body as { code: string };

  if (!code || !code.trim()) return c.json({ error: "邀请码不能为空" }, 400);

  const invite = workspaceInvitesRepository.getByCode(code.trim());

  if (!invite) return c.json({ error: "邀请码无效" }, 404);

  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
    return c.json({ error: "邀请码已过期" }, 400);
  }
  if (invite.maxUses && invite.useCount >= invite.maxUses) {
    return c.json({ error: "邀请码使用次数已用尽" }, 400);
  }

  // 检查是否已是成员
  const existing = workspaceMembersRepository.getRole(invite.workspaceId, userId);
  if (existing) {
    return c.json({
      success: true,
      workspaceId: invite.workspaceId,
      alreadyMember: true,
    });
  }

  const tx = db.transaction(() => {
    workspaceMembersRepository.create(invite.workspaceId, userId, invite.role);
    workspaceInvitesRepository.incrementUseCount(invite.id);
  });
  tx();

  const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(invite.workspaceId) as Record<string, any>;
  return c.json({ success: true, workspace: normalizeWorkspaceRow(ws), role: invite.role });
});

// ===================== 功能开关（Phase 1）=====================
//
// GET  /api/workspaces/:id/features  - 任何成员可读（侧边栏渲染需要）
// PUT  /api/workspaces/:id/features  - 仅 owner 可写（owner 决定启用哪些模块）
//
// 存储格式：workspaces.enabledFeatures 是 TEXT（JSON 字符串或空串）。
// 空串视为"未配置 = 全开"，这样老工作区无需数据迁移就能正常用。
// 白名单校验：只接受已知的 feature 键，防止前端乱写污染 DB。

const FEATURE_KEYS: WorkspaceFeature[] = [
  "notes",
  "diaries",
  "tasks",
  "mindmaps",
  "files",
  "favorites",
];

app.get("/:id/features", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  // 任何成员都可以读（侧边栏需要据此决定显隐）；系统管理员旁路
  const role = isSystemAdmin(userId) ? "owner" : getUserWorkspaceRole(id, userId);
  if (!role) return c.json({ error: "无权访问该工作区" }, 403);

  const features = resolveWorkspaceFeatures(id);

  // 统一回填默认值 true，前端拿到的永远是完整形态，省得各处再做 undefined=true 的容错
  const normalized: Record<WorkspaceFeature, boolean> = {} as any;
  for (const k of FEATURE_KEYS) {
    normalized[k] = features[k] !== false;
  }
  return c.json(normalized);
});

app.put("/:id/features", requireWorkspaceRole("owner"), async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const body = (await c.req.json()) as Partial<Record<string, unknown>>;

  // 白名单 + 类型过滤：只接受 boolean 值的已知键
  const sanitized: EnabledFeaturesConfig = {};
  for (const k of FEATURE_KEYS) {
    const v = body?.[k];
    if (typeof v === "boolean") sanitized[k] = v;
  }

  // 与老配置合并：允许 PATCH 语义（只传 {tasks:false} 就只改 tasks）
  const current = resolveWorkspaceFeatures(id);
  const merged: EnabledFeaturesConfig = { ...current, ...sanitized };

  db.prepare(
    "UPDATE workspaces SET enabledFeatures = ?, updatedAt = datetime('now') WHERE id = ?",
  ).run(JSON.stringify(merged), id);

  // 返回归一化后的完整形态，便于前端直接替换缓存
  const normalized: Record<WorkspaceFeature, boolean> = {} as any;
  for (const k of FEATURE_KEYS) {
    normalized[k] = merged[k] !== false;
  }
  return c.json(normalized);
});

// ===================== 工作区用户组（P2 部门/团队分组） =====================

app.get("/:id/groups", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const role = isSystemAdmin(userId) ? "owner" : getUserWorkspaceRole(id, userId);
  if (!role) return c.json({ error: "无权访问该工作区" }, 403);

  const groups = db
    .prepare(
      `SELECT id, workspaceId, name, description, createdBy, createdAt, updatedAt
       FROM workspace_groups WHERE workspaceId = ? ORDER BY name ASC`,
    )
    .all(id) as Array<Record<string, any>>;

  const memberRows = db
    .prepare(
      `SELECT gm.groupId, gm.userId, gm.addedAt, u.username, u.displayName, u.email
       FROM workspace_group_members gm
       JOIN workspace_groups g ON g.id = gm.groupId
       JOIN workspace_members wm ON wm.workspaceId = g.workspaceId AND wm.userId = gm.userId
       JOIN users u ON u.id = gm.userId
       WHERE g.workspaceId = ? AND u.isDisabled = 0
       ORDER BY u.username ASC`,
    )
    .all(id) as Array<{
      groupId: string;
      userId: string;
      addedAt: string;
      username: string;
      displayName: string | null;
      email: string | null;
    }>;

  const byGroup = new Map<string, typeof memberRows>();
  for (const row of memberRows) {
    const list = byGroup.get(row.groupId) || [];
    list.push(row);
    byGroup.set(row.groupId, list);
  }

  return c.json(
    groups.map((g) => {
      const members = byGroup.get(g.id) || [];
      return { ...g, memberCount: members.length, members };
    }),
  );
});

app.post("/:id/groups", requireWorkspaceRole("admin"), async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 200) : "";
  if (!name || name.length > 60) {
    return c.json({ error: "用户组名称不能为空且不超过 60 字" }, 400);
  }

  const groupId = uuid();
  try {
    db.prepare(
      `INSERT INTO workspace_groups (id, workspaceId, name, description, createdBy)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(groupId, id, name, description, userId);
  } catch (err: any) {
    if (String(err?.code || "").includes("UNIQUE") || String(err?.message || "").includes("UNIQUE")) {
      return c.json({ error: "工作区内已存在同名用户组" }, 409);
    }
    throw err;
  }

  const created = db.prepare("SELECT * FROM workspace_groups WHERE id = ?").get(groupId) as Record<string, any>;
  return c.json({ ...created, memberCount: 0, members: [] }, 201);
});

app.put("/:id/groups/:groupId", requireWorkspaceRole("admin"), async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const groupId = c.req.param("groupId");
  const existing = db
    .prepare("SELECT * FROM workspace_groups WHERE id = ? AND workspaceId = ?")
    .get(groupId, id) as Record<string, any> | undefined;
  if (!existing) return c.json({ error: "用户组不存在" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string };
  const name = body.name !== undefined ? String(body.name).trim() : existing.name;
  const description = body.description !== undefined ? String(body.description).trim().slice(0, 200) : existing.description;
  if (!name || name.length > 60) {
    return c.json({ error: "用户组名称不能为空且不超过 60 字" }, 400);
  }

  try {
    db.prepare(
      `UPDATE workspace_groups SET name = ?, description = ?, updatedAt = datetime('now')
       WHERE id = ? AND workspaceId = ?`,
    ).run(name, description, groupId, id);
  } catch (err: any) {
    if (String(err?.code || "").includes("UNIQUE") || String(err?.message || "").includes("UNIQUE")) {
      return c.json({ error: "工作区内已存在同名用户组" }, 409);
    }
    throw err;
  }
  return c.json(db.prepare("SELECT * FROM workspace_groups WHERE id = ?").get(groupId));
});

app.delete("/:id/groups/:groupId", requireWorkspaceRole("admin"), (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const groupId = c.req.param("groupId");
  const result = db.prepare("DELETE FROM workspace_groups WHERE id = ? AND workspaceId = ?").run(groupId, id);
  if (result.changes === 0) return c.json({ error: "用户组不存在" }, 404);
  return c.json({ success: true });
});

app.post("/:id/groups/:groupId/members", requireWorkspaceRole("admin"), async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const groupId = c.req.param("groupId");
  const group = db.prepare("SELECT id FROM workspace_groups WHERE id = ? AND workspaceId = ?").get(groupId, id);
  if (!group) return c.json({ error: "用户组不存在" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
  const targetUserId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!targetUserId) return c.json({ error: "请选择成员" }, 400);
  if (!workspaceMembersRepository.getRole(id, targetUserId)) {
    return c.json({ error: "只能将当前工作区成员加入用户组" }, 400);
  }

  db.prepare("INSERT OR IGNORE INTO workspace_group_members (groupId, userId) VALUES (?, ?)").run(groupId, targetUserId);
  return c.json({ success: true }, 201);
});

app.delete("/:id/groups/:groupId/members/:userId", requireWorkspaceRole("admin"), (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const groupId = c.req.param("groupId");
  const targetUserId = c.req.param("userId");
  const group = db.prepare("SELECT id FROM workspace_groups WHERE id = ? AND workspaceId = ?").get(groupId, id);
  if (!group) return c.json({ error: "用户组不存在" }, 404);
  db.prepare("DELETE FROM workspace_group_members WHERE groupId = ? AND userId = ?").run(groupId, targetUserId);
  return c.json({ success: true });
});

// ===================== 工作区动态流与空间级审计（P2） =====================

app.get("/:id/activity", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const role = isSystemAdmin(userId) ? "owner" : getUserWorkspaceRole(id, userId);
  if (!role) return c.json({ error: "无权访问该工作区" }, 403);

  const category = c.req.query("category") || "all";
  const rawLimit = Number.parseInt(c.req.query("limit") || "30", 10);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 30;
  const canViewPermissions = role === "owner" || role === "admin";
  if (category === "permissions" && !canViewPermissions) {
    return c.json({ error: "仅管理员可查看权限审计记录" }, 403);
  }

  type ActivityItem = {
    id: string;
    category: "docs" | "issues" | "members" | "permissions";
    action: string;
    actorName: string;
    targetTitle: string;
    detail?: string;
    createdAt: string;
  };
  const items: ActivityItem[] = [];

  if (category === "all" || category === "docs" || category === "permissions") {
    const allowedActions =
      category === "permissions"
        ? ["permission_set", "permission_clear"]
        : category === "docs"
          ? ["create", "move", "delete_subtree", "delete_promote", "restore"]
          : canViewPermissions
            ? ["create", "move", "delete_subtree", "delete_promote", "restore", "permission_set", "permission_clear"]
            : ["create", "move", "delete_subtree", "delete_promote", "restore"];
    const placeholders = allowedActions.map(() => "?").join(",");
    const historyRows = db
      .prepare(
        `SELECT h.id, h.action, h.metadata, h.createdAt,
                COALESCE(NULLIF(u.displayName, ''), u.username, '未知用户') AS actorName,
                COALESCE(NULLIF(tu.displayName, ''), tu.username) AS targetUserName,
                CASE
                  WHEN n.resourceType = 'notebook' THEN COALESCE(nb.name, '未命名文件夹')
                  WHEN n.resourceType = 'note' THEN COALESCE(note.title, '无标题笔记')
                  WHEN n.resourceType = 'mindmap' THEN COALESCE(mm.title, n.resourceId)
                  WHEN n.resourceType = 'file' THEN COALESCE(f.filename, n.resourceId)
                  ELSE n.resourceId
                END AS nodeTitle,
                n.nodeType
         FROM knowledge_tree_history h
         JOIN knowledge_tree_nodes n ON n.id = h.nodeId
         LEFT JOIN notebooks nb ON n.resourceType = 'notebook' AND nb.id = n.resourceId
         LEFT JOIN notes note ON n.resourceType = 'note' AND note.id = n.resourceId
         LEFT JOIN mindmaps mm ON n.resourceType = 'mindmap' AND mm.id = n.resourceId
         LEFT JOIN files f ON n.resourceType = 'file' AND f.id = n.resourceId
         LEFT JOIN users u ON u.id = h.actorUserId
         LEFT JOIN users tu ON tu.id = h.targetUserId
         WHERE n.workspaceId = ? AND h.action IN (${placeholders})
         ORDER BY h.createdAt DESC LIMIT ?`,
      )
      .all(id, ...allowedActions, limit) as Array<Record<string, any>>;

    const ACTION_LABELS: Record<string, string> = {
      create: "创建了内容",
      move: "移动了位置",
      delete_subtree: "删除了目录或文档",
      delete_promote: "移除了目录",
      restore: "恢复了内容",
      permission_set: "更新了目录权限",
      permission_clear: "移除了目录权限",
    };

    for (const row of historyRows) {
      const isPerm = row.action === "permission_set" || row.action === "permission_clear";
      let detail: string | undefined;
      if (isPerm && row.targetUserName) {
        detail = `成员：${row.targetUserName}`;
      }
      items.push({
        id: `kth:${row.id}`,
        category: isPerm ? "permissions" : "docs",
        action: ACTION_LABELS[row.action] || row.action,
        actorName: row.actorName,
        targetTitle: row.nodeTitle || "未命名节点",
        detail,
        createdAt: row.createdAt,
      });
    }
  }

  if (category === "all" || category === "issues") {
    const issueRows = db
      .prepare(
        `SELECT i.id, i.title, i.status, i.createdAt,
                COALESCE(NULLIF(u.displayName, ''), u.username, '未知用户') AS actorName
         FROM workspace_issues i
         LEFT JOIN users u ON u.id = i.createdBy
         WHERE i.workspaceId = ?
         ORDER BY i.createdAt DESC LIMIT ?`,
      )
      .all(id, limit) as Array<Record<string, any>>;
    for (const row of issueRows) {
      items.push({
        id: `issue:${row.id}`,
        category: "issues",
        action: row.status === "closed" ? "关闭了议题" : "创建了议题",
        actorName: row.actorName,
        targetTitle: row.title,
        createdAt: row.createdAt,
      });
    }
  }

  if (category === "all" || category === "members") {
    const memberJoinRows = db
      .prepare(
        `SELECT wm.userId, wm.role, wm.joinedAt,
                COALESCE(NULLIF(u.displayName, ''), u.username, '未知用户') AS actorName
         FROM workspace_members wm
         LEFT JOIN users u ON u.id = wm.userId
         WHERE wm.workspaceId = ?
         ORDER BY wm.joinedAt DESC LIMIT ?`,
      )
      .all(id, limit) as Array<Record<string, any>>;
    for (const row of memberJoinRows) {
      items.push({
        id: `member:${row.userId}:${row.joinedAt}`,
        category: "members",
        action: "加入了工作区",
        actorName: row.actorName,
        targetTitle: `角色：${row.role}`,
        createdAt: row.joinedAt,
      });
    }
  }

  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return c.json({ items: items.slice(0, limit), canViewPermissions });
});

export default app;
