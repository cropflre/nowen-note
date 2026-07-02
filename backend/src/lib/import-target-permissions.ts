import { getDb } from "../db/schema";
import {
  getUserWorkspaceRole,
  hasPermission,
  hasRole,
  resolveNotebookPermission,
} from "../middleware/acl";

export type ImportTargetError = {
  status: 400 | 403 | 404;
  body: {
    error: string;
    code: string;
    required?: string;
    sourceWorkspaceId?: string | null;
    targetWorkspaceId?: string | null;
  };
};

export type WritableNotebookTarget =
  | { ok: true; notebookId: string; workspaceId: string | null }
  | ({ ok: false } & ImportTargetError);

export function normalizeImportWorkspaceId(raw: string | null | undefined): string | null {
  const ws = (raw || "").trim();
  if (!ws || ws === "personal" || ws === "null") return null;
  return ws;
}

export function requireWorkspaceWriteAccess(
  userId: string,
  workspaceId: string | null,
): ImportTargetError | null {
  if (!workspaceId) return null;
  const role = getUserWorkspaceRole(workspaceId, userId);
  if (hasRole(role, "editor")) return null;
  return {
    status: 403,
    body: {
      error: "您在该工作区无导入权限",
      code: "FORBIDDEN",
      required: "editor",
    },
  };
}

export function resolveWritableNotebookTarget(
  userId: string,
  notebookId: string,
  expectedWorkspaceId?: string | null,
): WritableNotebookTarget {
  const db = getDb();
  const nb = db
    .prepare("SELECT id, workspaceId, isDeleted FROM notebooks WHERE id = ?")
    .get(notebookId) as
    | { id: string; workspaceId: string | null; isDeleted: number }
    | undefined;

  if (!nb) {
    return {
      ok: false,
      status: 404,
      body: { error: "笔记本不存在", code: "NOTEBOOK_NOT_FOUND" },
    };
  }

  if (nb.isDeleted === 1) {
    return {
      ok: false,
      status: 400,
      body: { error: "笔记本已删除，无法导入", code: "NOTEBOOK_TRASHED" },
    };
  }

  const targetWorkspaceId = nb.workspaceId || null;
  const sourceWorkspaceId = expectedWorkspaceId ?? null;
  if (expectedWorkspaceId !== undefined && targetWorkspaceId !== sourceWorkspaceId) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "笔记本不属于当前导入工作区",
        code: "NOTEBOOK_WORKSPACE_MISMATCH",
        sourceWorkspaceId,
        targetWorkspaceId,
      },
    };
  }

  const { permission } = resolveNotebookPermission(notebookId, userId);
  if (!hasPermission(permission, "write")) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "您在该笔记本无导入权限",
        code: "FORBIDDEN",
        required: "write",
      },
    };
  }

  return { ok: true, notebookId, workspaceId: targetWorkspaceId };
}
