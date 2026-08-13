import { createHash } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";

import { getDb } from "../db/schema.js";
import { extractAttachmentIdsFromContent, syncReferences } from "../lib/attachmentRefs.js";
import { rebuildBlockAuthorityStore } from "../lib/blockAuthorityStore.js";
import { syncNoteBlocks } from "../lib/noteBlocks.js";
import { syncNoteLinks } from "../lib/noteLinks.js";
import {
  getUserWorkspaceRole,
  hasPermission,
  isSystemAdmin,
  resolveNotePermission,
} from "../middleware/acl.js";
import {
  deleteAttachmentObject,
  getUploadMonthPath,
  readAttachmentObject,
  writeAttachmentObject,
} from "./attachment-storage.js";
import { createKnowledgeChild, type KnowledgeTreeNode } from "./knowledgeTree.js";
import { enqueueAttachment } from "./embedding-worker.js";
import { rebuildYjsSubdocumentsIfEnabled } from "./yjs-subdocuments.js";

export type NoteTemplateFormat = "tiptap-json" | "markdown";

export interface NoteTemplateSummary {
  id: string;
  workspaceId: string | null;
  createdBy: string;
  name: string;
  contentFormat: NoteTemplateFormat;
  sourceNoteId: string | null;
  attachmentCount: number;
  createdAt: string;
  updatedAt: string;
  canDelete: boolean;
}

interface NoteTemplateRow {
  id: string;
  workspaceId: string | null;
  createdBy: string;
  name: string;
  content: string;
  contentText: string;
  contentFormat: NoteTemplateFormat;
  sourceNoteId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TemplateAttachmentRow {
  id: string;
  templateId: string;
  sourceAttachmentId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  hash: string | null;
}

interface SourceAttachmentRow {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  hash: string | null;
}

interface CopiedTemplateAttachment extends TemplateAttachmentRow {
  sourceId: string;
}

interface CopiedNoteAttachment {
  id: string;
  templateAttachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  hash: string;
}

export class NoteTemplateError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 403 | 404 | 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = "NoteTemplateError";
  }
}

function normalizeWorkspaceId(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  return !normalized || normalized === "personal" || normalized === "null" ? null : normalized;
}

function requireWorkspaceAccess(userId: string, workspaceId: string | null): void {
  if (!workspaceId) return;
  if (isSystemAdmin(userId) || getUserWorkspaceRole(workspaceId, userId)) return;
  throw new NoteTemplateError("NOTE_TEMPLATE_WORKSPACE_FORBIDDEN", 403, "无权访问该工作区的模板");
}

function canManageTemplate(template: Pick<NoteTemplateRow, "createdBy" | "workspaceId">, userId: string): boolean {
  if (template.createdBy === userId || isSystemAdmin(userId)) return true;
  if (!template.workspaceId) return false;
  const role = getUserWorkspaceRole(template.workspaceId, userId);
  return role === "owner" || role === "admin";
}

function validateName(value: string): string {
  const name = value.trim();
  if (!name) throw new NoteTemplateError("NOTE_TEMPLATE_NAME_REQUIRED", 400, "模板名称不能为空");
  if (name.length > 200) throw new NoteTemplateError("NOTE_TEMPLATE_NAME_TOO_LONG", 400, "模板名称不能超过 200 个字符");
  return name;
}

function extensionFor(filename: string, storagePath: string): string {
  const candidate = path.extname(filename || storagePath).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(candidate) ? candidate : "";
}

function newStoragePath(filename: string, sourcePath: string): string {
  return `${getUploadMonthPath()}/${uuid()}${extensionFor(filename, sourcePath)}`;
}

function replaceUrl(content: string, from: string, to: string): string {
  if (!content || !from || from === to) return content || "";
  return content.split(from).join(to);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceSourceAttachmentUrl(content: string, attachmentId: string, to: string): string {
  if (!content || !attachmentId) return content || "";
  const attachmentPath = `/api/attachments/${escapeRegExp(attachmentId)}`;
  const pattern = new RegExp(
    `(?:https?:\\/\\/[^/\\s"'<>]+)?${attachmentPath}(?:\\?[^\\s"'<>)]*)?`,
    "gi",
  );
  return content.replace(pattern, to);
}

async function cleanupObjects(paths: string[]): Promise<void> {
  await Promise.allSettled(Array.from(new Set(paths.filter(Boolean))).map((item) => deleteAttachmentObject(item)));
}

function templateAssetUrl(id: string): string {
  return `/api/note-templates/assets/${id}`;
}

function noteAttachmentUrl(id: string): string {
  return `/api/attachments/${id}`;
}

async function snapshotSourceAttachments(
  db: Database.Database,
  userId: string,
  noteId: string,
  content: string,
  contentText: string,
): Promise<CopiedTemplateAttachment[]> {
  const ids = new Set([
    ...extractAttachmentIdsFromContent(content),
    ...extractAttachmentIdsFromContent(contentText),
  ]);
  const copied: CopiedTemplateAttachment[] = [];

  try {
    for (const sourceId of ids) {
      const source = db.prepare(`
        SELECT id, noteId, filename, mimeType, size, path, hash
        FROM attachments WHERE id = ?
      `).get(sourceId) as SourceAttachmentRow | undefined;
      if (!source) {
        throw new NoteTemplateError(
          "NOTE_TEMPLATE_ATTACHMENT_UNAVAILABLE",
          409,
          `正文引用的附件 ${sourceId} 不存在，无法生成独立模板快照`,
        );
      }
      if (source.noteId !== noteId) {
        const { permission } = resolveNotePermission(source.noteId, userId);
        if (!hasPermission(permission, "read")) {
          throw new NoteTemplateError(
            "NOTE_TEMPLATE_ATTACHMENT_FORBIDDEN",
            403,
            `无权复制正文引用的附件“${source.filename}”`,
          );
        }
      }
      const buffer = await readAttachmentObject(source.path);
      if (!buffer) {
        throw new NoteTemplateError(
          "NOTE_TEMPLATE_ATTACHMENT_MISSING",
          409,
          `附件“${source.filename}”的物理文件不存在，模板未保存`,
        );
      }
      const id = uuid();
      const storagePath = newStoragePath(source.filename, source.path);
      await writeAttachmentObject(storagePath, buffer, source.mimeType);
      copied.push({
        id,
        templateId: "",
        sourceAttachmentId: source.id,
        sourceId: source.id,
        filename: source.filename,
        mimeType: source.mimeType,
        size: buffer.byteLength,
        path: storagePath,
        hash: source.hash || createHash("sha256").update(buffer).digest("hex"),
      });
    }
    return copied;
  } catch (error) {
    await cleanupObjects(copied.map((item) => item.path));
    throw error;
  }
}

async function copyTemplateAttachments(rows: TemplateAttachmentRow[]): Promise<CopiedNoteAttachment[]> {
  const copied: CopiedNoteAttachment[] = [];
  try {
    for (const source of rows) {
      const buffer = await readAttachmentObject(source.path);
      if (!buffer) {
        throw new NoteTemplateError(
          "NOTE_TEMPLATE_ATTACHMENT_MISSING",
          409,
          `模板附件“${source.filename}”的物理文件不存在`,
        );
      }
      const storagePath = newStoragePath(source.filename, source.path);
      await writeAttachmentObject(storagePath, buffer, source.mimeType);
      copied.push({
        id: uuid(),
        templateAttachmentId: source.id,
        filename: source.filename,
        mimeType: source.mimeType,
        size: buffer.byteLength,
        path: storagePath,
        hash: source.hash || createHash("sha256").update(buffer).digest("hex"),
      });
    }
    return copied;
  } catch (error) {
    await cleanupObjects(copied.map((item) => item.path));
    throw error;
  }
}

function readTemplate(db: Database.Database, templateId: string): NoteTemplateRow {
  const row = db.prepare(`
    SELECT id, workspaceId, createdBy, name, content, contentText, contentFormat,
           sourceNoteId, createdAt, updatedAt
    FROM note_templates WHERE id = ?
  `).get(templateId) as NoteTemplateRow | undefined;
  if (!row) throw new NoteTemplateError("NOTE_TEMPLATE_NOT_FOUND", 404, "模板不存在或已删除");
  return row;
}

export function listNoteTemplates(input: {
  userId: string;
  workspaceId?: string | null;
}): NoteTemplateSummary[] {
  const db = getDb();
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  requireWorkspaceAccess(input.userId, workspaceId);
  const rows = (workspaceId
    ? db.prepare(`
        SELECT template.*, COUNT(asset.id) AS attachmentCount
        FROM note_templates template
        LEFT JOIN note_template_attachments asset ON asset.templateId = template.id
        WHERE template.workspaceId = ?
        GROUP BY template.id
        ORDER BY template.updatedAt DESC, template.id DESC
      `).all(workspaceId)
    : db.prepare(`
        SELECT template.*, COUNT(asset.id) AS attachmentCount
        FROM note_templates template
        LEFT JOIN note_template_attachments asset ON asset.templateId = template.id
        WHERE template.workspaceId IS NULL AND template.createdBy = ?
        GROUP BY template.id
        ORDER BY template.updatedAt DESC, template.id DESC
      `).all(input.userId)) as Array<NoteTemplateRow & { attachmentCount: number }>;

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId || null,
    createdBy: row.createdBy,
    name: row.name,
    contentFormat: row.contentFormat,
    sourceNoteId: row.sourceNoteId || null,
    attachmentCount: Number(row.attachmentCount || 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    canDelete: canManageTemplate(row, input.userId),
  }));
}

export async function createNoteTemplateFromNote(input: {
  userId: string;
  workspaceId?: string | null;
  noteId: string;
  name: string;
}): Promise<NoteTemplateSummary> {
  const db = getDb();
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  requireWorkspaceAccess(input.userId, workspaceId);
  const name = validateName(input.name);
  const source = db.prepare(`
    SELECT id, workspaceId, content, contentText, contentFormat, isLocked, isTrashed
    FROM notes WHERE id = ?
  `).get(input.noteId) as {
    id: string;
    workspaceId: string | null;
    content: string;
    contentText: string;
    contentFormat: string;
    isLocked: number;
    isTrashed: number;
  } | undefined;
  if (!source || source.isTrashed === 1) {
    throw new NoteTemplateError("NOTE_TEMPLATE_SOURCE_NOT_FOUND", 404, "源笔记不存在");
  }
  const { permission } = resolveNotePermission(source.id, input.userId);
  if (!hasPermission(permission, "write")) {
    throw new NoteTemplateError("NOTE_TEMPLATE_SOURCE_FORBIDDEN", 403, "没有权限将该笔记保存为模板");
  }
  if (source.isLocked === 1) {
    throw new NoteTemplateError("NOTE_TEMPLATE_SOURCE_LOCKED", 403, "请先解锁笔记再保存为模板");
  }
  if (normalizeWorkspaceId(source.workspaceId) !== workspaceId) {
    throw new NoteTemplateError("NOTE_TEMPLATE_SCOPE_MISMATCH", 409, "源笔记与当前模板空间不一致");
  }
  if (source.contentFormat !== "markdown" && source.contentFormat !== "tiptap-json") {
    throw new NoteTemplateError("NOTE_TEMPLATE_FORMAT_UNSUPPORTED", 400, "仅支持富文本和 Markdown 笔记模板");
  }

  const copied = await snapshotSourceAttachments(
    db,
    input.userId,
    source.id,
    source.content || "",
    source.contentText || "",
  );
  const templateId = uuid();
  let content = source.content || "";
  let contentText = source.contentText || "";
  for (const asset of copied) {
    asset.templateId = templateId;
    content = replaceSourceAttachmentUrl(content, asset.sourceId, templateAssetUrl(asset.id));
    contentText = replaceSourceAttachmentUrl(contentText, asset.sourceId, templateAssetUrl(asset.id));
  }

  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO note_templates (
          id, workspaceId, createdBy, name, content, contentText, contentFormat, sourceNoteId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        templateId,
        workspaceId,
        input.userId,
        name,
        content,
        contentText,
        source.contentFormat,
        source.id,
      );
      const insertAsset = db.prepare(`
        INSERT INTO note_template_attachments (
          id, templateId, sourceAttachmentId, filename, mimeType, size, path, hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const asset of copied) {
        insertAsset.run(
          asset.id,
          templateId,
          asset.sourceAttachmentId,
          asset.filename,
          asset.mimeType,
          asset.size,
          asset.path,
          asset.hash,
        );
      }
    })();
  } catch (error) {
    await cleanupObjects(copied.map((item) => item.path));
    throw error;
  }

  const created = readTemplate(db, templateId);
  return {
    id: created.id,
    workspaceId: created.workspaceId || null,
    createdBy: created.createdBy,
    name: created.name,
    contentFormat: created.contentFormat,
    sourceNoteId: created.sourceNoteId || null,
    attachmentCount: copied.length,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
    canDelete: true,
  };
}

export async function deleteNoteTemplate(input: {
  userId: string;
  workspaceId?: string | null;
  templateId: string;
}): Promise<{ success: true }> {
  const db = getDb();
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  requireWorkspaceAccess(input.userId, workspaceId);
  const template = readTemplate(db, input.templateId);
  if (normalizeWorkspaceId(template.workspaceId) !== workspaceId) {
    throw new NoteTemplateError("NOTE_TEMPLATE_SCOPE_MISMATCH", 404, "模板不存在或已删除");
  }
  if (!canManageTemplate(template, input.userId)) {
    throw new NoteTemplateError("NOTE_TEMPLATE_DELETE_FORBIDDEN", 403, "没有删除该模板的权限");
  }
  const assets = db.prepare("SELECT path FROM note_template_attachments WHERE templateId = ?")
    .all(template.id) as Array<{ path: string }>;
  db.prepare("DELETE FROM note_templates WHERE id = ?").run(template.id);
  await cleanupObjects(assets.map((item) => item.path));
  return { success: true };
}

export async function createNoteFromTemplate(input: {
  userId: string;
  workspaceId?: string | null;
  templateId: string;
  parentId: string | null;
}): Promise<{ noteId: string; node: KnowledgeTreeNode }> {
  const db = getDb();
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  requireWorkspaceAccess(input.userId, workspaceId);
  const template = readTemplate(db, input.templateId);
  if (normalizeWorkspaceId(template.workspaceId) !== workspaceId) {
    throw new NoteTemplateError("NOTE_TEMPLATE_SCOPE_MISMATCH", 404, "模板不存在或已删除");
  }
  if (!workspaceId && template.createdBy !== input.userId) {
    throw new NoteTemplateError("NOTE_TEMPLATE_FORBIDDEN", 403, "无权使用该模板");
  }
  if (input.parentId) {
    const parent = db.prepare(`
      SELECT workspaceId FROM knowledge_tree_nodes WHERE id = ? AND isDeleted = 0
    `).get(input.parentId) as { workspaceId: string | null } | undefined;
    if (!parent) throw new NoteTemplateError("NOTE_TEMPLATE_PARENT_NOT_FOUND", 404, "目标目录不存在");
    if (normalizeWorkspaceId(parent.workspaceId) !== workspaceId) {
      throw new NoteTemplateError("NOTE_TEMPLATE_TARGET_SCOPE_MISMATCH", 409, "模板与目标目录不在同一空间");
    }
  }

  const templateAssets = db.prepare(`
    SELECT id, templateId, sourceAttachmentId, filename, mimeType, size, path, hash
    FROM note_template_attachments WHERE templateId = ? ORDER BY id
  `).all(template.id) as TemplateAttachmentRow[];
  const copied = await copyTemplateAttachments(templateAssets);
  let content = template.content || "";
  let contentText = template.contentText || "";
  for (const asset of copied) {
    content = replaceUrl(content, templateAssetUrl(asset.templateAttachmentId), noteAttachmentUrl(asset.id));
    contentText = replaceUrl(contentText, templateAssetUrl(asset.templateAttachmentId), noteAttachmentUrl(asset.id));
  }

  let node: KnowledgeTreeNode;
  try {
    node = db.transaction(() => {
      if (!db.prepare("SELECT 1 AS ok FROM note_templates WHERE id = ?").get(template.id)) {
        throw new NoteTemplateError("NOTE_TEMPLATE_NOT_FOUND", 404, "模板不存在或已删除");
      }
      const created = createKnowledgeChild({
        actorUserId: input.userId,
        workspaceId,
        parentId: input.parentId,
        nodeType: template.contentFormat === "markdown" ? "markdown" : "note",
        title: template.name,
        db,
      });
      const note = db.prepare("SELECT workspaceId, version FROM notes WHERE id = ?")
        .get(created.resourceId) as { workspaceId: string | null; version: number } | undefined;
      if (!note) throw new NoteTemplateError("NOTE_TEMPLATE_NOTE_CREATE_FAILED", 500, "模板笔记创建失败");

      const insertAttachment = db.prepare(`
        INSERT INTO attachments (
          id, noteId, userId, filename, mimeType, size, path, workspaceId, hash, uploadSource
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'note_template')
      `);
      for (const asset of copied) {
        insertAttachment.run(
          asset.id,
          created.resourceId,
          input.userId,
          asset.filename,
          asset.mimeType,
          asset.size,
          asset.path,
          note.workspaceId,
          asset.hash,
        );
      }

      const synced = syncNoteBlocks(db, created.resourceId, content, template.contentFormat);
      db.prepare(`
        UPDATE notes
        SET content = ?, contentText = ?, contentFormat = ?, updatedAt = datetime('now')
        WHERE id = ?
      `).run(synced.content, contentText, template.contentFormat, created.resourceId);
      syncReferences(db, created.resourceId, synced.content);
      syncNoteLinks(db, input.userId, created.resourceId, synced.content);
      rebuildBlockAuthorityStore(db, created.resourceId, synced.content, template.contentFormat, {
        noteVersion: note.version,
        operationType: "create",
      });
      rebuildYjsSubdocumentsIfEnabled(db, created.resourceId, synced.content, template.contentFormat);
      return created;
    })();
  } catch (error) {
    await cleanupObjects(copied.map((item) => item.path));
    throw error;
  }

  const createdNote = db.prepare("SELECT workspaceId FROM notes WHERE id = ?")
    .get(node.resourceId) as { workspaceId: string | null } | undefined;
  for (const attachment of copied) {
    enqueueAttachment({
      attachmentId: attachment.id,
      userId: input.userId,
      workspaceId: createdNote?.workspaceId || null,
      noteId: node.resourceId,
    });
  }

  return { noteId: node.resourceId, node };
}
