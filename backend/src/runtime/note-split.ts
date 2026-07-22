import { v4 as uuid } from "uuid";
import type { Hono } from "hono";
import type { Context } from "hono";

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
  buildMarkdownSplitDirectory,
  planMarkdownNoteSplit,
  validateMarkdownSplitPlan,
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

const NOTE_SPLIT_INSTALLED = Symbol.for("nowen.noteSplit.routesInstalled");

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

class NoteSplitError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function ensureNoteSplitTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS note_split_operations (
      id TEXT PRIMARY KEY,
      sourceNoteId TEXT NOT NULL,
      actorUserId TEXT NOT NULL,
      originalVersion INTEGER NOT NULL,
      directoryVersion INTEGER NOT NULL,
      originalTitle TEXT NOT NULL,
      originalContent TEXT NOT NULL,
      originalContentText TEXT NOT NULL,
      originalContentFormat TEXT NOT NULL,
      headingLevel INTEGER NOT NULL CHECK(headingLevel IN (1, 2)),
      status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed', 'undone')),
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      undoneAt TEXT,
      FOREIGN KEY (sourceNoteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (actorUserId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS note_split_items (
      operationId TEXT NOT NULL,
      noteId TEXT NOT NULL,
      sortOrder INTEGER NOT NULL,
      createdVersion INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      PRIMARY KEY (operationId, noteId),
      FOREIGN KEY (operationId) REFERENCES note_split_operations(id) ON DELETE CASCADE,
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS note_split_attachment_copies (
      operationId TEXT NOT NULL,
      noteId TEXT NOT NULL,
      sourceAttachmentId TEXT NOT NULL,
      attachmentId TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('moved', 'copy')),
      PRIMARY KEY (operationId, attachmentId),
      FOREIGN KEY (operationId) REFERENCES note_split_operations(id) ON DELETE CASCADE,
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (attachmentId) REFERENCES attachments(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_note_split_operations_source
      ON note_split_operations(sourceNoteId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_note_split_items_operation
      ON note_split_items(operationId, sortOrder ASC);
    CREATE INDEX IF NOT EXISTS idx_note_split_attachment_operation
      ON note_split_attachment_copies(operationId, noteId);
  `);
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
    throw new NoteSplitError("无权拆分该笔记", "FORBIDDEN", 403);
  }
  const source = getSourceNote(noteId);
  if (!source) throw new NoteSplitError("笔记不存在", "NOT_FOUND", 404);
  if (source.isTrashed) throw new NoteSplitError("回收站中的笔记不能拆分", "NOTE_TRASHED", 409);
  if (source.isLocked) throw new NoteSplitError("锁定笔记不能拆分", "NOTE_LOCKED", 409);
  if (source.contentFormat !== "markdown") {
    throw new NoteSplitError("当前仅支持拆分 Markdown 笔记", "SPLIT_MARKDOWN_ONLY", 409);
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
  if (!requested) {
    return { notebookId: null, workspaceId: options.source.workspaceId };
  }

  const db = getDb();
  const notebook = db.prepare(
    "SELECT id, workspaceId, isDeleted FROM notebooks WHERE id = ?",
  ).get(requested) as { id: string; workspaceId: string | null; isDeleted: number } | undefined;
  if (!notebook) throw new NoteSplitError("目标笔记本不存在", "NOTEBOOK_NOT_FOUND", 404);
  if (notebook.isDeleted) throw new NoteSplitError("目标笔记本已删除", "NOTEBOOK_TRASHED", 409);
  if ((notebook.workspaceId || null) !== (options.source.workspaceId || null)) {
    throw new NoteSplitError("不能跨工作区拆分笔记", "CROSS_WORKSPACE_SPLIT_FORBIDDEN", 409);
  }
  const { permission } = resolveNotebookPermission(requested, options.userId);
  if (!hasPermission(permission, "write")) {
    throw new NoteSplitError("无权在目标笔记本中创建章节", "NOTEBOOK_FORBIDDEN", 403);
  }
  return { notebookId: requested, workspaceId: notebook.workspaceId || null };
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

/**
 * Keep attachment URLs independently valid after the directory note or any chapter is deleted.
 *
 * The first chapter that references a source-owned attachment receives the original metadata row.
 * Additional chapters receive a new attachment id pointing at the same physical path. No file bytes
 * are copied. Every move/copy is recorded so undo can move originals back and distinguish later
 * user uploads from split-generated metadata.
 */
function prepareSectionAttachments(options: {
  db: ReturnType<typeof getDb>;
  operationId: string;
  source: SourceNoteRow;
  childNoteId: string;
  targetWorkspaceId: string | null;
  userId: string;
  content: string;
  claimedSourceAttachments: Set<string>;
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

    if (
      attachment.noteId === options.source.id
      && !options.claimedSourceAttachments.has(sourceAttachmentId)
    ) {
      options.db.prepare(`
        UPDATE attachments
        SET noteId = ?, workspaceId = ?
        WHERE id = ? AND noteId = ?
      `).run(
        options.childNoteId,
        options.targetWorkspaceId,
        sourceAttachmentId,
        options.source.id,
      );
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
    console.warn("[note-split] realtime source update failed:", error);
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
      console.warn("[note-split] realtime created note update failed:", error);
    }
  }
}

function syncSourceYDoc(noteId: string, content: string, userId: string): void {
  try {
    const result = yReplaceContentAsUpdate(noteId, content, userId || null);
    if (result) broadcastYjsUpdate(noteId, result.updateBase64);
  } catch (error) {
    console.warn("[note-split] Y.Doc replacement failed:", error);
  }
}

function jsonError(c: Context, error: unknown) {
  if (error instanceof NoteSplitError) {
    return c.json({ error: error.message, code: error.code, ...error.extra }, error.status);
  }
  console.error("[note-split] unexpected error:", error);
  return c.json({ error: "拆分操作失败，所有修改已回滚", code: "NOTE_SPLIT_FAILED" }, 500);
}

export function installNoteSplitRoutes(router: Hono<any>): void {
  const tagged = router as Hono<any> & Record<symbol, boolean>;
  if (tagged[NOTE_SPLIT_INSTALLED]) return;
  tagged[NOTE_SPLIT_INSTALLED] = true;
  ensureNoteSplitTables();

  router.post("/:id/split", async (c: Context) => {
    const noteId = c.req.param("id");
    const userId = c.req.header("X-User-Id") || "";
    try {
      try { yFlush(noteId); } catch { /* active room may not exist */ }
      const source = assertWritableSource(noteId, userId);
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const headingLevel = body.headingLevel === 2 ? 2 : body.headingLevel === 1 ? 1 : null;
      if (!headingLevel) throw new NoteSplitError("headingLevel 必须是 1 或 2", "INVALID_HEADING_LEVEL");
      if (!Number.isSafeInteger(body.version) || body.version !== source.version) {
        throw new NoteSplitError(
          "笔记已被更新，请重新打开拆分预览",
          "VERSION_CONFLICT",
          409,
          { currentVersion: source.version },
        );
      }
      const target = resolveTargetNotebook({ targetNotebookId: body.targetNotebookId, source, userId });
      const preservePreamble = body.preservePreamble !== false;
      const plan = planMarkdownNoteSplit(source.content || "", headingLevel as NoteSplitHeadingLevel);
      const validationError = validateMarkdownSplitPlan(plan);
      if (validationError) throw new NoteSplitError(validationError, "INVALID_SPLIT_PLAN", 409);

      const db = getDb();
      const operationId = uuid();
      const directoryVersion = source.version + 1;
      const createdIds = plan.sections.map(() => uuid());
      const directoryContent = buildMarkdownSplitDirectory({
        sourceTitle: source.title,
        operationId,
        headingLevel,
        preamble: plan.preamble,
        preservePreamble,
        sections: plan.sections.map((section, index) => ({ id: createdIds[index], title: section.title })),
      });

      const transaction = db.transaction(() => {
        db.prepare(`
          INSERT INTO note_versions (
            id, noteId, userId, title, content, contentText, contentFormat, version,
            changeType, changeSummary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'edit', ?)
        `).run(
          uuid(), source.id, userId, source.title, source.content, source.contentText,
          source.contentFormat, source.version, `按 H${headingLevel} 拆分为 ${plan.sections.length} 篇章节笔记`,
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

        plan.sections.forEach((section, index) => {
          const createdId = createdIds[index];
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
          });
          if (preparedContent !== section.content) {
            db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
              .run(preparedContent, extractSearchableText(preparedContent, "markdown"), createdId);
          }
          copyTag.run(createdId, source.id);
          normalizeCreatedNote(db, createdId, userId);
          insertItem.run(operationId, createdId, index, section.title);
        });

        const normalizedDirectory = syncNoteBlocks(db, source.id, directoryContent, "markdown");
        const updateResult = db.prepare(`
          UPDATE notes
          SET content = ?, contentText = ?, contentFormat = 'markdown',
              version = version + 1, updatedAt = datetime('now')
          WHERE id = ? AND version = ?
        `).run(normalizedDirectory.content, normalizedDirectory.contentText, source.id, source.version);
        if (updateResult.changes !== 1) {
          const current = db.prepare("SELECT version FROM notes WHERE id = ?").get(source.id) as
            | { version: number }
            | undefined;
          throw new NoteSplitError(
            "笔记已被更新，请重新打开拆分预览",
            "VERSION_CONFLICT",
            409,
            { currentVersion: current?.version },
          );
        }
        syncAttachmentReferences(db, source.id, normalizedDirectory.content);
        syncNoteLinks(db, userId, source.id, normalizedDirectory.content);
      });
      transaction();

      const sourceNote = { ...selectNoteForUser(source.id, userId), tags: noteTagsRepository.listTagsByNoteId(source.id) };
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
        createdNoteIds: createdIds,
      }, { targetType: "note", targetId: source.id });

      return c.json({
        operationId,
        sourceNote,
        createdNotes,
        headingLevel,
        preservePreamble,
        canUndo: true,
      }, 201);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  router.post("/:id/split/:operationId/undo", async (c: Context) => {
    const noteId = c.req.param("id");
    const operationId = c.req.param("operationId");
    const userId = c.req.header("X-User-Id") || "";
    try {
      try { yFlush(noteId); } catch { /* active room may not exist */ }
      const source = assertWritableSource(noteId, userId);
      const db = getDb();
      const operation = db.prepare(`
        SELECT * FROM note_split_operations
        WHERE id = ? AND sourceNoteId = ?
      `).get(operationId, noteId) as any;
      if (!operation) throw new NoteSplitError("拆分记录不存在", "SPLIT_OPERATION_NOT_FOUND", 404);
      if (operation.status !== "completed") {
        throw new NoteSplitError("该拆分已经撤销", "SPLIT_ALREADY_UNDONE", 409);
      }
      if (source.version !== operation.directoryVersion) {
        throw new NoteSplitError(
          "目录页已被继续编辑，不能自动撤销；可从版本历史恢复原文",
          "SPLIT_UNDO_SOURCE_CHANGED",
          409,
          { currentVersion: source.version, expectedVersion: operation.directoryVersion },
        );
      }

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
        throw new NoteSplitError("部分章节笔记已不存在，不能自动撤销", "SPLIT_UNDO_CHILD_MISSING", 409);
      }
      if (items.some((item) => item.version !== item.createdVersion || item.isTrashed !== 0)) {
        throw new NoteSplitError("章节笔记已被编辑或移动到回收站，不能自动撤销", "SPLIT_UNDO_CHILD_CHANGED", 409);
      }
      const childIds = items.map((item) => item.noteId);
      const placeholders = childIds.map(() => "?").join(",");
      const untrackedAttachmentCount = childIds.length > 0
        ? (db.prepare(`
            SELECT COUNT(*) AS count
            FROM attachments a
            WHERE a.noteId IN (${placeholders})
              AND NOT EXISTS (
                SELECT 1 FROM note_split_attachment_copies c
                WHERE c.operationId = ? AND c.attachmentId = a.id
              )
          `).get(...childIds, operationId) as { count: number }).count
        : 0;
      if (untrackedAttachmentCount > 0) {
        throw new NoteSplitError("章节笔记中已上传新附件，不能自动撤销", "SPLIT_UNDO_CHILD_ATTACHMENTS", 409);
      }

      const transaction = db.transaction(() => {
        db.prepare(`
          INSERT INTO note_versions (
            id, noteId, userId, title, content, contentText, contentFormat, version,
            changeType, changeSummary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'restore', ?)
        `).run(
          uuid(), source.id, userId, source.title, source.content, source.contentText,
          source.contentFormat, source.version, "撤销文档拆分前的目录页备份",
        );

        db.prepare(`
          UPDATE attachments
          SET noteId = ?, workspaceId = ?
          WHERE id IN (
            SELECT attachmentId FROM note_split_attachment_copies
            WHERE operationId = ? AND kind = 'moved'
          )
        `).run(source.id, source.workspaceId, operationId);

        if (childIds.length > 0) {
          db.prepare(`DELETE FROM notes WHERE id IN (${placeholders})`).run(...childIds);
        }
        const restored = syncNoteBlocks(
          db,
          source.id,
          operation.originalContent,
          operation.originalContentFormat || "markdown",
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
          const current = db.prepare("SELECT version FROM notes WHERE id = ?").get(source.id) as
            | { version: number }
            | undefined;
          throw new NoteSplitError(
            "目录页已被继续编辑，不能自动撤销；可从版本历史恢复原文",
            "SPLIT_UNDO_SOURCE_CHANGED",
            409,
            { currentVersion: current?.version, expectedVersion: operation.directoryVersion },
          );
        }
        syncAttachmentReferences(db, source.id, restored.content);
        syncNoteLinks(db, userId, source.id, restored.content);
        db.prepare(`
          UPDATE note_split_operations
          SET status = 'undone', undoneAt = datetime('now')
          WHERE id = ?
        `).run(operationId);
      });
      transaction();

      const sourceNote = { ...selectNoteForUser(source.id, userId), tags: noteTagsRepository.listTagsByNoteId(source.id) };
      syncSourceYDoc(source.id, sourceNote.content, userId);
      publishSourceUpdate(sourceNote, userId);
      logAudit(userId, "note", "split_undo", {
        noteId: source.id,
        operationId,
        removedNoteIds: childIds,
      }, { targetType: "note", targetId: source.id });
      return c.json({ sourceNote, removedNoteIds: childIds, operationId, undone: true });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
