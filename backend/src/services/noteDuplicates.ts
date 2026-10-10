import type Database from "better-sqlite3";

import { getDb } from "../db/schema.js";
import { syncReferences } from "../lib/attachmentRefs.js";
import { readAuthoritativeNoteContent, rebuildBlockAuthorityStore } from "../lib/blockAuthorityStore.js";
import { syncNoteBlocks } from "../lib/noteBlocks.js";
import { syncNoteLinks } from "../lib/noteLinks.js";
import { hasPermission, resolveNotePermission } from "../middleware/acl.js";
import { enqueueAttachment } from "./embedding-worker.js";
import { createKnowledgeChild, KnowledgeTreeError, type KnowledgeTreeNode } from "./knowledgeTree.js";
import { resolveKnowledgeNodeAccess } from "./knowledgeCapabilities.js";
import {
  cleanupCopiedAttachmentObjects,
  copyReferencedNoteAttachments,
  NoteAttachmentCopyError,
  rewriteSourceAttachmentUrl,
} from "./noteAttachmentCopy.js";
import { yFlush } from "./yjs.js";
import { rebuildYjsSubdocumentsIfEnabled } from "./yjs-subdocuments.js";

type SupportedNoteFormat = "tiptap-json" | "markdown";
export type DuplicateNotePlacement = "sibling" | "child";

interface SourceNoteRow {
  id: string;
  workspaceId: string | null;
  title: string;
  content: string;
  contentFormat: string;
  isLocked: number;
  isTrashed: number;
  version: number;
  treeNodeId: string;
  treeParentId: string | null;
  treeScopeKey: string;
}

export interface DuplicatedNoteResult {
  note: Record<string, unknown>;
  tags: Array<Record<string, unknown>>;
  node: KnowledgeTreeNode;
}

export class DuplicateNoteError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 403 | 404 | 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = "DuplicateNoteError";
  }
}

function readSourceNote(db: Database.Database, noteId: string): SourceNoteRow | null {
  return (db.prepare(`
    SELECT note.id, note.workspaceId, note.title,
           note.content, note.contentFormat, note.isLocked,
           note.isTrashed, note.version, tree.parentId AS treeParentId,
           tree.scopeKey AS treeScopeKey, tree.id AS treeNodeId
    FROM notes note
    JOIN knowledge_tree_nodes tree
      ON tree.resourceType = 'note' AND tree.resourceId = note.id AND tree.isDeleted = 0
    WHERE note.id = ?
    LIMIT 1
  `).get(noteId) as SourceNoteRow | undefined) || null;
}

function duplicateTitleBase(title: string): string {
  const normalized = title.trim() || "无标题笔记";
  return normalized.replace(/（副本(?: \d+)?）$/u, "") || normalized;
}

function nextDuplicateTitle(db: Database.Database, source: SourceNoteRow, parentId: string | null): string {
  const siblingTitles = db.prepare(`
    SELECT note.title
    FROM knowledge_tree_nodes tree
    JOIN notes note ON tree.resourceType = 'note' AND tree.resourceId = note.id
    WHERE tree.scopeKey = ? AND tree.isDeleted = 0 AND note.isTrashed = 0
      AND ((? IS NULL AND tree.parentId IS NULL) OR tree.parentId = ?)
  `).all(source.treeScopeKey, parentId, parentId) as Array<{ title: string }>;
  const used = new Set(siblingTitles.map((item) => item.title));
  const base = duplicateTitleBase(source.title);
  const first = `${base}（副本）`;
  if (!used.has(first)) return first;
  let index = 2;
  while (used.has(`${base}（副本 ${index}）`)) index += 1;
  return `${base}（副本 ${index}）`;
}

function ensureSourceParentCanBeReused(source: SourceNoteRow, userId: string): void {
  if (source.treeParentId !== null) return;
  const actorRootScope = source.workspaceId
    ? `workspace:${source.workspaceId}`
    : `personal:${userId}`;
  if (source.treeScopeKey !== actorRootScope) {
    throw new DuplicateNoteError(
      "NOTE_DUPLICATE_PARENT_FORBIDDEN",
      403,
      "没有在源笔记所在根目录创建内容的权限",
    );
  }
}

function resolveDuplicateParent(
  db: Database.Database,
  source: SourceNoteRow,
  userId: string,
  placement: DuplicateNotePlacement,
): string | null {
  const parentId = placement === "child" ? source.treeNodeId : source.treeParentId;
  if (placement === "sibling") ensureSourceParentCanBeReused(source, userId);
  if (parentId && !resolveKnowledgeNodeAccess(parentId, userId, db).capabilities.canCreate) {
    throw new DuplicateNoteError("NOTE_DUPLICATE_PARENT_FORBIDDEN", 403, "没有在目标目录创建内容的权限");
  }
  return parentId;
}

function mapKnownError(error: unknown): never {
  if (error instanceof DuplicateNoteError) throw error;
  if (error instanceof NoteAttachmentCopyError) {
    throw new DuplicateNoteError(`NOTE_DUPLICATE_${error.code}`, error.status, error.message);
  }
  if (error instanceof KnowledgeTreeError) {
    throw new DuplicateNoteError(error.code, error.status, error.message);
  }
  throw error;
}

export async function duplicateNote(input: {
  userId: string;
  noteId: string;
  placement?: DuplicateNotePlacement;
}): Promise<DuplicatedNoteResult> {
  const { placement = "sibling" } = input;
  if (placement !== "sibling" && placement !== "child") {
    throw new DuplicateNoteError("NOTE_DUPLICATE_PLACEMENT_INVALID", 400, "无效的副本位置");
  }
  const db = getDb();
  let source = readSourceNote(db, input.noteId);
  if (!source || source.isTrashed === 1) {
    throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_NOT_FOUND", 404, "源笔记不存在或已进入回收站");
  }
  const { permission } = resolveNotePermission(source.id, input.userId);
  if (!hasPermission(permission, "read")) {
    throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_FORBIDDEN", 403, "没有读取源笔记的权限");
  }
  if (source.isLocked === 1) {
    throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_LOCKED", 403, "请先解锁笔记再创建副本");
  }
  if (source.contentFormat !== "markdown" && source.contentFormat !== "tiptap-json") {
    throw new DuplicateNoteError("NOTE_DUPLICATE_FORMAT_UNSUPPORTED", 400, "仅支持复制富文本和 Markdown 笔记");
  }
  resolveDuplicateParent(db, source, input.userId, placement);

  yFlush(source.id);
  source = readSourceNote(db, input.noteId);
  if (!source || source.isTrashed === 1 || source.isLocked === 1) {
    throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_CHANGED", 409, "源笔记状态已变化，请刷新后重试");
  }
  if (source.contentFormat !== "markdown" && source.contentFormat !== "tiptap-json") {
    throw new DuplicateNoteError("NOTE_DUPLICATE_FORMAT_UNSUPPORTED", 400, "仅支持复制富文本和 Markdown 笔记");
  }
  const stableSource = source;
  const contentFormat = source.contentFormat as SupportedNoteFormat;
  const authoritativeContent = readAuthoritativeNoteContent(db, source.id, source.content || "").content;
  // 新建且尚未编辑的富文本使用 {}；副本的 block authority 需要合法空 doc。
  const authoritative = contentFormat === "tiptap-json" && authoritativeContent.trim() === "{}"
    ? JSON.stringify({ type: "doc", content: [] })
    : authoritativeContent;
  const sourceVersion = source.version;
  const copied = await copyReferencedNoteAttachments({
    db,
    userId: input.userId,
    noteId: source.id,
    content: authoritative,
  }).catch(mapKnownError);

  let content = authoritative;
  for (const attachment of copied) {
    content = rewriteSourceAttachmentUrl(
      content,
      attachment.sourceId,
      `/api/attachments/${attachment.id}`,
    );
  }

  let result: DuplicatedNoteResult | null = null;
  try {
    result = db.transaction(() => {
      const current = readSourceNote(db, stableSource.id);
      if (!current || current.isTrashed === 1 || current.isLocked === 1) {
        throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_CHANGED", 409, "源笔记状态已变化，请刷新后重试");
      }
      const currentPermission = resolveNotePermission(current.id, input.userId).permission;
      if (!hasPermission(currentPermission, "read")) {
        throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_FORBIDDEN", 403, "没有读取源笔记的权限");
      }
      if (current.version !== sourceVersion
        || current.treeNodeId !== stableSource.treeNodeId
        || current.treeParentId !== stableSource.treeParentId
        || current.workspaceId !== stableSource.workspaceId
        || current.treeScopeKey !== stableSource.treeScopeKey
        || current.contentFormat !== contentFormat) {
        throw new DuplicateNoteError("NOTE_DUPLICATE_SOURCE_CHANGED", 409, "源笔记已更新或移动，请重试");
      }

      const parentId = resolveDuplicateParent(db, current, input.userId, placement);
      const title = nextDuplicateTitle(db, current, parentId);
      const created = createKnowledgeChild({
        actorUserId: input.userId,
        workspaceId: current.workspaceId,
        parentId,
        nodeType: contentFormat === "markdown" ? "markdown" : "note",
        title,
        db,
      });
      const createdNote = db.prepare("SELECT workspaceId, version FROM notes WHERE id = ?")
        .get(created.resourceId) as { workspaceId: string | null; version: number } | undefined;
      if (!createdNote) {
        throw new DuplicateNoteError("NOTE_DUPLICATE_CREATE_FAILED", 500, "副本创建失败");
      }

      const insertAttachment = db.prepare(`
        INSERT INTO attachments (
          id, noteId, userId, filename, mimeType, size, path, workspaceId, hash, uploadSource
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'note_duplicate')
      `);
      for (const attachment of copied) {
        insertAttachment.run(
          attachment.id,
          created.resourceId,
          input.userId,
          attachment.filename,
          attachment.mimeType,
          attachment.size,
          attachment.path,
          createdNote.workspaceId,
          attachment.hash,
        );
      }

      const synced = syncNoteBlocks(db, created.resourceId, content, contentFormat);
      db.prepare(`
        UPDATE notes
        SET content = ?, contentText = ?, contentFormat = ?, updatedAt = datetime('now')
        WHERE id = ?
      `).run(synced.content, synced.contentText, contentFormat, created.resourceId);
      db.prepare(`
        INSERT OR IGNORE INTO note_tags (noteId, tagId)
        SELECT ?, tagId FROM note_tags WHERE noteId = ?
      `).run(created.resourceId, current.id);
      syncReferences(db, created.resourceId, synced.content);
      syncNoteLinks(db, input.userId, created.resourceId, synced.content);
      rebuildBlockAuthorityStore(db, created.resourceId, synced.content, contentFormat, {
        noteVersion: createdNote.version,
        operationType: "create",
      });
      rebuildYjsSubdocumentsIfEnabled(db, created.resourceId, synced.content, contentFormat);

      const createdRecord = db.prepare(`
        SELECT id, userId, notebookId, workspaceId, title, content, contentText,
               isPinned, 0 AS isFavorite, isLocked, isArchived, isTrashed,
               version, sortOrder, createdAt, updatedAt, trashedAt, contentFormat
        FROM notes WHERE id = ?
      `).get(created.resourceId) as Record<string, unknown> | undefined;
      if (!createdRecord) {
        throw new DuplicateNoteError("NOTE_DUPLICATE_CREATE_FAILED", 500, "副本创建失败");
      }
      const createdTags = db.prepare(`
        SELECT tag.* FROM tags tag
        JOIN note_tags relation ON relation.tagId = tag.id
        WHERE relation.noteId = ?
      `).all(created.resourceId) as Array<Record<string, unknown>>;
      return { node: created, note: createdRecord, tags: createdTags };
    })();
  } catch (error) {
    await cleanupCopiedAttachmentObjects(copied);
    mapKnownError(error);
  }
  if (!result) {
    await cleanupCopiedAttachmentObjects(copied);
    throw new DuplicateNoteError("NOTE_DUPLICATE_CREATE_FAILED", 500, "副本创建失败");
  }

  for (const attachment of copied) {
    enqueueAttachment({
      attachmentId: attachment.id,
      userId: input.userId,
      workspaceId: (result.note.workspaceId as string | null) || null,
      noteId: result.node.resourceId,
    });
  }

  return result;
}
