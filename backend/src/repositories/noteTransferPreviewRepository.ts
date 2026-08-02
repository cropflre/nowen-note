import type { DatabaseAdapter } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";

export type NoteTransferPermission = "read" | "comment" | "write" | "manage" | null;

export type NoteTransferPreviewNoteRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  notebookId: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string | null;
  isLocked: boolean | number | string;
  isTrashed: boolean | number | string;
  version: number | string;
  permission: string | null;
  workspaceRole: string | null;
};

export type NoteTransferPreviewNotebookRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  isDeleted: boolean | number | string;
  workspaceRole: string | null;
  notebookRole: string | null;
};

export type NoteTransferPreviewAttachmentRow = {
  id: string;
  noteId: string;
  path: string;
  filename: string;
  size: number | string;
  hash: string | null;
};

export type NoteTransferPreviewTagRow = {
  id: string;
  name: string;
};

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function rolePermission(role: string | null | undefined): NoteTransferPermission {
  if (role === "owner" || role === "admin" || role === "manage") return "manage";
  if (role === "editor" || role === "write") return "write";
  if (role === "commenter" || role === "comment") return "comment";
  if (role === "viewer" || role === "read") return "read";
  return null;
}

export function createNoteTransferPreviewRepository(adapter?: DatabaseAdapter) {
  const db = resolveAdapter(adapter);

  return {
    async loadNotes(input: {
      noteIds: string[];
      actorUserId: string;
    }): Promise<Array<NoteTransferPreviewNoteRow & { effectivePermission: NoteTransferPermission }>> {
      if (input.noteIds.length === 0) return [];
      const rows = await db.queryMany<NoteTransferPreviewNoteRow>(
        `SELECT note.id,
                note.userId,
                note.workspaceId,
                note.notebookId,
                note.title,
                note.content,
                note.contentText,
                note.contentFormat,
                note.isLocked,
                note.isTrashed,
                note.version,
                note_acl.permission,
                CASE
                  WHEN workspace.ownerId = ? THEN 'owner'
                  ELSE workspace_member.role
                END AS workspaceRole
           FROM notes note
           LEFT JOIN workspaces workspace
             ON workspace.id = note.workspaceId
           LEFT JOIN workspace_members workspace_member
             ON workspace_member.workspaceId = note.workspaceId
            AND workspace_member.userId = ?
           LEFT JOIN note_acl note_acl
             ON note_acl.noteId = note.id
            AND note_acl.userId = ?
          WHERE note.id IN (${placeholders(input.noteIds.length)})`,
        [input.actorUserId, input.actorUserId, input.actorUserId, ...input.noteIds],
      );

      const notebookIds = Array.from(new Set(rows.map((row) => row.notebookId).filter(Boolean)));
      const notebookRoles = new Map<string, string>();
      if (notebookIds.length > 0) {
        const memberships = await db.queryMany<{ notebookId: string; role: string }>(
          `SELECT notebookId, role
             FROM notebook_members
            WHERE userId = ?
              AND status = 'active'
              AND notebookId IN (${placeholders(notebookIds.length)})`,
          [input.actorUserId, ...notebookIds],
        );
        for (const membership of memberships) {
          notebookRoles.set(membership.notebookId, membership.role);
        }
      }

      return rows.map((row) => {
        let effectivePermission: NoteTransferPermission = null;
        if (row.userId === input.actorUserId) {
          effectivePermission = "manage";
        } else {
          const notebookRole = notebookRoles.get(row.notebookId);
          effectivePermission = rolePermission(notebookRole);
          if (!effectivePermission && row.workspaceId) {
            effectivePermission = row.permission === "read"
              || row.permission === "comment"
              || row.permission === "write"
              || row.permission === "manage"
              ? row.permission
              : rolePermission(row.workspaceRole);
          }
        }
        return { ...row, effectivePermission };
      });
    },

    async loadTargetNotebook(input: {
      notebookId: string;
      actorUserId: string;
    }): Promise<(NoteTransferPreviewNotebookRow & {
      effectiveWorkspaceRole: string | null;
      effectiveNotebookPermission: NoteTransferPermission;
    }) | null> {
      const row = await db.queryOne<NoteTransferPreviewNotebookRow>(
        `SELECT notebook.id,
                notebook.userId,
                notebook.workspaceId,
                notebook.isDeleted,
                CASE
                  WHEN workspace.ownerId = ? THEN 'owner'
                  ELSE workspace_member.role
                END AS workspaceRole,
                notebook_member.role AS notebookRole
           FROM notebooks notebook
           LEFT JOIN workspaces workspace
             ON workspace.id = notebook.workspaceId
           LEFT JOIN workspace_members workspace_member
             ON workspace_member.workspaceId = notebook.workspaceId
            AND workspace_member.userId = ?
           LEFT JOIN notebook_members notebook_member
             ON notebook_member.notebookId = notebook.id
            AND notebook_member.userId = ?
            AND notebook_member.status = 'active'
          WHERE notebook.id = ?`,
        [input.actorUserId, input.actorUserId, input.actorUserId, input.notebookId],
      );
      if (!row) return null;
      const effectiveWorkspaceRole = row.workspaceRole || null;
      const effectiveNotebookPermission = row.userId === input.actorUserId
        ? "manage"
        : rolePermission(row.notebookRole) || rolePermission(effectiveWorkspaceRole);
      return { ...row, effectiveWorkspaceRole, effectiveNotebookPermission };
    },

    async loadAttachments(noteIds: string[]): Promise<NoteTransferPreviewAttachmentRow[]> {
      if (noteIds.length === 0) return [];
      return db.queryMany<NoteTransferPreviewAttachmentRow>(
        `SELECT id, noteId, path, filename, size, hash
           FROM attachments
          WHERE noteId IN (${placeholders(noteIds.length)})
          ORDER BY createdAt ASC, id ASC`,
        noteIds,
      );
    },

    async loadTags(noteIds: string[]): Promise<NoteTransferPreviewTagRow[]> {
      if (noteIds.length === 0) return [];
      return db.queryMany<NoteTransferPreviewTagRow>(
        `SELECT DISTINCT tag.id, tag.name
           FROM tags tag
           JOIN note_tags note_tag ON note_tag.tagId = tag.id
          WHERE note_tag.noteId IN (${placeholders(noteIds.length)})
          ORDER BY lower(tag.name), tag.id`,
        noteIds,
      );
    },
  };
}

export const noteTransferPreviewRepository = createNoteTransferPreviewRepository();
