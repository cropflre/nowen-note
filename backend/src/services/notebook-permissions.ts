import type { Permission } from "../middleware/acl";
import { getDb } from "../db/schema";

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
  const db = getDb();
  const row = db
    .prepare(
      `SELECT role
         FROM notebook_members
        WHERE notebookId = ? AND userId = ? AND status = 'active'`,
    )
    .get(notebookId, userId) as { role: string } | undefined;
  return notebookRoleToPermission(row?.role);
}

export function resolveNoteNotebookMemberPermission(
  noteId: string,
  userId: string,
): Permission | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT nm.role
         FROM notes n
         JOIN notebook_members nm ON nm.notebookId = n.notebookId
        WHERE n.id = ? AND nm.userId = ? AND nm.status = 'active'`,
    )
    .get(noteId, userId) as { role: string } | undefined;
  return notebookRoleToPermission(row?.role);
}

export function listSharedNotebookIds(userId: string): string[] {
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT nm.notebookId
           FROM notebook_members nm
           JOIN notebooks nb ON nb.id = nm.notebookId
          WHERE nm.userId = ?
            AND nm.status = 'active'
            AND nb.userId <> ?
            AND nb.isDeleted = 0
          ORDER BY nb.updatedAt DESC, nb.id ASC`,
      )
      .all(userId, userId) as { notebookId: string }[]
  ).map((row) => row.notebookId);
}
