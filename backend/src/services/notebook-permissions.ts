import type { Permission } from "../middleware/acl";
import { memberQueryService } from "../queries";

export type NotebookRole = "owner" | "editor" | "viewer";

const NOTEBOOK_ROLE_PERMISSIONS: Record<NotebookRole, Permission> = {
  owner: "manage",
  editor: "write",
  viewer: "read",
};

export function notebookRoleToPermission(role: string | null | undefined): Permission | null {
  if (role === "owner" || role === "editor" || role === "viewer") {
    return NOTEBOOK_ROLE_PERMISSIONS[role];
  }
  return null;
}

export function resolveNotebookMemberPermission(
  notebookId: string,
  userId: string,
): Permission | null {
  const row = memberQueryService.getNotebookMemberRole(notebookId, userId);
  return notebookRoleToPermission(row?.role);
}

export function resolveNoteNotebookMemberPermission(
  noteId: string,
  userId: string,
): Permission | null {
  const row = memberQueryService.getNoteNotebookMemberRole(noteId, userId);
  return notebookRoleToPermission(row?.role);
}

export function listSharedNotebookIds(userId: string): string[] {
  return memberQueryService.listSharedNotebookIds(userId);
}
