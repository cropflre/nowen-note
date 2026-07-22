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
  buildTiptapSplitSource,
  collectTiptapBlockIds,
  planTiptapNoteSplit,
  serializeTiptapSection,
  validateTiptapSplitPlan,
  TiptapSplitPlanError,
  type TiptapSplitHeadingLevel,
  type TiptapSplitSection,
} from "../lib/tiptapNoteSplit.js";
import { noteTagsRepository } from "../repositories/index.js";
import {
  createDeduplicatedAttachmentRow,
  type ExistingAttachmentForDedup,
} from "../routes/attachments-core.js";
import { logAudit } from "../services/audit.js";
import {
  broadcastNoteUpdated,
  broadcastToUser,
} from "../services/realtime.js";
import { ensureNoteSplitTables } from "./note-split.js";

const TIPTAP_NOTE_SPLIT_INSTALLED = Symbol.for("nowen.noteSplit.tiptapRoutesInstalled");
const TIPTAP_NOTE_SPLIT_ROUTE_PATCH = Symbol.for("nowen.noteSplit.tiptapRoutePatch");
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

class TiptapNoteSplitError extends Error {
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
    throw new TiptapNoteSplitError("无权拆分该笔记", "FORBIDDEN", 403);
  }
  const source = getSourceNote(noteId);
  if (!source) throw new TiptapNoteSplitError("笔记不存在", "NOT_FOUND", 404);
  if (source.isTrashed) throw new TiptapNoteSplitError("回收站中的笔记不能拆分", "NOTE_TRASHED", 409);
  if (source.isLocked) throw new TiptapNoteSplitError("锁定笔记不能拆分", "NOTE_LOCKED", 409);
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
  if (!notebook) throw new TiptapNoteSplitError("目标笔记本不存在", "NOTEBOOK_NOT_FOUND", 404);
  if (notebook.isDeleted) throw new TiptapNoteSplitError("目标笔记本已删除", "NOTEBOOK_TRASHED", 409);
  if ((notebook.workspaceId || null) !== (options.source.workspaceId || null)) {
    throw new TiptapNoteSplitError("不能跨工作区拆分笔记", "CROSS_WORKSPACE_SPLIT_FORBIDDEN", 409);
  }
  const { permission } = resolveNotebookPermission(requested, options.userId);
  if (!hasPermission(permission, "write")) {
    throw new TiptapNoteSplitError("无权在目标笔记本中创建章节", "NOTEBOOK_FORBIDDEN", 403);
  }
  return { notebookId: requested, workspaceId: notebook.workspaceId || null };
}

function normalizeSelectedIndexes(value: unknown, sectionCount: number): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TiptapNoteSplitError("请至少选择一个章节", "EMPTY_SECTION_SELECTION");
  }
  const indexes: number[] = [];
  const seen = new Set<number>();
  for (const raw of value) {
    if (!Number.isSafeInteger(raw)) {
      throw new TiptapNoteSplitError("章节索引必须是整数", "INVALID_SECTION_SELECTION");
    }
    const index = raw as number;
    if (index < 0 || index >= sectionCount) {
      throw new TiptapNoteSplitError("章节选择已失效，请重新打开预览", "INVALID_SECTION_SELECTION", 409);
    }
    if (seen.has(index)) {
      throw new TiptapNoteSplitError("章节选择包含重复项", "INVALID_SECTION_SELECTION");
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
  const synced = syncNoteBlocks(db, noteId, row.content || "", row.contentFormat || "tiptap-json");
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
        UPDATE attachments SET noteId = ?, workspaceId = ? WHERE id = ? AND noteId = ?
      `).run(options.childNoteId, options.targetWorkspaceId, sourceAttachmentId, options.source.id);
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

function countInboundBlockLinks(sourceNoteId: string, sections: TiptapSplitSection[]): number {
  const blockIds = collectTiptapBlockIds(sections.flatMap((section) => section.fullNodes));
  if (blockIds.length === 0) return 0;
  const db = getDb();
  let total = 0;
  for (let offset = 0; offset < blockIds.length; offset += 400) {
    const chunk = blockIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(",");
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM note_links
      WHERE targetNoteId = ?
        AND targetBlockId IN (${placeholders})
        AND sourceNoteId <> ?
    `).get(sourceNoteId, ...chunk, sourceNoteId) as { count: number };
    total += Number(row?.count || 0);
  }
  return total;
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
    console.warn("[note-split-tiptap] realtime source update failed:", error);
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
      console.warn("[note-split-tiptap] realtime child update failed:", error);
    }
  }
}

function jsonError(c: Context, error: unknown) {
  if (error instanceof TiptapNoteSplitError) {
    return c.json({ error: error.message, code: error.code, ...error.extra }, error.status);
  }
  if (error instanceof TiptapSplitPlanError) {
    return c.json({ error: error.message, code: error.code }, 409);
  }
  console.error("[note-split-tiptap] unexpected error:", error);
  return c.json({ error: "富文本文档拆分失败，所有修改已回滚", code: "NOTE_SPLIT_FAILED" }, 500);
}

export function installTiptapNoteSplitRoutes(router: Hono<any>): void {
  const tagged = router as Hono<any> & Record<symbol, boolean>;
  if (tagged[TIPTAP_NOTE_SPLIT_INSTALLED]) return;
  tagged[TIPTAP_NOTE_SPLIT_INSTALLED] = true;
  ensureNoteSplitTables();

  router.post("/:id/split", async (c: Context, next: Next) => {
    const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(body, "sectionIndexes")) {
      await next();
      return;
    }
    const noteId = c.req.param("id");
    const sourceBeforePermission = getSourceNote(noteId);
    if (!sourceBeforePermission || sourceBeforePermission.contentFormat !== "tiptap-json") {
      await next();
      return;
    }

    const userId = c.req.header("X-User-Id") || "";
    try {
      const source = assertWritableSource(noteId, userId);
      const headingLevel = body.headingLevel === 2 ? 2 : body.headingLevel === 1 ? 1 : null;
      if (!headingLevel) throw new TiptapNoteSplitError("headingLevel 必须是 1 或 2", "INVALID_HEADING_LEVEL");
      if (!Number.isSafeInteger(body.version) || body.version !== source.version) {
        throw new TiptapNoteSplitError(
          "笔记已被更新，请重新打开拆分预览",
          "VERSION_CONFLICT",
          409,
          { currentVersion: source.version },
        );
      }

      const plan = planTiptapNoteSplit(source.content || "", headingLevel as TiptapSplitHeadingLevel);
      const validationError = validateTiptapSplitPlan(plan);
      if (validationError) throw new TiptapNoteSplitError(validationError, "INVALID_SPLIT_PLAN", 409);
      const selectedIndexes = normalizeSelectedIndexes(body.sectionIndexes, plan.sections.length);
      const selectedSections = selectedIndexes.map((index) => plan.sections[index] as TiptapSplitSection);
      const inboundBlockLinkCount = countInboundBlockLinks(source.id, selectedSections);
      if (inboundBlockLinkCount > 0 && body.acknowledgeBlockLinkRisk !== true) {
        throw new TiptapNoteSplitError(
          `所选章节包含 ${inboundBlockLinkCount} 个外部块链接引用；拆分后这些旧链接仍指向原笔记，请确认风险后继续`,
          "BLOCK_LINKS_REQUIRE_CONFIRMATION",
          409,
          { blockLinkCount: inboundBlockLinkCount },
        );
      }

      const target = resolveTargetNotebook({ targetNotebookId: body.targetNotebookId, source, userId });
      const preservePreamble = body.preservePreamble !== false;
      const operationId = uuid();
      const directoryVersion = source.version + 1;
      const createdIds = selectedSections.map(() => uuid());
      const sourceContent = buildTiptapSplitSource({
        plan,
        preservePreamble,
        operationId,
        sections: selectedSections.map((section, index) => ({
          index: section.index,
          id: createdIds[index],
          title: section.title,
        })),
      });
      const retainedSourceAttachments = extractAttachmentIdsFromContent(sourceContent);
      const db = getDb();

      const transaction = db.transaction(() => {
        db.prepare(`
          INSERT INTO note_versions (
            id, noteId, userId, title, content, contentText, contentFormat, version,
            changeType, changeSummary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'edit', ?)
        `).run(
          uuid(), source.id, userId, source.title, source.content, source.contentText,
          source.contentFormat, source.version,
          `按 H${headingLevel} 拆分所选 ${selectedSections.length}/${plan.sections.length} 个富文本章节`,
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'tiptap-json', ?)
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
          const initialContent = serializeTiptapSection(plan, section);
          insertNote.run(
            createdId,
            userId,
            target.workspaceId,
            target.notebookId,
            section.title,
            initialContent,
            extractSearchableText(initialContent, "tiptap-json"),
            source.isArchived,
          );
          const preparedContent = prepareSectionAttachments({
            db,
            operationId,
            source,
            childNoteId: createdId,
            targetWorkspaceId: target.workspaceId,
            userId,
            content: initialContent,
            claimedSourceAttachments,
            retainedSourceAttachments,
          });
          if (preparedContent !== initialContent) {
            db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
              .run(preparedContent, extractSearchableText(preparedContent, "tiptap-json"), createdId);
          }
          copyTag.run(createdId, source.id);
          normalizeCreatedNote(db, createdId, userId);
          insertItem.run(operationId, createdId, selectedOrder, section.title);
        });

        const normalizedSource = syncNoteBlocks(db, source.id, sourceContent, "tiptap-json");
        const updateResult = db.prepare(`
          UPDATE notes
          SET content = ?, contentText = ?, contentFormat = 'tiptap-json',
              version = version + 1, updatedAt = datetime('now')
          WHERE id = ? AND version = ?
        `).run(normalizedSource.content, normalizedSource.contentText, source.id, source.version);
        if (updateResult.changes !== 1) {
          const current = db.prepare("SELECT version FROM notes WHERE id = ?").get(source.id) as
            | { version: number }
            | undefined;
          throw new TiptapNoteSplitError(
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
      publishSourceUpdate(sourceNote, userId);
      publishCreatedNotes(createdNotes, userId);
      logAudit(userId, "note", "split", {
        noteId: source.id,
        operationId,
        contentFormat: "tiptap-json",
        headingLevel,
        selectedSectionIndexes: selectedIndexes,
        totalSectionCount: plan.sections.length,
        inboundBlockLinkCount,
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
        blockLinkWarningCount: inboundBlockLinkCount,
        canUndo: true,
      }, 201);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  router.post("/:id/split/:operationId/undo", async (c: Context, next: Next) => {
    const noteId = c.req.param("id");
    const operationId = c.req.param("operationId");
    const operation = getDb().prepare(`
      SELECT * FROM note_split_operations WHERE id = ? AND sourceNoteId = ?
    `).get(operationId, noteId) as any;
    if (!operation || operation.originalContentFormat !== "tiptap-json") {
      await next();
      return;
    }

    const userId = c.req.header("X-User-Id") || "";
    try {
      const source = assertWritableSource(noteId, userId);
      if (operation.status !== "completed") {
        throw new TiptapNoteSplitError("该拆分已经撤销", "SPLIT_ALREADY_UNDONE", 409);
      }
      if (source.version !== operation.directoryVersion) {
        throw new TiptapNoteSplitError(
          "目录页已被继续编辑，不能自动撤销；可从版本历史恢复原文",
          "SPLIT_UNDO_SOURCE_CHANGED",
          409,
          { currentVersion: source.version, expectedVersion: operation.directoryVersion },
        );
      }

      const db = getDb();
      const items = db.prepare(`
        SELECT i.noteId, i.createdVersion, i.sortOrder, n.version, n.isTrashed
        FROM note_split_items i
        LEFT JOIN notes n ON n.id = i.noteId
        WHERE i.operationId = ?
        ORDER BY i.sortOrder ASC
      `).all(operationId) as Array<{
        noteId: string;
        createdVersion: number;
        sortOrder: number;
        version: number | null;
        isTrashed: number | null;
      }>;
      if (items.length === 0 || items.some((item) => item.version === null)) {
        throw new TiptapNoteSplitError("部分章节笔记已不存在，不能自动撤销", "SPLIT_UNDO_CHILD_MISSING", 409);
      }
      if (items.some((item) => item.version !== item.createdVersion || item.isTrashed !== 0)) {
        throw new TiptapNoteSplitError("章节笔记已被编辑或移动到回收站，不能自动撤销", "SPLIT_UNDO_CHILD_CHANGED", 409);
      }
      const childIds = items.map((item) => item.noteId);
      const placeholders = childIds.map(() => "?").join(",");
      const untrackedAttachmentCount = childIds.length > 0
        ? (db.prepare(`
            SELECT COUNT(*) AS count FROM attachments a
            WHERE a.noteId IN (${placeholders})
              AND NOT EXISTS (
                SELECT 1 FROM note_split_attachment_copies c
                WHERE c.operationId = ? AND c.attachmentId = a.id
              )
          `).get(...childIds, operationId) as { count: number }).count
        : 0;
      if (untrackedAttachmentCount > 0) {
        throw new TiptapNoteSplitError("章节笔记中已上传新附件，不能自动撤销", "SPLIT_UNDO_CHILD_ATTACHMENTS", 409);
      }

      const transaction = db.transaction(() => {
        db.prepare(`
          INSERT INTO note_versions (
            id, noteId, userId, title, content, contentText, contentFormat, version,
            changeType, changeSummary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'restore', ?)
        `).run(
          uuid(), source.id, userId, source.title, source.content, source.contentText,
          source.contentFormat, source.version, "撤销富文本文档拆分前的目录页备份",
        );
        db.prepare(`
          UPDATE attachments SET noteId = ?, workspaceId = ?
          WHERE id IN (
            SELECT attachmentId FROM note_split_attachment_copies
            WHERE operationId = ? AND kind = 'moved'
          )
        `).run(source.id, source.workspaceId, operationId);
        if (childIds.length > 0) db.prepare(`DELETE FROM notes WHERE id IN (${placeholders})`).run(...childIds);

        const restored = syncNoteBlocks(
          db,
          source.id,
          operation.originalContent,
          operation.originalContentFormat,
        );
        const updateResult = db.prepare(`
          UPDATE notes
          SET title = ?, content = ?, contentText = ?, contentFormat = ?,
              version = version + 1, updatedAt = datetime('now')
          WHERE id = ? AND version = ?
        `).run(
          operation.originalTitle,
          restored.content,
          restored.contentText,
          operation.originalContentFormat,
          source.id,
          operation.directoryVersion,
        );
        if (updateResult.changes !== 1) {
          throw new TiptapNoteSplitError(
            "目录页已被继续编辑，不能自动撤销；可从版本历史恢复原文",
            "SPLIT_UNDO_SOURCE_CHANGED",
            409,
          );
        }
        syncAttachmentReferences(db, source.id, restored.content);
        syncNoteLinks(db, userId, source.id, restored.content);
        db.prepare(`
          UPDATE note_split_operations SET status = 'undone', undoneAt = datetime('now') WHERE id = ?
        `).run(operationId);
      });
      transaction();

      const sourceNote = {
        ...selectNoteForUser(source.id, userId),
        tags: noteTagsRepository.listTagsByNoteId(source.id),
      };
      publishSourceUpdate(sourceNote, userId);
      logAudit(userId, "note", "split_undo", {
        noteId: source.id,
        operationId,
        contentFormat: "tiptap-json",
        removedNoteIds: childIds,
      }, { targetType: "note", targetId: source.id });
      return c.json({ sourceNote, removedNoteIds: childIds, operationId, undone: true });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}

if (!globals[TIPTAP_NOTE_SPLIT_ROUTE_PATCH]) {
  globals[TIPTAP_NOTE_SPLIT_ROUTE_PATCH] = true;
  const prototype = Hono.prototype as any;
  const nativeRoute = prototype.route as (this: Hono<any>, path: string, subApp: Hono<any>) => Hono<any>;
  prototype.route = function patchedRoute(this: Hono<any>, path: string, subApp: Hono<any>) {
    if (path === "/api/notes") installTiptapNoteSplitRoutes(subApp);
    return nativeRoute.call(this, path, subApp);
  };
}
