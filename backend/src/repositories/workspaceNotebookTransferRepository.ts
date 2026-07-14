import { getDb } from "../db/schema";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import { syncNoteLinks } from "../lib/noteLinks";

export interface TransferNotebookInsert {
  id: string;
  userId: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  isExpanded: number;
}

export interface TransferNoteInsert {
  id: string;
  userId: string;
  workspaceId: string;
  notebookId: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  isPinned: number;
  sortOrder: number;
}

export interface TransferAttachmentInsert {
  id: string;
  noteId: string;
  userId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  workspaceId: string;
  hash: string | null;
}

export interface TransferTagInsert {
  id: string;
  userId: string;
  workspaceId: string;
  name: string;
  color: string;
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

/**
 * SQLite compatibility boundary for copying a personal notebook tree into a workspace.
 * The service owns validation, ID rewriting, filesystem copies and error mapping; this
 * repository owns the single database transaction and all SQL used by that workflow.
 */
export const workspaceNotebookTransferRepository = {
  runAtomically<T>(work: () => T): T {
    return getDb().transaction(work)();
  },

  findNotebook<T>(notebookId: string): T | undefined {
    return getDb().prepare("SELECT * FROM notebooks WHERE id = ?").get(notebookId) as T | undefined;
  },

  findTargetParent<T>(notebookId: string): T | undefined {
    return getDb()
      .prepare("SELECT id, workspaceId, isDeleted FROM notebooks WHERE id = ?")
      .get(notebookId) as T | undefined;
  },

  listPersonalNotebooks<T>(userId: string): T[] {
    return getDb()
      .prepare("SELECT * FROM notebooks WHERE userId = ? AND workspaceId IS NULL AND isDeleted = 0")
      .all(userId) as T[];
  },

  insertNotebook(input: TransferNotebookInsert): void {
    getDb()
      .prepare(
        `INSERT INTO notebooks (id, userId, workspaceId, parentId, name, description, icon, color, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, datetime('now'), datetime('now'))`,
      )
      .run(
        input.id,
        input.userId,
        input.workspaceId,
        input.parentId,
        input.name,
        input.description,
        input.icon,
        input.color,
        input.sortOrder,
        input.isExpanded,
      );
  },

  listSourceNotes<T>(notebookIds: string[], userId: string): T[] {
    if (notebookIds.length === 0) return [];
    return getDb()
      .prepare(
        `SELECT id, userId, workspaceId, notebookId, title, content, contentText, contentFormat, isPinned, sortOrder
           FROM notes
          WHERE notebookId IN (${placeholders(notebookIds)})
            AND userId = ?
            AND workspaceId IS NULL
            AND isTrashed = 0`,
      )
      .all(...notebookIds, userId) as T[];
  },

  listAttachmentsByNoteIds<T>(noteIds: string[]): T[] {
    if (noteIds.length === 0) return [];
    return getDb()
      .prepare(`SELECT * FROM attachments WHERE noteId IN (${placeholders(noteIds)})`)
      .all(...noteIds) as T[];
  },

  insertNote(input: TransferNoteInsert): void {
    getDb()
      .prepare(
        `INSERT INTO notes (id, userId, workspaceId, notebookId, title, content, contentText, contentFormat, isPinned, isFavorite, isLocked, isArchived, isTrashed, version, sortOrder, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1, ?, datetime('now'), datetime('now'))`,
      )
      .run(
        input.id,
        input.userId,
        input.workspaceId,
        input.notebookId,
        input.title,
        input.content,
        input.contentText,
        input.contentFormat,
        input.isPinned,
        input.sortOrder,
      );
  },

  insertAttachment(input: TransferAttachmentInsert): void {
    getDb()
      .prepare(
        `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.noteId,
        input.userId,
        input.filename,
        input.mimeType,
        input.size,
        input.path,
        input.workspaceId,
        input.hash,
      );
  },

  listNoteTags(noteIds: string[]): Array<{ noteId: string; tagId: string }> {
    if (noteIds.length === 0) return [];
    return getDb()
      .prepare(`SELECT noteId, tagId FROM note_tags WHERE noteId IN (${placeholders(noteIds)})`)
      .all(...noteIds) as Array<{ noteId: string; tagId: string }>;
  },

  listTagsByIds<T>(tagIds: string[]): T[] {
    if (tagIds.length === 0) return [];
    return getDb()
      .prepare(`SELECT * FROM tags WHERE id IN (${placeholders(tagIds)})`)
      .all(...tagIds) as T[];
  },

  findWorkspaceTagByName<T>(userId: string, name: string, workspaceId: string): T | undefined {
    return getDb()
      .prepare("SELECT * FROM tags WHERE userId = ? AND name = ? AND workspaceId = ? LIMIT 1")
      .get(userId, name, workspaceId) as T | undefined;
  },

  findPersonalTagByName<T>(userId: string, name: string): T | undefined {
    return getDb()
      .prepare("SELECT * FROM tags WHERE userId = ? AND name = ? AND workspaceId IS NULL LIMIT 1")
      .get(userId, name) as T | undefined;
  },

  findAnyTagByName<T>(userId: string, name: string): T | undefined {
    return getDb()
      .prepare("SELECT * FROM tags WHERE userId = ? AND name = ? LIMIT 1")
      .get(userId, name) as T | undefined;
  },

  insertTag(input: TransferTagInsert): void {
    getDb()
      .prepare("INSERT INTO tags (id, userId, workspaceId, name, color) VALUES (?, ?, ?, ?, ?)")
      .run(input.id, input.userId, input.workspaceId, input.name, input.color);
  },

  insertNoteTag(noteId: string, tagId: string): void {
    getDb()
      .prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)")
      .run(noteId, tagId);
  },

  syncDerivedReferences(userId: string, noteId: string, content: string): void {
    syncAttachmentReferences(undefined, noteId, content);
    syncNoteLinks(undefined, userId, noteId, content);
  },
};
