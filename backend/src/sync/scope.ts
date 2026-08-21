import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import type { WorkspaceRole } from "../middleware/acl";
import {
  SYNC_PERSONAL_SCOPE_KEY,
  SYNC_WORKSPACE_SCOPE_PREFIX,
} from "./constants";
import { SyncError } from "./errors";

export type SyncScopeAccessStatus = "read" | "write";

export interface SyncScopeDescriptor {
  scopeKey: string;
  workspaceId: string | null;
  role: WorkspaceRole | null;
  canWrite: boolean;
  accessFingerprint: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  updatedAt: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateWorkspaceId(workspaceId: string): string {
  const normalizedId = workspaceId.trim();
  if (!normalizedId) throw new SyncError("INVALID_PAYLOAD", "工作区 ID 不能为空");
  if (normalizedId.length > 128) {
    throw new SyncError("INVALID_PAYLOAD", "工作区 ID 长度不能超过 128 个字符");
  }
  if (
    normalizedId.includes(SYNC_WORKSPACE_SCOPE_PREFIX)
    || /[\s\u0000-\u001f\u007f]/u.test(normalizedId)
  ) {
    throw new SyncError("INVALID_PAYLOAD", "工作区 ID 格式不合法");
  }
  return normalizedId;
}

export function workspaceScopeKey(workspaceId: string): string {
  const normalizedId = validateWorkspaceId(workspaceId);
  const scopeKey = `${SYNC_WORKSPACE_SCOPE_PREFIX}${normalizedId}`;
  if (scopeKey.length > 160) {
    throw new SyncError("INVALID_PAYLOAD", "同步作用域键长度不能超过 160 个字符");
  }
  return scopeKey;
}

export function parseSyncScopeKey(scopeKey: string | null | undefined): {
  scopeKey: string;
  workspaceId: string | null;
} {
  if (scopeKey === null || scopeKey === undefined) {
    return { scopeKey: SYNC_PERSONAL_SCOPE_KEY, workspaceId: null };
  }
  const normalizedKey = scopeKey.trim();
  if (!normalizedKey) throw new SyncError("INVALID_PAYLOAD", "同步作用域不能为空");
  if (normalizedKey === SYNC_PERSONAL_SCOPE_KEY) {
    return { scopeKey: SYNC_PERSONAL_SCOPE_KEY, workspaceId: null };
  }
  if (!normalizedKey.startsWith(SYNC_WORKSPACE_SCOPE_PREFIX)) {
    throw new SyncError("INVALID_PAYLOAD", "同步作用域格式不合法");
  }
  const workspaceId = validateWorkspaceId(
    normalizedKey.slice(SYNC_WORKSPACE_SCOPE_PREFIX.length),
  );
  return { scopeKey: workspaceScopeKey(workspaceId), workspaceId };
}

function canWriteWorkspaceScope(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin" || role === "editor";
}

function isWorkspaceRole(role: unknown): role is WorkspaceRole {
  return role === "owner"
    || role === "admin"
    || role === "editor"
    || role === "commenter"
    || role === "viewer";
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function workspaceAccessFingerprint(db: Database.Database, workspaceId: string): string {
  const workspace = db.prepare(`
    SELECT id, name, updatedAt
    FROM workspaces
    WHERE id = ?
  `).get(workspaceId);
  const members = db.prepare(`
    SELECT workspaceId, userId, role, joinedAt
    FROM workspace_members
    WHERE workspaceId = ?
    ORDER BY userId, role, joinedAt
  `).all(workspaceId);
  const noteAcl = db.prepare(`
    SELECT a.noteId, a.userId, a.permission, a.grantedBy, a.createdAt
    FROM note_acl a
    JOIN notes n ON n.id = a.noteId
    WHERE n.workspaceId = ?
    ORDER BY a.noteId, a.userId, a.permission, a.grantedBy, a.createdAt
  `).all(workspaceId);
  const notebookMembers = db.prepare(`
    SELECT m.id, m.notebookId, m.userId, m.role, m.status,
           m.allowDownload, m.allowReshare, m.source, m.sourceId,
           m.invitedBy, m.createdAt, m.updatedAt
    FROM notebook_members m
    JOIN notebooks n ON n.id = m.notebookId
    WHERE n.workspaceId = ?
    ORDER BY m.notebookId, m.userId, m.id
  `).all(workspaceId);
  const hasKnowledgeTreeNodes = tableExists(db, "knowledge_tree_nodes");
  const knowledgeTreeNodes = hasKnowledgeTreeNodes
    ? db.prepare(`
        SELECT id, userId, workspaceId, scopeKey, parentId, nodeType,
               resourceType, resourceId, isDeleted, updatedAt
        FROM knowledge_tree_nodes
        WHERE workspaceId = ?
        ORDER BY id
      `).all(workspaceId)
    : [];
  const knowledgeTreeAcl = hasKnowledgeTreeNodes && tableExists(db, "knowledge_tree_acl")
    ? db.prepare(`
        SELECT a.nodeId, a.userId, a.rolePreset,
               a.canView, a.canComment, a.canCreate, a.canEdit, a.canDelete,
               a.canMove, a.canDownload, a.canReshare, a.canManageMembers,
               a.grantedBy, a.createdAt, a.updatedAt
        FROM knowledge_tree_acl a
        JOIN knowledge_tree_nodes n ON n.id = a.nodeId
        WHERE n.workspaceId = ?
        ORDER BY a.nodeId, a.userId
      `).all(workspaceId)
    : [];
  const knowledgeTreeAccessPolicies = hasKnowledgeTreeNodes
    && tableExists(db, "knowledge_tree_access_policies")
    ? db.prepare(`
        SELECT p.nodeId, p.accessMode, p.isExplicit, p.updatedBy,
               p.createdAt, p.updatedAt
        FROM knowledge_tree_access_policies p
        JOIN knowledge_tree_nodes n ON n.id = p.nodeId
        WHERE n.workspaceId = ?
        ORDER BY p.nodeId
      `).all(workspaceId)
    : [];
  const knowledgeTreeDenials = hasKnowledgeTreeNodes
    && tableExists(db, "knowledge_tree_denials")
    ? db.prepare(`
        SELECT d.nodeId, d.userId, d.deniedBy, d.createdAt, d.updatedAt
        FROM knowledge_tree_denials d
        JOIN knowledge_tree_nodes n ON n.id = d.nodeId
        WHERE n.workspaceId = ?
        ORDER BY d.nodeId, d.userId
      `).all(workspaceId)
    : [];

  return sha256(JSON.stringify({
    workspace,
    members,
    noteAcl,
    notebookMembers,
    knowledgeTreeNodes,
    knowledgeTreeAcl,
    knowledgeTreeAccessPolicies,
    knowledgeTreeDenials,
  }));
}

function descriptorForWorkspace(
  db: Database.Database,
  workspace: WorkspaceRow,
  role: WorkspaceRole,
): SyncScopeDescriptor {
  return {
    scopeKey: workspaceScopeKey(workspace.id),
    workspaceId: workspace.id,
    role,
    canWrite: canWriteWorkspaceScope(role),
    accessFingerprint: workspaceAccessFingerprint(db, workspace.id),
  };
}

export function listAuthorizedScopes(
  db: Database.Database,
  userId: string,
): SyncScopeDescriptor[] {
  const personal: SyncScopeDescriptor = {
    scopeKey: SYNC_PERSONAL_SCOPE_KEY,
    workspaceId: null,
    role: null,
    canWrite: true,
    accessFingerprint: sha256(`personal:${userId}`),
  };
  const rows = db.prepare(`
    SELECT w.id, w.name, w.updatedAt, wm.role
    FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspaceId
    WHERE wm.userId = ?
    ORDER BY w.id
  `).all(userId) as Array<WorkspaceRow & { role: unknown }>;
  return [
    personal,
    ...rows
      .filter((row): row is WorkspaceRow & { role: WorkspaceRole } => isWorkspaceRole(row.role))
      .map((row) => descriptorForWorkspace(db, row, row.role)),
  ];
}

export function resolveAuthorizedScope(
  db: Database.Database,
  userId: string,
  scopeKey: string | null | undefined,
  access: SyncScopeAccessStatus = "read",
): SyncScopeDescriptor {
  const parsed = parseSyncScopeKey(scopeKey);
  if (!parsed.workspaceId) {
    return {
      scopeKey: SYNC_PERSONAL_SCOPE_KEY,
      workspaceId: null,
      role: null,
      canWrite: true,
      accessFingerprint: sha256(`personal:${userId}`),
    };
  }

  const workspace = db.prepare(`
    SELECT id, name, updatedAt
    FROM workspaces
    WHERE id = ?
  `).get(parsed.workspaceId) as WorkspaceRow | undefined;
  const member = workspace
    ? db.prepare(`
        SELECT role
        FROM workspace_members
        WHERE workspaceId = ? AND userId = ?
      `).get(parsed.workspaceId, userId) as { role: unknown } | undefined
    : undefined;
  const role = isWorkspaceRole(member?.role) ? member.role : null;
  if (!workspace || !role) {
    throw new SyncError("ACCESS_REVOKED", "工作区不存在或访问权已撤销");
  }
  if (access === "write" && !canWriteWorkspaceScope(role)) {
    // Workspace 角色只是粗粒度 gate；mutation 仍必须逐实体调用现有权限解析，不能以此替代 ACL。
    throw new SyncError("SCOPE_FORBIDDEN", "当前角色不允许写入该工作区");
  }
  return descriptorForWorkspace(db, workspace, role);
}
