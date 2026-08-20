import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import type Database from "better-sqlite3";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole, hasPermission, hasRole, resolveNotebookPermission } from "../middleware/acl";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import { syncNoteLinks } from "../lib/noteLinks";
import { ensureAttachmentsDir, getAttachmentsDir, getUploadMonthPath } from "./attachment-storage";
import { logAudit } from "./audit";

type TransferStatus = 400 | 403 | 404 | 409 | 500;

export class WorkspaceNotebookTransferError extends Error {
  status: TransferStatus;
  code: string;

  constructor(status: TransferStatus, code: string, message: string) {
    super(message);
    this.name = "WorkspaceNotebookTransferError";
    this.status = status;
    this.code = code;
  }
}

interface NotebookRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  isExpanded: number;
  isDeleted: number;
}

interface NoteRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  notebookId: string;
  title: string;
  content: string | null;
  contentText: string | null;
  contentFormat: string | null;
  isPinned: number;
  sortOrder: number;
}

interface AttachmentRow {
  id: string;
  noteId: string;
  userId: string;
  workspaceId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  hash: string | null;
  uploadSource?: string | null;
  folderId?: string | null;
}

interface TagRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  name: string;
  color: string | null;
}

export interface CopyPersonalNotebookInput {
  actorUserId: string;
  sourceNotebookId: string;
  targetWorkspaceId: string;
  targetParentId?: string | null;
  mode?: string;
  includeTags?: boolean;
  includeAttachments?: boolean;
  includeVersions?: boolean;
}

export interface CopyPersonalNotebookResult {
  success: true;
  mode: "copy";
  targetNotebookId: string;
  notebookCount: number;
  noteCount: number;
  attachmentCount: number;
  tagCount: number;
  warnings: string[];
}

const UUID_RE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ATTACHMENT_URL_RE = new RegExp(`\\/api\\/attachments\\/(${UUID_RE})(\\?[^"'\\s)<>\\]]*)?`, "gi");
const NOTE_SCHEME_RE = new RegExp(`note:\\/\\/(${UUID_RE})`, "gi");
const NOTE_URI_RE = new RegExp(`note:(${UUID_RE})`, "gi");
const NOTE_PATH_RE = new RegExp(`\\/notes\\/(${UUID_RE})(\\?[^"'\\s)<>\\]]*)?`, "gi");
const NOTE_API_RE = new RegExp(`\\/api\\/notes\\/(${UUID_RE})(\\?[^"'\\s)<>\\]]*)?`, "gi");

export function rewriteAttachmentUrls(content: string, idMap: Map<string, string>): string {
  if (!content) return content;
  return content.replace(ATTACHMENT_URL_RE, (match, id: string, query: string = "") => {
    const next = idMap.get(id.toLowerCase());
    return next ? `/api/attachments/${next}${query}` : match;
  });
}

export function rewriteInternalNoteLinks(
  content: string,
  noteIdMap: Map<string, string>,
): { content: string; externalNoteLinkCount: number } {
  if (!content) return { content, externalNoteLinkCount: 0 };
  const external = new Set<string>();

  const rewrite = (prefix: string, id: string, suffix = "") => {
    const next = noteIdMap.get(id.toLowerCase());
    if (!next) {
      external.add(id.toLowerCase());
      return `${prefix}${id}${suffix}`;
    }
    return `${prefix}${next}${suffix}`;
  };

  let nextContent = content.replace(NOTE_SCHEME_RE, (_match, id: string) => rewrite("note://", id));
  nextContent = nextContent.replace(NOTE_URI_RE, (_match, id: string) => rewrite("note:", id));
  nextContent = nextContent.replace(NOTE_PATH_RE, (_match, id: string, query: string = "") => rewrite("/notes/", id, query));
  nextContent = nextContent.replace(NOTE_API_RE, (_match, id: string, query: string = "") => rewrite("/api/notes/", id, query));

  return { content: nextContent, externalNoteLinkCount: external.size };
}

function fail(status: TransferStatus, code: string, message: string): never {
  throw new WorkspaceNotebookTransferError(status, code, message);
}

function cleanupCreatedFiles(files: string[]) {
  for (const file of files.reverse()) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore cleanup failure */
    }
  }
}

function collectNotebookTree(db: Database.Database, source: NotebookRow): NotebookRow[] {
  const all = db
    .prepare("SELECT * FROM notebooks WHERE userId = ? AND workspaceId IS NULL AND isDeleted = 0")
    .all(source.userId) as NotebookRow[];
  const byParent = new Map<string | null, NotebookRow[]>();
  for (const nb of all) {
    const list = byParent.get(nb.parentId ?? null) || [];
    list.push(nb);
    byParent.set(nb.parentId ?? null, list);
  }

  const out: NotebookRow[] = [];
  const visit = (nb: NotebookRow) => {
    out.push(nb);
    const children = (byParent.get(nb.id) || []).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    for (const child of children) visit(child);
  };
  visit(source);
  return out;
}

function copyAttachmentFile(sourceRelPath: string, newAttachmentId: string, filename: string, createdFiles: string[]): string {
  const attachmentsDir = ensureAttachmentsDir();
  const sourceAbs = path.join(attachmentsDir, sourceRelPath);
  if (!fs.existsSync(sourceAbs)) {
    fail(409, "ATTACHMENT_FILE_MISSING", `attachment file missing: ${sourceRelPath}`);
  }

  const ext = path.extname(sourceRelPath) || path.extname(filename) || ".bin";
  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
  const relDir = getUploadMonthPath();
  const targetRelPath = `${relDir}/${newAttachmentId}${safeExt}`;
  const targetAbs = path.join(attachmentsDir, targetRelPath);
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.copyFileSync(sourceAbs, targetAbs);
  createdFiles.push(targetAbs);
  return targetRelPath;
}

export function copyPersonalNotebookToWorkspace(input: CopyPersonalNotebookInput): CopyPersonalNotebookResult {
  const mode = input.mode || "copy";
  if (mode === "move") {
    fail(400, "MOVE_NOT_SUPPORTED", "mode move is not supported yet");
  }
  if (mode !== "copy") {
    fail(400, "INVALID_MODE", "mode must be copy");
  }
  if (input.includeVersions === true) {
    fail(400, "VERSIONS_NOT_SUPPORTED", "includeVersions is not supported in V1");
  }
  if (!input.targetWorkspaceId) {
    fail(400, "TARGET_WORKSPACE_REQUIRED", "targetWorkspaceId is required");
  }

  const actorUserId = input.actorUserId;
  const targetWorkspaceId = input.targetWorkspaceId;
  const includeTags = input.includeTags !== false;
  const includeAttachments = input.includeAttachments !== false;
  const targetParentId = input.targetParentId ?? null;
  const db = getDb();
  const createdFiles: string[] = [];

  try {
    const result = db.transaction(() => {
      const warnings: string[] = [];
      const source = db
        .prepare("SELECT * FROM notebooks WHERE id = ?")
        .get(input.sourceNotebookId) as NotebookRow | undefined;
      if (!source || source.isDeleted === 1) {
        fail(404, "SOURCE_NOTEBOOK_NOT_FOUND", "source notebook not found");
      }
      if (source.workspaceId !== null) {
        fail(400, "SOURCE_MUST_BE_PERSONAL", "source notebook must be in personal workspace");
      }
      if (source.userId !== actorUserId) {
        fail(403, "SOURCE_FORBIDDEN", "source notebook is not owned by actor");
      }

      const targetRole = getUserWorkspaceRole(targetWorkspaceId, actorUserId);
      if (!hasRole(targetRole, "editor")) {
        fail(403, "TARGET_WORKSPACE_FORBIDDEN", "target workspace requires editor permission");
      }

      if (targetParentId) {
        const parent = db
          .prepare("SELECT id, workspaceId, isDeleted FROM notebooks WHERE id = ?")
          .get(targetParentId) as { id: string; workspaceId: string | null; isDeleted: number } | undefined;
        if (!parent || parent.isDeleted === 1) {
          fail(404, "TARGET_PARENT_NOT_FOUND", "target parent notebook not found");
        }
        if ((parent.workspaceId || null) !== targetWorkspaceId) {
          fail(400, "TARGET_PARENT_WORKSPACE_MISMATCH", "target parent must belong to target workspace");
        }
        const parentPerm = resolveNotebookPermission(targetParentId, actorUserId);
        if (!hasPermission(parentPerm.permission, "write")) {
          fail(403, "TARGET_PARENT_FORBIDDEN", "target parent requires write permission");
        }
      }

      const notebookTree = collectNotebookTree(db, source);
      const notebookIdMap = new Map<string, string>();
      const noteIdMap = new Map<string, string>();
      const attachmentIdMap = new Map<string, string>();
      const tagIdMap = new Map<string, string>();

      for (const nb of notebookTree) {
        notebookIdMap.set(nb.id, uuid());
      }

      const insertNotebook = db.prepare(`
        INSERT INTO notebooks (id, userId, workspaceId, parentId, name, description, icon, color, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, datetime('now'), datetime('now'))
      `);
      for (const nb of notebookTree) {
        const newId = notebookIdMap.get(nb.id)!;
        const newParentId = nb.id === source.id ? targetParentId : notebookIdMap.get(nb.parentId || "") || null;
        insertNotebook.run(
          newId,
          actorUserId,
          targetWorkspaceId,
          newParentId,
          nb.name,
          nb.description,
          nb.icon,
          nb.color,
          nb.sortOrder || 0,
          nb.isExpanded ?? 1,
        );
      }

      const oldNotebookIds = notebookTree.map((nb) => nb.id);
      const notebookPlaceholders = oldNotebookIds.map(() => "?").join(",");
      const sourceNotes = oldNotebookIds.length
        ? db
            .prepare(
              `SELECT id, userId, workspaceId, notebookId, title, content, contentText, contentFormat, isPinned, sortOrder
                 FROM notes
                WHERE notebookId IN (${notebookPlaceholders})
                  AND userId = ?
                  AND workspaceId IS NULL
                  AND isTrashed = 0`,
            )
            .all(...oldNotebookIds, actorUserId) as NoteRow[]
        : [];

      for (const note of sourceNotes) {
        noteIdMap.set(note.id.toLowerCase(), uuid());
      }

      const attachmentsByOldNote = new Map<string, AttachmentRow[]>();
      if (sourceNotes.length > 0 && includeAttachments) {
        const oldNoteIds = sourceNotes.map((n) => n.id);
        const notePlaceholders = oldNoteIds.map(() => "?").join(",");
        const rows = db
          .prepare(`SELECT * FROM attachments WHERE noteId IN (${notePlaceholders})`)
          .all(...oldNoteIds) as AttachmentRow[];
        for (const row of rows) {
          const list = attachmentsByOldNote.get(row.noteId) || [];
          list.push(row);
          attachmentsByOldNote.set(row.noteId, list);
        }
      }

      const pendingNotes: Array<{ oldNote: NoteRow; newId: string; content: string; contentText: string }> = [];
      const pendingAttachments: Array<{
        id: string;
        noteId: string;
        filename: string;
        mimeType: string;
        size: number;
        path: string;
        hash: string | null;
      }> = [];
      const insertAttachment = db.prepare(`
        INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const note of sourceNotes) {
        const newNoteId = noteIdMap.get(note.id.toLowerCase())!;
        const sourceAttachments = attachmentsByOldNote.get(note.id) || [];

        for (const att of sourceAttachments) {
          const newAttachmentId = uuid();
          const newPath = copyAttachmentFile(att.path, newAttachmentId, att.filename, createdFiles);
          attachmentIdMap.set(att.id.toLowerCase(), newAttachmentId);
          pendingAttachments.push({
            id: newAttachmentId,
            noteId: newNoteId,
            filename: att.filename,
            mimeType: att.mimeType,
            size: att.size,
            path: newPath,
            hash: att.hash || null,
          });
        }

        let content = note.content || "";
        let contentText = note.contentText || "";
        if (includeAttachments) {
          content = rewriteAttachmentUrls(content, attachmentIdMap);
          contentText = rewriteAttachmentUrls(contentText, attachmentIdMap);
        } else if (content.indexOf("/api/attachments/") >= 0 || contentText.indexOf("/api/attachments/") >= 0) {
          warnings.push(`attachments_not_copied_for_note:${note.id}`);
        }

        const rewritten = rewriteInternalNoteLinks(content, noteIdMap);
        content = rewritten.content;
        if (rewritten.externalNoteLinkCount > 0) {
          warnings.push(`external_note_links_preserved:${note.id}:${rewritten.externalNoteLinkCount}`);
        }
        contentText = rewriteInternalNoteLinks(contentText, noteIdMap).content;

        pendingNotes.push({ oldNote: note, newId: newNoteId, content, contentText });
      }

      const insertNote = db.prepare(`
        INSERT INTO notes (id, userId, workspaceId, notebookId, title, content, contentText, contentFormat, isPinned, isFavorite, isLocked, isArchived, isTrashed, version, sortOrder, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1, ?, datetime('now'), datetime('now'))
      `);
      for (const item of pendingNotes) {
        insertNote.run(
          item.newId,
          actorUserId,
          targetWorkspaceId,
          notebookIdMap.get(item.oldNote.notebookId)!,
          item.oldNote.title,
          item.content,
          item.contentText,
          item.oldNote.contentFormat || "tiptap-json",
          item.oldNote.isPinned || 0,
          item.oldNote.sortOrder || 0,
        );
      }

      for (const att of pendingAttachments) {
        insertAttachment.run(
          att.id,
          att.noteId,
          actorUserId,
          att.filename,
          att.mimeType,
          att.size,
          att.path,
          targetWorkspaceId,
          att.hash,
        );
      }

      let tagCount = 0;
      if (includeTags && sourceNotes.length > 0) {
        const oldNoteIds = sourceNotes.map((n) => n.id);
        const notePlaceholders = oldNoteIds.map(() => "?").join(",");
        const noteTags = db
          .prepare(`SELECT noteId, tagId FROM note_tags WHERE noteId IN (${notePlaceholders})`)
          .all(...oldNoteIds) as Array<{ noteId: string; tagId: string }>;
        const oldTagIds = Array.from(new Set(noteTags.map((nt) => nt.tagId)));
        const selectTargetTag = db.prepare(
          "SELECT * FROM tags WHERE userId = ? AND name = ? AND workspaceId = ? LIMIT 1",
        );
        const selectPersonalTargetTag = db.prepare(
          "SELECT * FROM tags WHERE userId = ? AND name = ? AND workspaceId IS NULL LIMIT 1",
        );
        const selectAnyTagByName = db.prepare("SELECT * FROM tags WHERE userId = ? AND name = ? LIMIT 1");
        const insertTag = db.prepare(
          "INSERT INTO tags (id, userId, workspaceId, name, color) VALUES (?, ?, ?, ?, ?)",
        );

        if (oldTagIds.length > 0) {
          const tagPlaceholders = oldTagIds.map(() => "?").join(",");
          const tags = db
            .prepare(`SELECT * FROM tags WHERE id IN (${tagPlaceholders})`)
            .all(...oldTagIds) as TagRow[];
          for (const tag of tags) {
            let targetTag = targetWorkspaceId
              ? (selectTargetTag.get(actorUserId, tag.name, targetWorkspaceId) as TagRow | undefined)
              : (selectPersonalTargetTag.get(actorUserId, tag.name) as TagRow | undefined);
            if (!targetTag && targetWorkspaceId) {
              targetTag = selectPersonalTargetTag.get(actorUserId, tag.name) as TagRow | undefined;
              if (targetTag) warnings.push(`tag_reused_due_unique_constraint:${tag.name}`);
            }
            if (!targetTag) {
              const newTagId = uuid();
              try {
                insertTag.run(newTagId, actorUserId, targetWorkspaceId, tag.name, tag.color || "#58a6ff");
                targetTag = { ...tag, id: newTagId, userId: actorUserId, workspaceId: targetWorkspaceId };
                tagCount++;
              } catch (error) {
                targetTag = selectAnyTagByName.get(actorUserId, tag.name) as TagRow | undefined;
                if (!targetTag) throw error;
                warnings.push(`tag_reused_due_unique_constraint:${tag.name}`);
              }
            }
            tagIdMap.set(tag.id, targetTag.id);
          }
        }

        const insertNoteTag = db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)");
        for (const nt of noteTags) {
          const newNoteId = noteIdMap.get(nt.noteId.toLowerCase());
          const targetTagId = tagIdMap.get(nt.tagId);
          if (newNoteId && targetTagId) insertNoteTag.run(newNoteId, targetTagId);
        }
      }

      for (const item of pendingNotes) {
        if (item.content.indexOf("/api/attachments/") >= 0) {
          syncAttachmentReferences(db, item.newId, item.content);
        }
        syncNoteLinks(db, actorUserId, item.newId, item.content);
      }

      const targetNotebookId = notebookIdMap.get(source.id)!;
      const out: CopyPersonalNotebookResult = {
        success: true,
        mode: "copy",
        targetNotebookId,
        notebookCount: notebookTree.length,
        noteCount: pendingNotes.length,
        attachmentCount: attachmentIdMap.size,
        tagCount,
        warnings,
      };

      logAudit(
        actorUserId,
        "notebook",
        "notebook.transfer_copy",
        {
          sourceNotebookId: source.id,
          targetWorkspaceId,
          targetParentId,
          targetNotebookId,
          notebookCount: out.notebookCount,
          noteCount: out.noteCount,
          attachmentCount: out.attachmentCount,
          tagCount: out.tagCount,
          includeTags,
          includeAttachments,
          includeVersions: false,
          warnings,
        },
        { targetType: "notebook", targetId: targetNotebookId },
      );

      return out;
    })();

    return result;
  } catch (err) {
    cleanupCreatedFiles(createdFiles);
    throw err;
  }
}
