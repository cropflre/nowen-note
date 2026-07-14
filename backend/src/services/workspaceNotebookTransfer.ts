import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import {
  getUserWorkspaceRole,
  hasPermission,
  hasRole,
  resolveNotebookPermission,
} from "../middleware/acl";
import { workspaceNotebookTransferRepository } from "../repositories/workspaceNotebookTransferRepository";
import { ensureAttachmentsDir, getUploadMonthPath } from "./attachment-storage";
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

const UUID_RE =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ATTACHMENT_URL_RE = new RegExp(
  `\\/api\\/attachments\\/(${UUID_RE})(\\?[^"'\\s)<>\\]]*)?`,
  "gi",
);
const NOTE_SCHEME_RE = new RegExp(`note:\\/\\/(${UUID_RE})`, "gi");
const NOTE_URI_RE = new RegExp(`note:(${UUID_RE})`, "gi");
const NOTE_PATH_RE = new RegExp(
  `\\/notes\\/(${UUID_RE})(\\?[^"'\\s)<>\\]]*)?`,
  "gi",
);
const NOTE_API_RE = new RegExp(
  `\\/api\\/notes\\/(${UUID_RE})(\\?[^"'\\s)<>\\]]*)?`,
  "gi",
);

export function rewriteAttachmentUrls(
  content: string,
  idMap: Map<string, string>,
): string {
  if (!content) return content;
  return content.replace(
    ATTACHMENT_URL_RE,
    (match, id: string, query: string = "") => {
      const next = idMap.get(id.toLowerCase());
      return next ? `/api/attachments/${next}${query}` : match;
    },
  );
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

  let nextContent = content.replace(NOTE_SCHEME_RE, (_match, id: string) =>
    rewrite("note://", id),
  );
  nextContent = nextContent.replace(NOTE_URI_RE, (_match, id: string) =>
    rewrite("note:", id),
  );
  nextContent = nextContent.replace(
    NOTE_PATH_RE,
    (_match, id: string, query: string = "") => rewrite("/notes/", id, query),
  );
  nextContent = nextContent.replace(
    NOTE_API_RE,
    (_match, id: string, query: string = "") => rewrite("/api/notes/", id, query),
  );

  return { content: nextContent, externalNoteLinkCount: external.size };
}

function fail(status: TransferStatus, code: string, message: string): never {
  throw new WorkspaceNotebookTransferError(status, code, message);
}

function cleanupCreatedFiles(files: string[]): void {
  for (const file of files.reverse()) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // 文件清理失败不能覆盖原始搬迁错误。
    }
  }
}

function collectNotebookTree(source: NotebookRow): NotebookRow[] {
  const all =
    workspaceNotebookTransferRepository.listPersonalNotebooks<NotebookRow>(
      source.userId,
    );
  const byParent = new Map<string | null, NotebookRow[]>();
  for (const notebook of all) {
    const list = byParent.get(notebook.parentId ?? null) || [];
    list.push(notebook);
    byParent.set(notebook.parentId ?? null, list);
  }

  const output: NotebookRow[] = [];
  const visit = (notebook: NotebookRow) => {
    output.push(notebook);
    const children = (byParent.get(notebook.id) || []).sort(
      (left, right) => (left.sortOrder || 0) - (right.sortOrder || 0),
    );
    for (const child of children) visit(child);
  };
  visit(source);
  return output;
}

function copyAttachmentFile(
  sourceRelPath: string,
  newAttachmentId: string,
  filename: string,
  createdFiles: string[],
): string {
  const attachmentsDir = ensureAttachmentsDir();
  const sourceAbs = path.join(attachmentsDir, sourceRelPath);
  if (!fs.existsSync(sourceAbs)) {
    fail(
      409,
      "ATTACHMENT_FILE_MISSING",
      `attachment file missing: ${sourceRelPath}`,
    );
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

export function copyPersonalNotebookToWorkspace(
  input: CopyPersonalNotebookInput,
): CopyPersonalNotebookResult {
  const mode = input.mode || "copy";
  if (mode === "move") {
    fail(400, "MOVE_NOT_SUPPORTED", "mode move is not supported yet");
  }
  if (mode !== "copy") {
    fail(400, "INVALID_MODE", "mode must be copy");
  }
  if (input.includeVersions === true) {
    fail(
      400,
      "VERSIONS_NOT_SUPPORTED",
      "includeVersions is not supported in V1",
    );
  }
  if (!input.targetWorkspaceId) {
    fail(
      400,
      "TARGET_WORKSPACE_REQUIRED",
      "targetWorkspaceId is required",
    );
  }

  const actorUserId = input.actorUserId;
  const targetWorkspaceId = input.targetWorkspaceId;
  const includeTags = input.includeTags !== false;
  const includeAttachments = input.includeAttachments !== false;
  const targetParentId = input.targetParentId ?? null;
  const createdFiles: string[] = [];

  try {
    return workspaceNotebookTransferRepository.transaction(() => {
      const warnings: string[] = [];
      const sourceNotebook =
        workspaceNotebookTransferRepository.findNotebook<NotebookRow>(
          input.sourceNotebookId,
        );
      if (!sourceNotebook || sourceNotebook.isDeleted === 1) {
        fail(404, "SOURCE_NOTEBOOK_NOT_FOUND", "source notebook not found");
      }
      if (sourceNotebook.workspaceId !== null) {
        fail(
          400,
          "SOURCE_MUST_BE_PERSONAL",
          "source notebook must be in personal workspace",
        );
      }
      if (sourceNotebook.userId !== actorUserId) {
        fail(
          403,
          "SOURCE_FORBIDDEN",
          "source notebook is not owned by actor",
        );
      }

      const targetRole = getUserWorkspaceRole(targetWorkspaceId, actorUserId);
      if (!hasRole(targetRole, "editor")) {
        fail(
          403,
          "TARGET_WORKSPACE_FORBIDDEN",
          "target workspace requires editor permission",
        );
      }

      if (targetParentId) {
        const parent = workspaceNotebookTransferRepository.findTargetParent<{
          id: string;
          workspaceId: string | null;
          isDeleted: number;
        }>(targetParentId);
        if (!parent || parent.isDeleted === 1) {
          fail(
            404,
            "TARGET_PARENT_NOT_FOUND",
            "target parent notebook not found",
          );
        }
        if ((parent.workspaceId || null) !== targetWorkspaceId) {
          fail(
            400,
            "TARGET_PARENT_WORKSPACE_MISMATCH",
            "target parent must belong to target workspace",
          );
        }
        const parentPermission = resolveNotebookPermission(
          targetParentId,
          actorUserId,
        );
        if (!hasPermission(parentPermission.permission, "write")) {
          fail(
            403,
            "TARGET_PARENT_FORBIDDEN",
            "target parent requires write permission",
          );
        }
      }

      const notebookTree = collectNotebookTree(sourceNotebook);
      const notebookIdMap = new Map<string, string>();
      const noteIdMap = new Map<string, string>();
      const attachmentIdMap = new Map<string, string>();
      const tagIdMap = new Map<string, string>();

      for (const notebook of notebookTree) {
        notebookIdMap.set(notebook.id, uuid());
      }

      for (const notebook of notebookTree) {
        const newId = notebookIdMap.get(notebook.id)!;
        const newParentId =
          notebook.id === sourceNotebook.id
            ? targetParentId
            : notebookIdMap.get(notebook.parentId || "") || null;
        workspaceNotebookTransferRepository.insertNotebook({
          id: newId,
          userId: actorUserId,
          workspaceId: targetWorkspaceId,
          parentId: newParentId,
          name: notebook.name,
          description: notebook.description,
          icon: notebook.icon,
          color: notebook.color,
          sortOrder: notebook.sortOrder || 0,
          isExpanded: notebook.isExpanded ?? 1,
        });
      }

      const sourceNotes =
        workspaceNotebookTransferRepository.listSourceNotes<NoteRow>(
          notebookTree.map((notebook) => notebook.id),
          actorUserId,
        );
      for (const note of sourceNotes) {
        noteIdMap.set(note.id.toLowerCase(), uuid());
      }

      const attachmentsByOldNote = new Map<string, AttachmentRow[]>();
      if (sourceNotes.length > 0 && includeAttachments) {
        const attachments =
          workspaceNotebookTransferRepository.listAttachmentsByNoteIds<AttachmentRow>(
            sourceNotes.map((note) => note.id),
          );
        for (const attachment of attachments) {
          const list = attachmentsByOldNote.get(attachment.noteId) || [];
          list.push(attachment);
          attachmentsByOldNote.set(attachment.noteId, list);
        }
      }

      const pendingNotes: Array<{
        oldNote: NoteRow;
        newId: string;
        content: string;
        contentText: string;
      }> = [];
      const pendingAttachments: Array<{
        id: string;
        noteId: string;
        filename: string;
        mimeType: string;
        size: number;
        path: string;
        hash: string | null;
      }> = [];

      for (const note of sourceNotes) {
        const newNoteId = noteIdMap.get(note.id.toLowerCase())!;
        const sourceAttachments = attachmentsByOldNote.get(note.id) || [];

        for (const attachment of sourceAttachments) {
          const newAttachmentId = uuid();
          const newPath = copyAttachmentFile(
            attachment.path,
            newAttachmentId,
            attachment.filename,
            createdFiles,
          );
          attachmentIdMap.set(attachment.id.toLowerCase(), newAttachmentId);
          pendingAttachments.push({
            id: newAttachmentId,
            noteId: newNoteId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
            path: newPath,
            hash: attachment.hash || null,
          });
        }

        let content = note.content || "";
        let contentText = note.contentText || "";
        if (includeAttachments) {
          content = rewriteAttachmentUrls(content, attachmentIdMap);
          contentText = rewriteAttachmentUrls(contentText, attachmentIdMap);
        } else if (
          content.indexOf("/api/attachments/") >= 0 ||
          contentText.indexOf("/api/attachments/") >= 0
        ) {
          warnings.push(`attachments_not_copied_for_note:${note.id}`);
        }

        const rewritten = rewriteInternalNoteLinks(content, noteIdMap);
        content = rewritten.content;
        if (rewritten.externalNoteLinkCount > 0) {
          warnings.push(
            `external_note_links_preserved:${note.id}:${rewritten.externalNoteLinkCount}`,
          );
        }
        contentText = rewriteInternalNoteLinks(contentText, noteIdMap).content;
        pendingNotes.push({
          oldNote: note,
          newId: newNoteId,
          content,
          contentText,
        });
      }

      for (const item of pendingNotes) {
        workspaceNotebookTransferRepository.insertNote({
          id: item.newId,
          userId: actorUserId,
          workspaceId: targetWorkspaceId,
          notebookId: notebookIdMap.get(item.oldNote.notebookId)!,
          title: item.oldNote.title,
          content: item.content,
          contentText: item.contentText,
          contentFormat: item.oldNote.contentFormat || "tiptap-json",
          isPinned: item.oldNote.isPinned || 0,
          sortOrder: item.oldNote.sortOrder || 0,
        });
      }

      for (const attachment of pendingAttachments) {
        workspaceNotebookTransferRepository.insertAttachment({
          ...attachment,
          userId: actorUserId,
          workspaceId: targetWorkspaceId,
        });
      }

      let tagCount = 0;
      if (includeTags && sourceNotes.length > 0) {
        const noteTags = workspaceNotebookTransferRepository.listNoteTags(
          sourceNotes.map((note) => note.id),
        );
        const oldTagIds = Array.from(
          new Set(noteTags.map((noteTag) => noteTag.tagId)),
        );

        if (oldTagIds.length > 0) {
          const tags =
            workspaceNotebookTransferRepository.listTagsByIds<TagRow>(
              oldTagIds,
            );
          for (const tag of tags) {
            let targetTag =
              workspaceNotebookTransferRepository.findWorkspaceTagByName<TagRow>(
                actorUserId,
                tag.name,
                targetWorkspaceId,
              );
            if (!targetTag) {
              const newTagId = uuid();
              try {
                workspaceNotebookTransferRepository.insertTag({
                  id: newTagId,
                  userId: actorUserId,
                  workspaceId: targetWorkspaceId,
                  name: tag.name,
                  color: tag.color || "#58a6ff",
                });
                targetTag = {
                  ...tag,
                  id: newTagId,
                  userId: actorUserId,
                  workspaceId: targetWorkspaceId,
                };
                tagCount++;
              } catch (error) {
                targetTag =
                  workspaceNotebookTransferRepository.findAnyTagByName<TagRow>(
                    actorUserId,
                    tag.name,
                  );
                if (!targetTag) throw error;
                warnings.push(
                  `tag_reused_due_unique_constraint:${tag.name}`,
                );
              }
            }
            tagIdMap.set(tag.id, targetTag.id);
          }
        }

        for (const noteTag of noteTags) {
          const newNoteId = noteIdMap.get(noteTag.noteId.toLowerCase());
          const targetTagId = tagIdMap.get(noteTag.tagId);
          if (newNoteId && targetTagId) {
            workspaceNotebookTransferRepository.insertNoteTag(
              newNoteId,
              targetTagId,
            );
          }
        }
      }

      for (const item of pendingNotes) {
        workspaceNotebookTransferRepository.syncDerivedReferences(
          actorUserId,
          item.newId,
          item.content,
        );
      }

      const targetNotebookId = notebookIdMap.get(sourceNotebook.id)!;
      const result: CopyPersonalNotebookResult = {
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
          sourceNotebookId: sourceNotebook.id,
          targetWorkspaceId,
          targetParentId,
          targetNotebookId,
          notebookCount: result.notebookCount,
          noteCount: result.noteCount,
          attachmentCount: result.attachmentCount,
          tagCount: result.tagCount,
          includeTags,
          includeAttachments,
          includeVersions: false,
          warnings,
        },
        { targetType: "notebook", targetId: targetNotebookId },
      );

      return result;
    });
  } catch (error) {
    cleanupCreatedFiles(createdFiles);
    throw error;
  }
}
