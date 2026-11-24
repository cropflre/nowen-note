/**
 * API Token 视角下的笔记本访问判定。
 *
 * Token 的最终权限 = Token scopes ∩ Token 笔记本授权 ∩ 本函数给出的用户当前权限。
 * 本函数只负责“用户此刻还能把多少权限交给 Token”，每次请求都重新计算：
 *
 * - 团队空间笔记本必须有 workspace_members 成员行；系统管理员旁路、workspaces.ownerId、
 *   资源 userId 匹配或笔记本单独共享都不能替代成员身份；
 * - viewer / commenter 最多只读，editor / admin / owner 最多读写；
 * - 再与资源 ACL（知识树受限目录、显式拒绝、笔记本共享）取交集；
 * - 已删除笔记本默认无权，只有回收站恢复流程显式传 includeDeleted。
 */
import { getDb } from "../db/schema";
import {
  getUserWorkspaceRole,
  hasPermission,
  resolveNotebookPermission,
  type Permission,
} from "../middleware/acl";
import {
  capabilitiesToLegacyPermission,
  resolveResourceKnowledgeAccessForTombstone,
} from "./knowledgeCapabilities";

/** 0 = 无权，1 = 只读，2 = 读写。与 api_token_resources 的 read / write 对应。 */
export type TokenNotebookLevel = 0 | 1 | 2;

export interface TokenNotebookAccess {
  level: TokenNotebookLevel;
  exists: boolean;
  workspaceId: string | null;
  ownerId: string | null;
}

/** 中间件写入、业务路由读取的受限 Token 笔记本白名单（已按当前权限复核）。 */
export const TOKEN_NOTEBOOK_SCOPE_HEADER = "X-Api-Allowed-Notebook-Ids";

const WRITE_ROLES = new Set(["owner", "admin", "editor"]);
const MEMBER_ROLES = new Set(["owner", "admin", "editor", "commenter", "viewer"]);

function levelOf(permission: Permission | null): TokenNotebookLevel {
  if (hasPermission(permission, "write")) return 2;
  return hasPermission(permission, "read") ? 1 : 0;
}

function tombstonePermission(
  notebookId: string,
  userId: string,
  notebook: { userId: string; workspaceId: string | null },
): Permission | null {
  const access = resolveResourceKnowledgeAccessForTombstone("notebook", notebookId, userId);
  if (access.nodeId) return capabilitiesToLegacyPermission(access.capabilities);
  // 尚无知识树节点的历史个人笔记本：只有所有者本人可恢复；其余情况一律拒绝。
  return !notebook.workspaceId && notebook.userId === userId ? "manage" : null;
}

export function resolveTokenNotebookAccess(
  userId: string,
  notebookId: string,
  options: { includeDeleted?: boolean } = {},
): TokenNotebookAccess {
  const notebook = notebookId
    ? getDb().prepare("SELECT userId, workspaceId, isDeleted FROM notebooks WHERE id = ?")
      .get(notebookId) as { userId: string; workspaceId: string | null; isDeleted: number } | undefined
    : undefined;
  if (!notebook || !userId) return { level: 0, exists: Boolean(notebook), workspaceId: null, ownerId: null };

  const base = { exists: true, workspaceId: notebook.workspaceId || null, ownerId: notebook.userId };
  if (notebook.isDeleted && !options.includeDeleted) return { ...base, level: 0 };

  let cap: TokenNotebookLevel = 2;
  if (base.workspaceId) {
    const role = getUserWorkspaceRole(base.workspaceId, userId);
    if (!role || !MEMBER_ROLES.has(role)) return { ...base, level: 0 };
    cap = WRITE_ROLES.has(role) ? 2 : 1;
  }

  const permission = notebook.isDeleted
    ? tombstonePermission(notebookId, userId, notebook)
    : resolveNotebookPermission(notebookId, userId).permission;
  return { ...base, level: Math.min(cap, levelOf(permission)) as TokenNotebookLevel };
}

/** 解析中间件下发的白名单；未下发（非 restricted Token）时返回 undefined。 */
export function tokenNotebookScopeFromHeader(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
