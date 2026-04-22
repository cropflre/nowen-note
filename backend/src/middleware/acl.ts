/**
 * ACL 权限中间件（Phase 1 - 多用户协作）
 *
 * 设计原则：
 * 1. 最小侵入：个人空间（workspaceId = NULL）的笔记本/笔记保持原有单用户行为
 * 2. 工作区资源需要成员身份 + 角色权限校验
 * 3. note_acl 表用于笔记级覆写（暂不在 Phase 1 落地 UI，仅保留接口）
 *
 * 权限级别（由低到高）：viewer < commenter < editor < admin < owner
 * 操作权限映射：read < comment < write < manage
 */
import type { Context, Next } from "hono";
import { getDb } from "../db/schema";

export type WorkspaceRole = "owner" | "admin" | "editor" | "commenter" | "viewer";
export type Permission = "read" | "comment" | "write" | "manage";

const ROLE_LEVEL: Record<WorkspaceRole, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  admin: 4,
  owner: 5,
};

const PERM_LEVEL: Record<Permission, number> = {
  read: 1,
  comment: 2,
  write: 3,
  manage: 4,
};

// 角色 → 最高可执行权限
const ROLE_MAX_PERM: Record<WorkspaceRole, Permission> = {
  viewer: "read",
  commenter: "comment",
  editor: "write",
  admin: "manage",
  owner: "manage",
};

/**
 * 判断一个权限是否满足最小要求
 */
export function hasPermission(actual: Permission | null, required: Permission): boolean {
  if (!actual) return false;
  return PERM_LEVEL[actual] >= PERM_LEVEL[required];
}

/**
 * 判断一个角色是否满足最小要求
 */
export function hasRole(actual: WorkspaceRole | null, required: WorkspaceRole): boolean {
  if (!actual) return false;
  return ROLE_LEVEL[actual] >= ROLE_LEVEL[required];
}

/**
 * 根据角色获取最大权限
 */
export function roleToPermission(role: WorkspaceRole): Permission {
  return ROLE_MAX_PERM[role];
}

/**
 * 查询用户在指定工作区中的角色
 */
export function getUserWorkspaceRole(workspaceId: string, userId: string): WorkspaceRole | null {
  const db = getDb();
  const row = db
    .prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get(workspaceId, userId) as { role: WorkspaceRole } | undefined;
  return row?.role ?? null;
}

/**
 * 解析笔记的有效权限
 *  1. 若笔记是个人空间（workspaceId IS NULL）：仅 owner 可访问（write/manage）
 *  2. 若笔记属于工作区：
 *     a. 先查 note_acl 覆写
 *     b. 再查 workspace_members 角色对应的权限
 *     c. 均无记录则返回 null（无权）
 */
export function resolveNotePermission(
  noteId: string,
  userId: string,
): { permission: Permission | null; workspaceId: string | null; noteOwnerId: string | null } {
  const db = getDb();
  const note = db
    .prepare("SELECT userId, workspaceId FROM notes WHERE id = ?")
    .get(noteId) as { userId: string; workspaceId: string | null } | undefined;

  if (!note) return { permission: null, workspaceId: null, noteOwnerId: null };

  // 个人空间
  if (!note.workspaceId) {
    if (note.userId === userId) return { permission: "manage", workspaceId: null, noteOwnerId: note.userId };
    return { permission: null, workspaceId: null, noteOwnerId: note.userId };
  }

  // 工作区笔记：检查 ACL 覆写
  const acl = db
    .prepare("SELECT permission FROM note_acl WHERE noteId = ? AND userId = ?")
    .get(noteId, userId) as { permission: Permission } | undefined;
  if (acl) {
    return { permission: acl.permission, workspaceId: note.workspaceId, noteOwnerId: note.userId };
  }

  // 工作区成员角色
  const role = getUserWorkspaceRole(note.workspaceId, userId);
  if (!role) return { permission: null, workspaceId: note.workspaceId, noteOwnerId: note.userId };
  return { permission: roleToPermission(role), workspaceId: note.workspaceId, noteOwnerId: note.userId };
}

/**
 * 解析笔记本的有效权限（与笔记类似，但直接基于 notebooks.workspaceId）
 */
export function resolveNotebookPermission(
  notebookId: string,
  userId: string,
): { permission: Permission | null; workspaceId: string | null; notebookOwnerId: string | null } {
  const db = getDb();
  const nb = db
    .prepare("SELECT userId, workspaceId FROM notebooks WHERE id = ?")
    .get(notebookId) as { userId: string; workspaceId: string | null } | undefined;

  if (!nb) return { permission: null, workspaceId: null, notebookOwnerId: null };

  if (!nb.workspaceId) {
    if (nb.userId === userId) return { permission: "manage", workspaceId: null, notebookOwnerId: nb.userId };
    return { permission: null, workspaceId: null, notebookOwnerId: nb.userId };
  }

  const role = getUserWorkspaceRole(nb.workspaceId, userId);
  if (!role) return { permission: null, workspaceId: nb.workspaceId, notebookOwnerId: nb.userId };
  return { permission: roleToPermission(role), workspaceId: nb.workspaceId, notebookOwnerId: nb.userId };
}

/**
 * 获取当前用户可访问的所有 workspaceId 集合（包含个人空间标识 null）
 */
export function getUserAccessibleWorkspaceIds(userId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT workspaceId FROM workspace_members WHERE userId = ?")
    .all(userId) as { workspaceId: string }[];
  return rows.map((r) => r.workspaceId);
}

/**
 * SQL WHERE 片段：筛选出用户可见的笔记/笔记本
 * 用法：
 *   const { where, params } = buildVisibilityWhere(userId, 'notes');
 *   db.prepare(`SELECT * FROM notes ${where}`).all(...params);
 */
export function buildVisibilityWhere(
  userId: string,
  alias: string = "",
  extraConditions: string[] = [],
): { where: string; params: any[] } {
  const p = alias ? `${alias}.` : "";
  const wsIds = getUserAccessibleWorkspaceIds(userId);

  const conditions: string[] = [];
  const params: any[] = [];

  // 条件1：个人空间内由我拥有
  conditions.push(`(${p}userId = ? AND ${p}workspaceId IS NULL)`);
  params.push(userId);

  // 条件2：工作区笔记且我是成员
  if (wsIds.length > 0) {
    const placeholders = wsIds.map(() => "?").join(",");
    conditions.push(`(${p}workspaceId IN (${placeholders}))`);
    params.push(...wsIds);
  }

  let where = `(${conditions.join(" OR ")})`;
  if (extraConditions.length > 0) {
    where = `${where} AND ${extraConditions.join(" AND ")}`;
  }
  return { where: "WHERE " + where, params };
}

/**
 * 中间件工厂：要求对某笔记拥有指定权限
 * 用法：app.put('/:id', requireNotePermission('write'), handler)
 */
export function requireNotePermission(min: Permission) {
  return async (c: Context, next: Next) => {
    const userId = c.req.header("X-User-Id") || "";
    const noteId = c.req.param("id");
    if (!noteId) return c.json({ error: "缺少笔记 ID" }, 400);

    const { permission } = resolveNotePermission(noteId, userId);
    if (!hasPermission(permission, min)) {
      return c.json({ error: "权限不足", code: "FORBIDDEN", required: min }, 403);
    }
    c.set("notePermission" as any, permission);
    await next();
  };
}

/**
 * 中间件工厂：要求对某笔记本拥有指定权限
 */
export function requireNotebookPermission(min: Permission) {
  return async (c: Context, next: Next) => {
    const userId = c.req.header("X-User-Id") || "";
    const notebookId = c.req.param("id");
    if (!notebookId) return c.json({ error: "缺少笔记本 ID" }, 400);

    const { permission } = resolveNotebookPermission(notebookId, userId);
    if (!hasPermission(permission, min)) {
      return c.json({ error: "权限不足", code: "FORBIDDEN", required: min }, 403);
    }
    c.set("notebookPermission" as any, permission);
    await next();
  };
}

/**
 * 中间件工厂：要求用户是某工作区的成员，且角色满足 min
 */
export function requireWorkspaceRole(min: WorkspaceRole) {
  return async (c: Context, next: Next) => {
    const userId = c.req.header("X-User-Id") || "";
    const workspaceId =
      c.req.param("workspaceId") || c.req.param("id") || c.req.query("workspaceId") || "";
    if (!workspaceId) return c.json({ error: "缺少工作区 ID" }, 400);

    const role = getUserWorkspaceRole(workspaceId, userId);
    if (!hasRole(role, min)) {
      return c.json({ error: "权限不足", code: "FORBIDDEN", required: min }, 403);
    }
    c.set("workspaceRole" as any, role);
    await next();
  };
}

/**
 * 判断用户是否为系统管理员
 */
export function isSystemAdmin(userId: string): boolean {
  if (!userId) return false;
  const db = getDb();
  const row = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role?: string } | undefined;
  return row?.role === "admin";
}

/**
 * 中间件：要求当前用户是系统管理员
 */
export async function requireAdmin(c: Context, next: Next) {
  const userId = c.req.header("X-User-Id") || "";
  if (!isSystemAdmin(userId)) {
    return c.json({ error: "仅管理员可执行此操作", code: "FORBIDDEN" }, 403);
  }
  await next();
}
