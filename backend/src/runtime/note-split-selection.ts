import { v4 as uuid } from "uuid";
import { Hono } from "hono";
import type { Context, Next } from "hono";

import { getDb } from "../db/schema.js";
import { hasPermission, resolveNotePermission, resolveNotebookPermission } from "../middleware/acl.js";
import {
  extractAttachmentIdsFromContent,
  syncReferences as syncAttachmentReferences,
} from "../lib/attachmentRefs.js";
import { syncNoteBlocks } from "../lib/noteBlocks.js";
import { syncNoteLinks } from "../lib/noteLinks.js";
import { extractSearchableText } from "../lib/searchIndex.js";
import {
  buildMarkdownPartialSplitSource,
  planMarkdownNoteSplit,
  validateMarkdownSplitPlan,
  type MarkdownSplitSection,
  type NoteSplitHeadingLevel,
} from "../lib/noteSplit.js";
import { noteTagsRepository } from "../repositories/index.js";
import {
  createDeduplicatedAttachmentRow,
  type ExistingAttachmentForDedup,
} from "../routes/attachments-core.js";
import { logAudit } from "../services/audit.js";
import {
  broadcastNoteUpdated,
  broadcastToUser,
  broadcastYjsUpdate,
} from "../services/realtime.js";
import { yFlush, yReplaceContentAsUpdate } from "../services/yjs.js";
import { ensureNoteSplitTables } from "./note-split.js";

const PARTIAL_NOTE_SPLIT_INSTALLED = Symbol.for("nowen.noteSplit.selectionRoutesInstalled");
const PARTIAL_NOTE_SPLIT_ROUTE_PATCH = Symbol.for("nowen.noteSplit.selectionRoutePatch");
const globals = globalThis as typeof globalThis & Record<symbol, boolean>;

type SplitAttachmentKind = "moved" | "copy";

interface SourceNoteRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  notebookId: string | null;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  version: number;
  isLocked: number;
  isArchived: number;
  isTrashed: number;
}

interface SplitAttachmentRow extends ExistingAttachmentForDedup {
  id: string;
  noteId: string;
  userId: string;
  workspaceId: string | null;
  filename: string;
  hash: string | null;
  uploadSource: string | null;
}

class NoteSplitSelectionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function getSourceNote(id: string): SourceNoteRow | undefined {
  return getDb().prepare(`
    SELECT id, userId, workspaceId, notebookId, title, content, contentText, contentFormat,
           version, isLocked, isArchived, isTrashed
    FROM notes WHERE id = ?
  `).get(id) as SourceNoteRow | undefined;
}

function assertWritableSource(noteId: string, userId: string): SourceNoteRow {
  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "write")) {
    throw new NoteSplitSelectionError("无权拆分该笔记", "FORBIDDEN", 403);
  }
  const source = getSourceNote(noteId);
  if (!source) throw new NoteSplitSelectionError("笔记不存在", "NOT_FOUND", 404);
  if (source.isTrashed) throw new NoteSplitSelectionError("回收站中的笔记不能拆分", "NOTE_TRASHED", 409);
  if (source.isLocked) throw new NoteSplitSelectionError("锁定笔记不能拆分", "NOTE_LOCKED", 409);
  if (source.contentFormat !== "markdown") {
    throw new NoteSplitSelectionError("当前仅支持拆分 Markdown 笔记", "SPLIT_MARKDOWN_ONLY", 409);
  }
  return source;
}

function resolveTargetNotebook(options: {
  targetNotebookId: unknown;
  source: SourceNoteRow;
  userId: string;
}): { notebookId: string | null; workspaceId: string | null } {
  const requested = typeof options.targetNotebookId === "string" && options.targetNotebookId.trim()
    ? options.targetNotebookId.trim()
    : options.source.notebookId;
  if (!requested) return { notebookId: null, workspaceId: options.source.workspaceId };

  const notebook = getDb().prepare(
    "SELECT id, workspaceId, isDeleted FROM notebooks WHERE id = ?",
  ).get(requested) as { id: string; workspaceId: string | null; isDeleted: number } | undefined;
  if (!notebook) throw new NoteSplitSelectionError("目标笔记本不存在", "NOTEBOOK_NOT_FOUND", 404);
  if (notebook.isDeleted) throw new NoteSplitSelectionError("目标笔记本已删除", "NOTEBOOK_TRASHED", 409);
  if ((notebook.workspaceId || null) !== (options.source.workspaceId || null)) {
    throw new NoteSplitSelectionError("不能跨工作区拆分笔记", "CROSS_WORKSPACE_SPLIT_FORBIDDEN", 409);
  }
  const { permission } = resolveNotebookPermission(requested, options.userId);
  if (!hasPermission(permission, "write")) {
    throw new NoteSplitSelectionError("无权在目标笔记本中创建章节", "NOTEBOOK_FORBIDDEN", 403);
  }
  return { notebookId: requested, workspaceId: notebook.workspaceId || null };
}

function normalizeSelectedIndexes(value: unknown, sectionCount: number): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new NoteSplitSelectionError("请至少选择一个章节", "EMPTY_SECTION_SELECTION");
  }
  const indexes: number[] = [];
  const seen = new Set<number>();
  for (const raw of value) {
    if (!Number.isSafeInteger(raw)) {
      throw new NoteSplitSelectionError("章节索引必须是整数", "INVALID_SECTION_SELECTION");
    }
    const index = raw as number;
    if (index < 0 || index >= sectionCount) {
      throw new NoteSplitSelectionError("章节选择已失效，请重新打开预览", "INVALID_SECTION_SELECTION", 409);
    }
    if (seen.has(index)) {
      throw new NoteSplitSelectionError("章节选择包含重复项", "INVALID_SECTION_SELECTION");
    }
    seen.add(index);
    indexes.push(index);
  }
  return indexes.sort((a, b) => a - b);
}

function normalizeCreatedNote(db: ReturnType<typeof getDb>, noteId: string, userId: string): void {
  const row = db.prepare("SELECT content, contentFormat FROM notes WHERE id = ?").get(noteId) as
    | { content: string; contentFormat: string }
    | undefined;
  if (!row) throw new Error(`Created split note disappeared: ${noteId}`);
  const synced = syncNoteBlocks(db, noteId, row.content || "", row.contentFormat || "markdown");
  db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
    .run(synced.content, synced.contentText, noteId);
  syncAttachmentReferences(db, noteId, synced.content);
  syncNoteLinks(db, userId, noteId, synced.content);
}

function replaceAttachmentId(content: string, fromId: string, toId: string): string {
  if (fromId === toId) return content;
  return content.split(`/api/attachments/${fromId}`).join(`/api/attachments/${toId}`);
}

function prepareSectionAttachments(options: {
  db: ReturnType<typeof getDb>;
  operationId: string;
  source: SourceNoteRow;
  childNoteId: string;
  targetWorkspaceId: string | null;
  userId: string;
  content: string;
  claimedSourceAttachments: Set<string>;
  retainedSourceAttachments: Set<string>;
}): string {
  let content = options.content;
  const attachmentIds = [...extractAttachmentIdsFromContent(content)].sort();
  const insertTracking = options.db.prepare(`
    INSERT INTO note_split_attachment_copies (
      operationId, noteId, sourceAttachmentId, attachmentId, kind
    ) VALUES (?, ?, ?, ?, ?)
  `);

  for (const sourceAttachmentId of attachmentIds) {
    const attachment = options.db.prepare(`
      SELECT id, noteId, userId, workspaceId, filename, mimeType, size, path, hash, uploadSource
      FROM attachments WHERE id = ?
    `).get(sourceAttachmentId) as SplitAttachmentRow | undefined;
    if (!attachment) continue;

    const sourceStillNeedsOriginal = options.retainedSourceAttachments.has(sourceAttachmentId);
    if (
      attachment.noteId === options.source.id
      && !sourceStillNeedsOriginal
      && !options.claimedSourceAttachments.has(sourceAttachmentId)
    ) {
      const moved = options.db.prepare(`
        UPDATE attachments
        SET noteId = ?, workspaceId = ?
        WHERE id = ? AND noteId = ?
      `).run(
        options.childNoteId,
        options.targetWorkspaceId,
        sourceAttachmentId,
        options.source.id,
      );
      if (moved.changes === 1) {
        options.claimedSourceAttachments.add(sourceAttachmentId);
        insertTracking.run(
          options.operationId,
          options.childNoteId,
          sourceAttachmentId,
          sourceAttachmentId,
          "moved" satisfies SplitAttachmentKind,
        );
        continue;
      }
    }

    const copy = createDeduplicatedAttachmentRow({
      source: attachment,
      noteId: options.childNoteId,
      userId: options.userId,
      workspaceId: options.targetWorkspaceId,
      filename: attachment.filename,
      hash: attachment.hash,
      uploadSource: "note-split",
    });
    insertTracking.run(
      options.operationId,
      options.childNoteId,
      sourceAttachmentId,
      copy.id,
      "copy" satisfies SplitAttachmentKind,
    );
    content = replaceAttachmentId(content, sourceAttachmentId, copy.id);
  }

  return content;
}

function selectNoteForUser(noteId: string, userId: string): any {
  return getDb().prepare(`
    SELECT id, userId, notebookId, workspaceId, title, content, contentText, isPinned,
      CASE WHEN EXISTS(SELECT 1 FROM favorites f WHERE f.noteId = notes.id AND f.userId = ?) THEN 1 ELSE 0 END AS isFavorite,
      isLocked, isArchived, isTrashed, version, sortOrder, createdAt, updatedAt, trashedAt, contentFormat
    FROM notes WHERE id = ?
  `).get(userId, noteId);
}

function publishSourceUpdate(sourceNote: any, actorUserId: string): void {
  try {
    broadcastNoteUpdated(sourceNote.id, {
      version: sourceNote.version,
      updatedAt: sourceNote.updatedAt,
      title: sourceNote.title,
      contentText: sourceNote.contentText,
      actorUserId,
    });
    broadcastToUser(actorUserId, {
      type: "note:list-updated" as any,
      note: {
        id: sourceNote.id,
        title: sourceNote.title,
        contentText: sourceNote.contentText,
        updatedAt: sourceNote.updatedAt,
        version: sourceNote.version,
        isPinned: sourceNote.isPinned,
        isTrashed: sourceNote.isTrashed,
        notebookId: sourceNote.notebookId,
        workspaceId: sourceNote.workspaceId,
      },
      actorUserId,
      actorConnectionId: null,
    } as any);
  } catch (error) {
    console.warn("[note-split-selection] realtime source update failed:", error);
  }
}

function publishCreatedNotes(createdNotes: any[], actorUserId: string): void {
  for (const note of createdNotes) {
    try {
      broadcastToUser(actorUserId, {
        type: "note:list-updated" as any,
        note: {
          id: note.id,
          title: note.title,
          contentText: note.contentText,
          updatedAt: note.updatedAt,
          version: note.version,
          isPinned: note.isPinned,
          isTrashed: note.isTrashed,
          notebookId: note.notebookId,
          workspaceId: note.workspaceId,
        },
        actorUserId,
        actorConnectionId: null,
      } as any);
    } catch (error) {
      console.warn("[note-split-selection] realtime created note update failed:", error);
    }
  }
}

function syncSourceYDoc(noteId: string, content: string, userId: string): void {
  try {
    const result = yReplaceContentAsUpdate(noteId, content, userId || null);
    if (result) broadcastYjsUpdate(noteId, result.updateBase64);
  } catch (error) {
    console.warn("[note-split-selection] Y.Doc replacement failed:", error);
  }
}

function jsonError(c: Context, error: unknown) {
  if (error instanceof NoteSplitSelectionError) {
    return c.json({ error: error.message, code: error.code, ...error.extra }, error.status);
  }
  console.error("[note-split-selection] unexpected error:", error);
  return c.json({ error: "拆分操作失败，所有修改已回滚", code: "NOTE_SPLIT_FAILED" }, 500);
}

export function installPartialNoteSplitRoutes(router: Hono<any>): void {
  const tagged = router as Hono<any> & Record<symbol, boolean>;
  if (tagged[PARTIAL_NOTE_SPLIT_INSTALLED]) return;
  tagged[PARTIAL_NOTE_SPLIT_INSTALLED] = true;
  ensureNoteSplitTables();

  router.post("/:id/split", async (c: Context, next: Next) => {
    const clonedBody = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(clonedBody, "sectionIndexes")) {
      await next();
      return;
    }

    const noteId = c.req.param("id");
    const userId = c.req.header("X-User-Id") || "";
    try {
      try { yFlush(noteId); } catch { /* active room may not exist */ }
      const source = assertWritableSource(noteId, userId);
      const headingLevel = clonedBody.headingLevel === 2 ? 2 : clonedBody.headingLevel === 1 ? 1 : null;
      if (!headingLevel) {
        throw new NoteSplitSelectionError("headingLevel 必须是 1 或 2", "INVALID_HEADING_LEVEL");
      }
      if (!Number.isSafeInteger(clonedBody.version) || clonedBody.version !== source.version) {
        throw new NoteSplitSelectionError(
          "笔记已被更新，请重新打开拆分预览",
          "VERSION_CONFLICT",
          409,
          { currentVersion: source.version },
        );
      }

      const plan = planMarkdownNoteSplit(source.content || "", headingLevel as NoteSplitHeadingLevel);
      const validationError = validateMarkdownSplitPlan(plan);
      if (validationError) throw new NoteSplitSelectionError(validationError, "INVALID_SPLIT_PLAN", 409);
      const selectedIndexes = normalizeSelectedIndexes(clonedBody.sectionIndexes, plan.sections.length);
      const selectedSections = selectedIndexes.map((index) => plan.sections[index] as MarkdownSplitSection);
      const target = resolveTargetNotebook({
        targetNotebookId: clonedBody.targetNotebookId,
        source,
        userId,
      });
      const preservePreamble = clonedBody.preservePreamble !== false;
      const db = getDb();
      const operationId = uuid();
      const directoryVersion = source.version + 1;
      const createdIds = selectedSections.map(() => uuid());
      const sourceContent = buildMarkdownPartialSplitSource({
        sourceMarkdown: source.content,
        sourceTitle: source.title,
        operationId,
        plan,
        preservePreamble,
        sections: selectedSections.map((section, index) => ({
          index: section.index,
          id: createdIds[index],
          title: section.title,
        })),
      });
      const retainedSourceAttachments = extractAttachmentIdsFromContent(sourceContent);

      const transaction = db.transaction(() => {
        db.prepare(`
          INSERT INTO note_versions (
            id, noteId, userId, title, content, contentText, contentFormat, version,
            changeType, changeSummary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'edit', ?)
        `).run(
          uuid(), source.id, userId, source.title, source.content, source.contentText,
          source.contentFormat, source.version,
          `按 H${headingLevel} 拆分所选 ${selectedSections.length}/${plan.sections.length} 个章节`,
        );

        db.prepare(`
          INSERT INTO note_split_operations (
            id, sourceNoteId, actorUserId, originalVersion, directoryVersion,
            originalTitle, originalContent, originalContentText, originalContentFormat, headingLevel
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          operationId, source.id, userId, source.version, directoryVersion,
          source.title, source.content, source.contentText, source.contentFormat, headingLevel,
        );

        const insertNote = db.prepare(`
          INSERT INTO notes (
            id, userId, workspaceId, notebookId, title, content, contentText, contentFormat, isArchived
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'markdown', ?)
        `);
        const copyTag = db.prepare(`
          INSERT OR IGNORE INTO note_tags (noteId, tagId)
          SELECT ?, tagId FROM note_tags WHERE noteId = ?
        `);
        const insertItem = db.prepare(`
          INSERT INTO note_split_items (operationId, noteId, sortOrder, createdVersion, title)
          VALUES (?, ?, ?, 1, ?)
        `);
        const claimedSourceAttachments = new Set<string>();

        selectedSections.forEach((section, selectedOrder) => {
          const createdId = createdIds[selectedOrder];
          insertNote.run(
            createdId,
            userId,
            target.workspaceId,
            target.notebookId,
            section.title,
            section.content,
            extractSearchableText(section.content, "markdown"),
            source.isArchived,
          );
          const preparedContent = prepareSectionAttachments({
            db,
            operationId,
            source,
            childNoteId: createdId,
            targetWorkspaceId: target.workspaceId,
            userId,
            content: section.content,
            claimedSourceAttachments,
            retainedSourceAttachments,
          });
          if (preparedContent !== section.content) {
            db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
              .run(preparedContent, extractSearchableText(preparedContent, "markdown"), createdId);
          }
          copyTag.run(createdId, source.id);
          normalizeCreatedNote(db, createdId, userId);
          insertItem.run(operationId, createdId, selectedOrder, section.title);
        });

        const normalizedSource = syncNoteBlocks(db, source.id, sourceContent, "markdown");
        const updateResult = db.prepare(`
          UPDATE notes
          SET content = ?, contentText = ?, contentFormat = 'markdown',
              version = version + 1, updatedAt = datetime('now')
          WHERE id = ? AND version = ?
        `).run(normalizedSource.content, normalizedSource.contentText, source.id, source.version);
        if (updateResult.changes !== 1) {
          const current = db.prepare("SELECT version FROM notes WHERE id = ?").get(source.id) as
            | { version: number }
            | undefined;
          throw new NoteSplitSelectionError(
            "笔记已被更新，请重新打开拆分预览",
            "VERSION_CONFLICT",
            409,
            { currentVersion: current?.version },
          );
        }
        syncAttachmentReferences(db, source.id, normalizedSource.content);
        syncNoteLinks(db, userId, source.id, normalizedSource.content);
      });
      transaction();

      const sourceNote = {
        ...selectNoteForUser(source.id, userId),
        tags: noteTagsRepository.listTagsByNoteId(source.id),
      };
      const createdNotes = createdIds.map((id) => ({
        ...selectNoteForUser(id, userId),
        tags: noteTagsRepository.listTagsByNoteId(id),
      }));
      syncSourceYDoc(source.id, sourceNote.content, userId);
      publishSourceUpdate(sourceNote, userId);
      publishCreatedNotes(createdNotes, userId);
      logAudit(userId, "note", "split", {
        noteId: source.id,
        operationId,
        headingLevel,
        selectedSectionIndexes: selectedIndexes,
        totalSectionCount: plan.sections.length,
        createdNoteIds: createdIds,
      }, { targetType: "note", targetId: source.id });

      return c.json({
        operationId,
        sourceNote,
        createdNotes,
        headingLevel,
        preservePreamble,
        selectedSectionIndexes: selectedIndexes,
        retainedSectionCount: plan.sections.length - selectedSections.length,
        totalSectionCount: plan.sections.length,
        canUndo: true,
      }, 201);
    } catch (error) {
      return jsonError(c, error);
    }
  });
}

// index.hardened imports this module after task-stats-hardening. Wrapping the existing route patch
// at that point lets this selected-section handler register before the legacy all-section handler.
if (!globals[PARTIAL_NOTE_SPLIT_ROUTE_PATCH]) {
  globals[PARTIAL_NOTE_SPLIT_ROUTE_PATCH] = true;
  const prototype = Hono.prototype as any;
  const nativeRoute = prototype.route as (this: Hono<any>, path: string, subApp: Hono<any>) => Hono<any>;
  prototype.route = function patchedRoute(this: Hono<any>, path: string, subApp: Hono<any>) {
    if (path === "/api/notes") installPartialNoteSplitRoutes(subApp);
    return nativeRoute.call(this, path, subApp);
  };
}
