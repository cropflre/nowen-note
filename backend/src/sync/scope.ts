import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import { getUserWorkspaceRole, type WorkspaceRole } from "../middleware/acl";
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
  access: SyncScopeAccessStatus;
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

export function workspaceScopeKey(workspaceId: string): string {
  const normalizedId = workspaceId.trim();
  if (!normalizedId) throw new SyncError("INVALID_PAYLOAD", "工作区 ID 不能为空");
  return `${SYNC_WORKSPACE_SCOPE_PREFIX}${normalizedId}`;
}

export function parseSyncScopeKey(scopeKey?: string | null): {
  scopeKey: string;
  workspaceId: string | null;
} {
  const normalizedKey = scopeKey?.trim() || SYNC_PERSONAL_SCOPE_KEY;
  if (normalizedKey === SYNC_PERSONAL_SCOPE_KEY) {
    return { scopeKey: SYNC_PERSONAL_SCOPE_KEY, workspaceId: null };
  }
  if (!normalizedKey.startsWith(SYNC_WORKSPACE_SCOPE_PREFIX)) {
    throw new SyncError("INVALID_PAYLOAD", "同步作用域格式不合法");
  }
  const workspaceId = normalizedKey.slice(SYNC_WORKSPACE_SCOPE_PREFIX.length).trim();
  if (!workspaceId) throw new SyncError("INVALID_PAYLOAD", "工作区 ID 不能为空");
  return { scopeKey: workspaceScopeKey(workspaceId), workspaceId };
}

function canWrite(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin" || role === "editor";
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
           m.allowDownload, m.allowReshare, m.source, m.sourceId, m.updatedAt
    FROM notebook_members m
    JOIN notebooks n ON n.id = m.notebookId
    WHERE n.workspaceId = ?
    ORDER BY m.notebookId, m.userId, m.id
  `).all(workspaceId);

  // notebook 成员与 note ACL 已覆盖当前有效权限面；知识树权限待字段契约明确后纳入。
  return sha256(JSON.stringify({ workspace, members, noteAcl, notebookMembers }));
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
    access: canWrite(role) ? "write" : "read",
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
    access: "write",
    accessFingerprint: sha256(`personal:${userId}`),
  };
  const rows = db.prepare(`
    SELECT w.id, w.name, w.updatedAt, wm.role
    FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspaceId
    WHERE wm.userId = ?
    ORDER BY w.id
  `).all(userId) as Array<WorkspaceRow & { role: WorkspaceRole }>;
  return [personal, ...rows.map((row) => descriptorForWorkspace(db, row, row.role))];
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
      access: "write",
      accessFingerprint: sha256(`personal:${userId}`),
    };
  }

  const workspace = db.prepare(`
    SELECT id, name, updatedAt
    FROM workspaces
    WHERE id = ?
  `).get(parsed.workspaceId) as WorkspaceRow | undefined;
  const role = workspace ? getUserWorkspaceRole(parsed.workspaceId, userId) : null;
  if (!workspace || !role) {
    throw new SyncError("ACCESS_REVOKED", "工作区不存在或访问权已撤销");
  }
  if (access === "write" && !canWrite(role)) {
    throw new SyncError("SCOPE_FORBIDDEN", "当前角色不允许写入该工作区");
  }
  return descriptorForWorkspace(db, workspace, role);
}
