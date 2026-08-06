import type { DatabaseAdapter, DbStatement } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";
import type { Permission } from "../middleware/acl";
import { NoteCoreRuntimeError } from "./note-core-runtime";

const PERMISSION_LEVEL: Record<Permission, number> = {
  read: 1,
  comment: 2,
  write: 3,
  manage: 4,
};

const ROLE_PERMISSION: Record<string, Permission> = {
  owner: "manage",
  admin: "manage",
  manage: "manage",
  editor: "write",
  write: "write",
  commenter: "comment",
  comment: "comment",
  viewer: "read",
  read: "read",
};

const LIFECYCLE_FIELDS = new Set(["isTrashed", "sortOrder", "notebookId"]);

interface RoleRow {
  role: string;
}

interface PermissionRow {
  permission: string;
}

interface NoteScopeRow {
  userId: string;
  notebookId: string;
  workspaceId: string | null;
  isLocked: boolean | number;
}

interface NotebookScopeRow {
  userId: string;
  workspaceId: string | null;
  isDeleted: boolean | number;
}

interface WorkspaceScopeRow {
  ownerId: string;
}

interface TrashSummaryRow {
  count: number | string | null;
  skipped: number | string | null;
}

export interface NoteLifecycleInput {
  isTrashed?: unknown;
  sortOrder?: unknown;
  notebookId?: unknown;
  [key: string]: unknown;
}

export interface NoteReorderItem {
  id: string;
  sortOrder: number;
}

export interface NoteTrashSummary {
  count: number;
  skipped: number;
}

function hasPermission(actual: Permission | null, required: Permission): boolean {
  return Boolean(actual && PERMISSION_LEVEL[actual] >= PERMISSION_LEVEL[required]);
}

function rolePermission(role: string | null | undefined): Permission | null {
  if (!role || role === "none") return null;
  return ROLE_PERMISSION[role] ?? null;
}

function booleanInput(value: unknown, field: string): number {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  throw new NoteCoreRuntimeError(
    `${field} 必须是 boolean 或 0/1`,
    "INVALID_BOOLEAN_FIELD",
    400,
    { field },
  );
}

function integerInput(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new NoteCoreRuntimeError(`${field} 必须是安全整数`, "INVALID_INTEGER_FIELD", 400, { field });
  }
  return parsed;
}

function normalizeTrashSummary(row: TrashSummaryRow | undefined): NoteTrashSummary {
  return {
    count: Number(row?.count ?? 0),
    skipped: Number(row?.skipped ?? 0),
  };
}

export function createNoteLifecycleRuntime(adapter?: DatabaseAdapter) {
  const db = adapter ?? getDatabaseAdapter();

  async function resolveNotePermission(
    noteId: string,
    userId: string,
  ): Promise<{ permission: Permission | null; scope?: NoteScopeRow }> {
    const scope = await db.queryOne<NoteScopeRow>(
      `SELECT "userId" AS "userId", "notebookId" AS "notebookId",
              "workspaceId" AS "workspaceId", "isLocked" AS "isLocked"
         FROM notes WHERE id = ?`,
      [noteId],
    );
    if (!scope) return { permission: null };
    if (scope.userId === userId) return { permission: "manage", scope };

    const notebookMember = await db.queryOne<RoleRow>(
      `SELECT role FROM notebook_members
        WHERE "notebookId" = ? AND "userId" = ? AND status = 'active'
        LIMIT 1`,
      [scope.notebookId, userId],
    );
    if (notebookMember) return { permission: rolePermission(notebookMember.role), scope };

    if (!scope.workspaceId) return { permission: null, scope };

    const acl = await db.queryOne<PermissionRow>(
      `SELECT permission FROM note_acl WHERE "noteId" = ? AND "userId" = ?`,
      [noteId, userId],
    );
    if (acl) {
      return {
        permission: acl.permission in PERMISSION_LEVEL ? acl.permission as Permission : null,
        scope,
      };
    }

    const workspaceMember = await db.queryOne<RoleRow>(
      `SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?`,
      [scope.workspaceId, userId],
    );
    return { permission: rolePermission(workspaceMember?.role), scope };
  }

  async function resolveNotebookPermission(
    notebookId: string,
    userId: string,
  ): Promise<{ permission: Permission | null; scope?: NotebookScopeRow }> {
    const scope = await db.queryOne<NotebookScopeRow>(
      `SELECT "userId" AS "userId", "workspaceId" AS "workspaceId", "isDeleted" AS "isDeleted"
         FROM notebooks WHERE id = ?`,
      [notebookId],
    );
    if (!scope) return { permission: null };
    if (scope.userId === userId) return { permission: "manage", scope };

    const notebookMember = await db.queryOne<RoleRow>(
      `SELECT role FROM notebook_members
        WHERE "notebookId" = ? AND "userId" = ? AND status = 'active'
        LIMIT 1`,
      [notebookId, userId],
    );
    if (notebookMember) return { permission: rolePermission(notebookMember.role), scope };

    if (!scope.workspaceId) return { permission: null, scope };
    const workspaceMember = await db.queryOne<RoleRow>(
      `SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?`,
      [scope.workspaceId, userId],
    );
    return { permission: rolePermission(workspaceMember?.role), scope };
  }

  async function resolveWorkspacePermission(
    workspaceId: string,
    userId: string,
  ): Promise<Permission | null> {
    const workspace = await db.queryOne<WorkspaceScopeRow>(
      `SELECT "ownerId" AS "ownerId" FROM workspaces WHERE id = ?`,
      [workspaceId],
    );
    if (!workspace) return null;
    if (workspace.ownerId === userId) return "manage";
    const member = await db.queryOne<RoleRow>(
      `SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?`,
      [workspaceId, userId],
    );
    return rolePermission(member?.role);
  }

  async function getTrashSummary(
    userId: string,
    requestedWorkspaceId?: string,
  ): Promise<NoteTrashSummary> {
    const workspaceId = requestedWorkspaceId?.trim();
    if (!workspaceId || workspaceId === "personal") {
      const row = await db.queryOne<TrashSummaryRow>(
        `SELECT
           COALESCE(SUM(CASE WHEN "isLocked" = 0 THEN 1 ELSE 0 END), 0) AS count,
           COALESCE(SUM(CASE WHEN "isLocked" = 1 THEN 1 ELSE 0 END), 0) AS skipped
         FROM notes
         WHERE "userId" = ? AND "workspaceId" IS NULL AND "isTrashed" = 1`,
        [userId],
      );
      return normalizeTrashSummary(row);
    }

    const permission = await resolveWorkspacePermission(workspaceId, userId);
    if (!hasPermission(permission, "manage")) {
      throw new NoteCoreRuntimeError(
        "仅工作区管理员可查看回收站摘要",
        "FORBIDDEN",
        403,
      );
    }
    const row = await db.queryOne<TrashSummaryRow>(
      `SELECT
         COALESCE(SUM(CASE WHEN "isLocked" = 0 THEN 1 ELSE 0 END), 0) AS count,
         COALESCE(SUM(CASE WHEN "isLocked" = 1 THEN 1 ELSE 0 END), 0) AS skipped
       FROM notes
       WHERE "workspaceId" = ? AND "isTrashed" = 1`,
      [workspaceId],
    );
    return normalizeTrashSummary(row);
  }

  async function updateNote(
    userId: string,
    noteId: string,
    input: NoteLifecycleInput,
  ): Promise<{ changed: boolean }> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new NoteCoreRuntimeError("请求格式错误", "INVALID_BODY", 400);
    }

    const unsupported = Object.keys(input).filter((key) => key !== "version" && !LIFECYCLE_FIELDS.has(key));
    if (unsupported.length > 0) {
      throw new NoteCoreRuntimeError(
        `PostgreSQL Runtime 尚未迁移生命周期字段：${unsupported.join(", ")}`,
        "POSTGRES_NOTE_FIELD_MIGRATION_PENDING",
        503,
        { fields: unsupported },
      );
    }

    const requested = [...LIFECYCLE_FIELDS].some((field) => input[field] !== undefined);
    if (!requested) return { changed: false };

    const resolved = await resolveNotePermission(noteId, userId);
    if (!resolved.scope) throw new NoteCoreRuntimeError("Note not found", "NOT_FOUND", 404);
    if (!hasPermission(resolved.permission, "write")) {
      throw new NoteCoreRuntimeError("权限不足", "FORBIDDEN", 403);
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.isTrashed !== undefined) {
      const isTrashed = booleanInput(input.isTrashed, "isTrashed");
      sets.push('"isTrashed" = ?');
      params.push(isTrashed);
      sets.push(`"trashedAt" = ${isTrashed === 1 ? "CURRENT_TIMESTAMP" : "NULL"}`);
    }

    if (input.sortOrder !== undefined) {
      sets.push('"sortOrder" = ?');
      params.push(integerInput(input.sortOrder, "sortOrder"));
    }

    if (input.notebookId !== undefined) {
      if (resolved.scope.isLocked === true || resolved.scope.isLocked === 1) {
        throw new NoteCoreRuntimeError("Note is locked", "NOTE_LOCKED", 403);
      }
      if (typeof input.notebookId !== "string" || !input.notebookId.trim()) {
        throw new NoteCoreRuntimeError("notebookId 必须是非空字符串", "INVALID_NOTEBOOK_ID", 400);
      }
      const targetId = input.notebookId.trim();
      const target = await resolveNotebookPermission(targetId, userId);
      if (!target.scope) throw new NoteCoreRuntimeError("目标笔记本不存在", "NOTEBOOK_NOT_FOUND", 404);
      if (target.scope.isDeleted === true || target.scope.isDeleted === 1) {
        throw new NoteCoreRuntimeError("目标笔记本已删除", "NOTEBOOK_TRASHED", 400);
      }
      if ((resolved.scope.workspaceId || null) !== (target.scope.workspaceId || null)) {
        throw new NoteCoreRuntimeError(
          "不能跨工作区移动笔记",
          "CROSS_WORKSPACE_MOVE_FORBIDDEN",
          400,
          {
            sourceWorkspaceId: resolved.scope.workspaceId || null,
            targetWorkspaceId: target.scope.workspaceId || null,
          },
        );
      }
      if (!hasPermission(target.permission, "write")) {
        throw new NoteCoreRuntimeError("您对目标笔记本无权限", "FORBIDDEN", 403);
      }
      sets.push('"notebookId" = ?');
      params.push(targetId);
    }

    sets.push('"updatedAt" = CURRENT_TIMESTAMP');
    params.push(noteId);
    await db.executeStatements([{
      sql: `UPDATE notes SET ${sets.join(", ")} WHERE id = ?`,
      params,
      requireChanges: 1,
    }]);
    return { changed: true };
  }

  async function reorderNotes(
    userId: string,
    items: NoteReorderItem[],
  ): Promise<{ success: true; updated: number; skipped: string[] }> {
    if (!Array.isArray(items)) {
      throw new NoteCoreRuntimeError("items is required", "INVALID_BODY", 400);
    }
    if (items.length > 1_000) {
      throw new NoteCoreRuntimeError("批量排序最多支持 1000 条", "TOO_MANY_ITEMS", 400);
    }

    const statements: DbStatement[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (!item || typeof item.id !== "string" || !item.id.trim() || seen.has(item.id)) {
        throw new NoteCoreRuntimeError("排序项 id 无效或重复", "INVALID_REORDER_ITEM", 400);
      }
      seen.add(item.id);
      const sortOrder = integerInput(item.sortOrder, "sortOrder");
      const resolved = await resolveNotePermission(item.id, userId);
      if (!hasPermission(resolved.permission, "write")) {
        skipped.push(item.id);
        continue;
      }
      statements.push({
        sql: `UPDATE notes SET "sortOrder" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ?`,
        params: [sortOrder, item.id],
        requireChanges: 1,
      });
    }

    if (statements.length > 0) await db.executeStatements(statements);
    return { success: true, updated: statements.length, skipped };
  }

  return { getTrashSummary, updateNote, reorderNotes };
}

export default createNoteLifecycleRuntime;