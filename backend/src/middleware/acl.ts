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
import {
  resolveNoteNotebookMemberPermission,
  resolveNotebookMemberPermission,
} from "../services/notebook-permissions";
import { noteAclRepository, workspaceMembersRepository } from "../repositories";

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
  const row = workspaceMembersRepository.getRole(workspaceId, userId);
  return (row?.role as WorkspaceRole) ?? null;
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

  if (note.userId === userId) {
    return { permission: "manage", workspaceId: note.workspaceId, noteOwnerId: note.userId };
  }

  const notebookMemberPermission = resolveNoteNotebookMemberPermission(noteId, userId);
  if (notebookMemberPermission) {
    return {
      permission: notebookMemberPermission,
      workspaceId: note.workspaceId,
      noteOwnerId: note.userId,
    };
  }

  // 个人空间
  if (!note.workspaceId) {
    return { permission: null, workspaceId: null, noteOwnerId: note.userId };
  }

  // 工作区笔记：检查 ACL 覆写
  const acl = noteAclRepository.getPermission(noteId, userId);
  if (acl) {
    return { permission: acl.permission as Permission, workspaceId: note.workspaceId, noteOwnerId: note.userId };
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

  if (nb.userId === userId) {
    return { permission: "manage", workspaceId: nb.workspaceId, notebookOwnerId: nb.userId };
  }

  const notebookMemberPermission = resolveNotebookMemberPermission(notebookId, userId);
  if (notebookMemberPermission) {
    return {
      permission: notebookMemberPermission,
      workspaceId: nb.workspaceId,
      notebookOwnerId: nb.userId,
    };
  }

  if (!nb.workspaceId) {
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
  return workspaceMembersRepository.listWorkspaceIdsByUser(userId);
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
 *
 * 系统管理员旁路：
 *   - users.role = 'admin' 的系统管理员视同任意工作区的 owner，可越过所有
 *     "工作区角色"门槛（编辑信息 / 删除空间 / 管成员 / 管邀请 / 改 features）。
 *   - 这是"运维兜底"语义：管理员在「设置 → 工作区管理」里需要能跨工作区
 *     维护任意一个空间。普通成员之间的角色关系不受影响。
 *   - 不写入 workspace_members，不改变成员清单；只是放行本次请求。
 */
export function requireWorkspaceRole(min: WorkspaceRole) {
  return async (c: Context, next: Next) => {
    const userId = c.req.header("X-User-Id") || "";
    const workspaceId =
      c.req.param("workspaceId") || c.req.param("id") || c.req.query("workspaceId") || "";
    if (!workspaceId) return c.json({ error: "缺少工作区 ID" }, 400);

    // 系统管理员直通：以 owner 身份执行后续逻辑
    if (isSystemAdmin(userId)) {
      c.set("workspaceRole" as any, "owner");
      c.set("isSystemAdminBypass" as any, true);
      await next();
      return;
    }

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

// ============================================================================
// 工作区数据隔离 Phase 1：共享资源权限 & 功能开关
// ----------------------------------------------------------------------------
// 设计原则：
//   1. 共享资源（diaries / tasks / mindmaps / attachments 等）"成员可读全部、
//      成员只能改/删自己创建的、admin+owner 可管全部"。这是 Linear / Notion /
//      Figma 的默认协作模型。
//   2. 功能开关（enabledFeatures）是 per-workspace 的 owner/admin 配置，
//      未设置时（空字符串）视为"全开"，保证老工作区零迁移。
//   3. 个人空间（workspaceId === null）不受功能开关限制——永远全开，因为
//      它就是单用户场景。
// ============================================================================

/**
 * 共享资源的可编辑模块类型。用于 canManageResource / requireWorkspaceFeature。
 * 与 enabledFeatures JSON 的键对齐。
 */
export type WorkspaceFeature =
  | "notes"
  | "diaries"
  | "tasks"
  | "mindmaps"
  | "files"
  | "favorites";

/**
 * 功能开关 JSON 的结构。所有字段都是可选的：
 *   - 未列出 / undefined → 视为启用（默认全开）
 *   - false              → 明确关闭（侧边栏隐藏、路由 403）
 *   - true               → 明确开启（与未设置等价，仅作显式记录）
 *
 * 为什么 undefined = 启用？
 *   让老工作区（enabledFeatures = ''）和新建工作区无需回填就能正常运作；
 *   owner 首次进入"功能开关"UI 时，前端把当前实际状态（全 true）写回一次即可。
 */
export interface EnabledFeaturesConfig {
  notes?: boolean;
  diaries?: boolean;
  tasks?: boolean;
  mindmaps?: boolean;
  files?: boolean;
  favorites?: boolean;
}

/**
 * 解析某工作区的功能开关配置。
 *
 * 返回值保证：
 *   - workspaceId 为 null（个人空间）→ 返回 {}（调用方用 isFeatureEnabled 得到 true）
 *   - workspaces 表里 enabledFeatures 字段为空 / 非法 JSON → 同样返回 {}
 *   - 合法 JSON → 透传解析结果（未列出的键即视为启用）
 */
export function resolveWorkspaceFeatures(
  workspaceId: string | null,
): EnabledFeaturesConfig {
  if (!workspaceId) return {};
  const db = getDb();
  const row = db
    .prepare("SELECT enabledFeatures FROM workspaces WHERE id = ?")
    .get(workspaceId) as { enabledFeatures?: string } | undefined;
  const raw = row?.enabledFeatures;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as EnabledFeaturesConfig;
    return {};
  } catch {
    // 历史脏数据容错：解析失败当作未配置（全开），避免整个工作区被锁死。
    return {};
  }
}

/**
 * 判断某工作区是否启用了某个模块。
 *   - 未设置（undefined）= 启用
 *   - 显式 false       = 禁用
 *   - 显式 true        = 启用
 */
export function isFeatureEnabled(
  features: EnabledFeaturesConfig,
  feature: WorkspaceFeature,
): boolean {
  const v = features[feature];
  return v !== false; // undefined / true / 其他 → 启用
}

/**
 * 共享资源写权限判定：是创建者本人 OR 是工作区 admin/owner。
 *
 * 适用于 diaries / tasks / mindmaps / attachments 等"工作区共享但
 * 成员级编辑"的资源。笔记/笔记本有独立的 note_acl / notebook 权限模型，
 * 不走这个函数。
 *
 * 参数：
 *   creatorId   资源创建者 userId（资源行的 userId 字段）
 *   workspaceId 资源归属的工作区 id；null 表示个人空间资源
 *   actorId     当前操作用户 id
 *
 * 返回：true 表示可以写/删；false 表示拒绝。
 *
 * 行为：
 *   - 个人空间（workspaceId === null）：仅创建者本人可写，其他人一律拒绝
 *     （哪怕是系统 admin 也不应该越权进别人的个人空间——系统 admin 另走
 *     管理后台专用接口）。
 *   - 工作区：
 *       a. 创建者本人 → 允许
 *       b. admin / owner → 允许
 *       c. 其他角色（editor/commenter/viewer）→ 拒绝
 */
export function canManageResource(
  creatorId: string,
  workspaceId: string | null,
  actorId: string,
): boolean {
  if (!actorId) return false;
  if (creatorId === actorId) return true;
  if (!workspaceId) return false; // 个人空间他人资源：一律不可动
  const role = getUserWorkspaceRole(workspaceId, actorId);
  return role === "owner" || role === "admin";
}

/**
 * 中间件：要求当前工作区启用了指定功能模块。
 *
 * 使用约定：
 *   - 路由从 query `?workspaceId=xxx` 读取目标工作区。
 *   - 没有 workspaceId（= 个人空间）直接放行——个人空间不受功能开关管控。
 *   - workspaceId 存在但模块被关闭 → 403 FEATURE_DISABLED。
 *   - workspaceId 存在但用户不是成员 → 也直接 403，避免绕过开关探测信息。
 *
 * 为什么不在这里做"成员资格"的强校验？
 *   成员资格由各路由自己的 visibility 过滤保证；这里只负责"功能是否启用"。
 *   但我们仍然拒绝非成员访问，原因是：未启用的模块不应泄漏给非成员知晓。
 */
export function requireWorkspaceFeature(feature: WorkspaceFeature) {
  return async (c: Context, next: Next) => {
    const userId = c.req.header("X-User-Id") || "";
    const workspaceId = c.req.query("workspaceId") || c.req.param("workspaceId") || "";

    // 个人空间：永远放行
    if (!workspaceId || workspaceId === "personal") {
      await next();
      return;
    }

    // 工作区成员校验
    const role = getUserWorkspaceRole(workspaceId, userId);
    if (!role) {
      return c.json({ error: "无权访问该工作区", code: "FORBIDDEN" }, 403);
    }

    // 功能开关校验
    const features = resolveWorkspaceFeatures(workspaceId);
    if (!isFeatureEnabled(features, feature)) {
      return c.json(
        {
          error: "该功能在当前工作区已被管理员关闭",
          code: "FEATURE_DISABLED",
          feature,
        },
        403,
      );
    }

    await next();
  };
}
