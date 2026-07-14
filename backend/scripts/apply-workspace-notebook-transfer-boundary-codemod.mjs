import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.resolve(here, "../src/services/workspaceNotebookTransfer.ts");
let source = fs.readFileSync(filePath, "utf8");

const oldImports = `import type Database from "better-sqlite3";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole, hasPermission, hasRole, resolveNotebookPermission } from "../middleware/acl";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import { syncNoteLinks } from "../lib/noteLinks";`;
const newImports = `import { getUserWorkspaceRole, hasPermission, hasRole, resolveNotebookPermission } from "../middleware/acl";
import { workspaceNotebookTransferRepository } from "../repositories/workspaceNotebookTransferRepository";`;
if (!source.includes(oldImports)) {
  throw new Error("workspaceNotebookTransfer.ts imports no longer match expected source");
}
source = source.replace(oldImports, newImports);
source = source.replace(
  'import { ensureAttachmentsDir, getAttachmentsDir, getUploadMonthPath } from "./attachment-storage";',
  'import { ensureAttachmentsDir, getUploadMonthPath } from "./attachment-storage";',
);

const treePattern = /function collectNotebookTree\([\s\S]*?\n}\n\n(?=function copyAttachmentFile)/;
const treeMatches = source.match(treePattern);
if (!treeMatches || treeMatches.length !== 1) {
  throw new Error(`collectNotebookTree: expected one block, got ${treeMatches?.length || 0}`);
}
source = source.replace(
  treePattern,
  `function collectNotebookTree(source: NotebookRow): NotebookRow[] {
  const all = workspaceNotebookTransferRepository.listPersonalNotebooks<NotebookRow>(source.userId);
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

`,
);

const functionStart = source.indexOf("export function copyPersonalNotebookToWorkspace(");
if (functionStart < 0) {
  throw new Error("copyPersonalNotebookToWorkspace function not found");
}

const replacement = `export function copyPersonalNotebookToWorkspace(input: CopyPersonalNotebookInput): CopyPersonalNotebookResult {
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
  const createdFiles: string[] = [];

  try {
    return workspaceNotebookTransferRepository.transaction(() => {
      const warnings: string[] = [];
      const sourceNotebook = workspaceNotebookTransferRepository.findNotebook<NotebookRow>(
        input.sourceNotebookId,
      );
      if (!sourceNotebook || sourceNotebook.isDeleted === 1) {
        fail(404, "SOURCE_NOTEBOOK_NOT_FOUND", "source notebook not found");
      }
      if (sourceNotebook.workspaceId !== null) {
        fail(400, "SOURCE_MUST_BE_PERSONAL", "source notebook must be in personal workspace");
      }
      if (sourceNotebook.userId !== actorUserId) {
        fail(403, "SOURCE_FORBIDDEN", "source notebook is not owned by actor");
      }

      const targetRole = getUserWorkspaceRole(targetWorkspaceId, actorUserId);
      if (!hasRole(targetRole, "editor")) {
        fail(403, "TARGET_WORKSPACE_FORBIDDEN", "target workspace requires editor permission");
      }

      if (targetParentId) {
        const parent = workspaceNotebookTransferRepository.findTargetParent<{
          id: string;
          workspaceId: string | null;
          isDeleted: number;
        }>(targetParentId);
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

      const oldNotebookIds = notebookTree.map((notebook) => notebook.id);
      const sourceNotes = workspaceNotebookTransferRepository.listSourceNotes<NoteRow>(
        oldNotebookIds,
        actorUserId,
      );
      for (const note of sourceNotes) {
        noteIdMap.set(note.id.toLowerCase(), uuid());
      }

      const attachmentsByOldNote = new Map<string, AttachmentRow[]>();
      if (sourceNotes.length > 0 && includeAttachments) {
        const oldNoteIds = sourceNotes.map((note) => note.id);
        const rows = workspaceNotebookTransferRepository.listAttachmentsByNoteIds<AttachmentRow>(
          oldNoteIds,
        );
        for (const row of rows) {
          const list = attachmentsByOldNote.get(row.noteId) || [];
          list.push(row);
          attachmentsByOldNote.set(row.noteId, list);
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
          warnings.push(\`attachments_not_copied_for_note:\${note.id}\`);
        }

        const rewritten = rewriteInternalNoteLinks(content, noteIdMap);
        content = rewritten.content;
        if (rewritten.externalNoteLinkCount > 0) {
          warnings.push(
            \`external_note_links_preserved:\${note.id}:\${rewritten.externalNoteLinkCount}\`,
          );
        }
        contentText = rewriteInternalNoteLinks(contentText, noteIdMap).content;
        pendingNotes.push({ oldNote: note, newId: newNoteId, content, contentText });
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
        const oldNoteIds = sourceNotes.map((note) => note.id);
        const noteTags = workspaceNotebookTransferRepository.listNoteTags(oldNoteIds);
        const oldTagIds = Array.from(new Set(noteTags.map((noteTag) => noteTag.tagId)));

        if (oldTagIds.length > 0) {
          const tags = workspaceNotebookTransferRepository.listTagsByIds<TagRow>(oldTagIds);
          for (const tag of tags) {
            let targetTag = workspaceNotebookTransferRepository.findWorkspaceTagByName<TagRow>(
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
                targetTag = workspaceNotebookTransferRepository.findAnyTagByName<TagRow>(
                  actorUserId,
                  tag.name,
                );
                if (!targetTag) throw error;
                warnings.push(\`tag_reused_due_unique_constraint:\${tag.name}\`);
              }
            }
            tagIdMap.set(tag.id, targetTag.id);
          }
        }

        for (const noteTag of noteTags) {
          const newNoteId = noteIdMap.get(noteTag.noteId.toLowerCase());
          const targetTagId = tagIdMap.get(noteTag.tagId);
          if (newNoteId && targetTagId) {
            workspaceNotebookTransferRepository.insertNoteTag(newNoteId, targetTagId);
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
`;

source = source.slice(0, functionStart) + replacement;

if (/better-sqlite3|\.\.\/db\/schema|\bgetDb\s*\(|\.prepare\s*\(|\.transaction\s*\(/.test(source)) {
  throw new Error("database driver access remains in workspaceNotebookTransfer.ts");
}
if (!source.includes("workspaceNotebookTransferRepository.transaction")) {
  throw new Error("repository transaction delegation missing");
}
if (!source.includes("cleanupCreatedFiles(createdFiles)")) {
  throw new Error("filesystem rollback cleanup missing");
}

fs.writeFileSync(filePath, source);
console.log("Applied deterministic workspace notebook transfer database boundary codemod.");
