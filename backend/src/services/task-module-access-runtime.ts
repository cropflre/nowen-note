import type { DatabaseAdapter } from "../db/adapters/types";

export type TaskWorkspaceRole = "owner" | "admin" | "editor" | "commenter" | "viewer";

export interface TaskScopedResource {
  userId: string;
  workspaceId: string | null;
}

export type TaskModuleScope =
  | { kind: "personal"; userId: string; workspaceId: null; role: null }
  | { kind: "workspace"; userId: string; workspaceId: string; role: TaskWorkspaceRole };

export type TaskScopeResolution =
  | { ok: true; scope: TaskModuleScope }
  | { ok: false; status: 403; code: "FORBIDDEN" | "FEATURE_DISABLED"; error: string };

const ROLE_RANK: Record<TaskWorkspaceRole, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  admin: 4,
  owner: 5,
};

function parseRole(value: string | null | undefined): TaskWorkspaceRole | null {
  return value === "owner" || value === "admin" || value === "editor" || value === "commenter" || value === "viewer"
    ? value
    : null;
}

function parseFeatures(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function createTaskModuleAccessRuntime(adapter: DatabaseAdapter) {
  async function workspaceAccess(workspaceId: string, userId: string): Promise<{
    role: TaskWorkspaceRole;
    tasksEnabled: boolean;
  } | null> {
    const row = await adapter.queryOne<{ role: string; enabledFeatures: string | null }>(
      `SELECT wm.role,
              w."enabledFeatures" AS "enabledFeatures"
         FROM workspace_members wm
         JOIN workspaces w ON w.id = wm."workspaceId"
        WHERE wm."workspaceId" = ? AND wm."userId" = ?`,
      [workspaceId, userId],
    );
    const role = parseRole(row?.role);
    if (!row || !role) return null;
    return {
      role,
      tasksEnabled: parseFeatures(row.enabledFeatures).tasks !== false,
    };
  }

  async function resolveScope(rawWorkspaceId: string | null | undefined, userId: string): Promise<TaskScopeResolution> {
    if (!rawWorkspaceId || rawWorkspaceId === "personal") {
      return { ok: true, scope: { kind: "personal", userId, workspaceId: null, role: null } };
    }
    const access = await workspaceAccess(rawWorkspaceId, userId);
    if (!access) {
      return { ok: false, status: 403, code: "FORBIDDEN", error: "无权访问该工作区" };
    }
    if (!access.tasksEnabled) {
      return {
        ok: false,
        status: 403,
        code: "FEATURE_DISABLED",
        error: "该功能在当前工作区已被管理员关闭",
      };
    }
    return {
      ok: true,
      scope: {
        kind: "workspace",
        userId,
        workspaceId: rawWorkspaceId,
        role: access.role,
      },
    };
  }

  async function canRead(resource: TaskScopedResource, actorId: string): Promise<boolean> {
    if (!resource.workspaceId) return resource.userId === actorId;
    const access = await workspaceAccess(resource.workspaceId, actorId);
    return !!access?.tasksEnabled;
  }

  async function canManageOwnedResource(resource: TaskScopedResource, actorId: string): Promise<boolean> {
    if (resource.userId === actorId) {
      if (!resource.workspaceId) return true;
      return !!(await workspaceAccess(resource.workspaceId, actorId))?.tasksEnabled;
    }
    if (!resource.workspaceId) return false;
    const access = await workspaceAccess(resource.workspaceId, actorId);
    if (!access?.tasksEnabled) return false;
    return access.role === "owner" || access.role === "admin";
  }

  async function canEditWorkspace(workspaceId: string, actorId: string): Promise<boolean> {
    const access = await workspaceAccess(workspaceId, actorId);
    if (!access?.tasksEnabled) return false;
    return ROLE_RANK[access.role] >= ROLE_RANK.editor;
  }

  return {
    workspaceAccess,
    resolveScope,
    canRead,
    canManageOwnedResource,
    canEditWorkspace,
  };
}
