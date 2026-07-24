import { v4 as uuid } from "uuid";

import type { DatabaseAdapter, DbStatement } from "../db/adapters/types";
import type { DatabaseDialect } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import { buildNoteBlockIndexPlan } from "../lib/noteBlocksRuntime";
import {
  extractAttachmentIdsFromContent,
  extractNoteLinksFromContent,
} from "../lib/noteContentReferences";
import type { Permission } from "../middleware/acl";
import { createNoteCoreRuntime, NoteCoreRuntimeError } from "./note-core-runtime";

const PERMISSION_LEVEL: Record<Permission, number> = {
  read: 1,
  comment: 2,
  write: 3,
  manage: 4,
};

const ROLE_PERMISSION: Record<string, Permission> = {
  owner: "manage",
  admin: "manage",
  manage: "manage",
  editor: "write",
  write: "write",
  commenter: "comment",
  comment: "comment",
  viewer: "read",
  read: "read",
};

interface NotebookRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  isDeleted: boolean | number;
}

interface RoleRow {
  role: string;
}

interface NoteListRow {
  id: string;
  userId: string;
  notebookId: string;
  workspaceId: string | null;
  title: string;
  contentText: string;
  isPinned: boolean | number;
  isFavorite: boolean | number;
  isLocked: boolean | number;
  isArchived: boolean | number;
  isTrashed: boolean | number;
  version: number;
  sortOrder: number;
  createdAt: string | Date;
  updatedAt: string | Date;
  contentFormat: string;
  creatorName: string | null;
}

export interface NoteCollectionListInput {
  workspaceId?: string;
  notebookId?: string;
  isFavorite?: string;
  isTrashed?: string;
  search?: string;
  tagId?: string;
  tagIds?: string;
  tagMode?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface NoteCollectionCreateInput {
  id?: unknown;
  notebookId?: unknown;
  title?: unknown;
  content?: unknown;
  contentFormat?: unknown;
  [key: string]: unknown;
}

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function resolveDialect(dialect?: DatabaseDialect): DatabaseDialect {
  if (dialect) return dialect;
  try {
    return getDatabaseDialect();
  } catch {
    return "sqlite";
  }
}

function rolePermission(role: string | null | undefined): Permission | null {
  if (!role || role === "none") return null;
  return ROLE_PERMISSION[role] ?? null;
}

function hasPermission(actual: Permission | null, required: Permission): boolean {
  return Boolean(actual && PERMISSION_LEVEL[actual] >= PERMISSION_LEVEL[required]);
}

function booleanNumber(value: boolean | number): number {
  return value === true || value === 1 ? 1 : 0;
}

function normalizeListRow(row: NoteListRow): Record<string, unknown> {
  return {
    ...row,
    isPinned: booleanNumber(row.isPinned),
    isFavorite: booleanNumber(row.isFavorite),
    isLocked: booleanNumber(row.isLocked),
    isArchived: booleanNumber(row.isArchived),
    isTrashed: booleanNumber(row.isTrashed),
  };
}

function uniqueConstraint(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = error instanceof Error ? error.message : String(error ?? "");
  return code === "23505" || /UNIQUE|constraint/i.test(message);
}

export function createNoteCollectionRuntime(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const db = resolveAdapter(adapter);
  const dbDialect = resolveDialect(dialect);
  const core = createNoteCoreRuntime(db, dbDialect);

  async function readWorkspaceOwner(workspaceId: string): Promise<string | null> {
    const workspace = await db.queryOne<{ ownerId: string }>(
      `SELECT "ownerId" AS "ownerId" FROM workspaces WHERE id = ?`,
      [workspaceId],
    );
    return workspace?.ownerId ?? null;
  }

  async function resolveNotebookPermission(
    notebookId: string,
    userId: string,
  ): Promise<{ notebook?: NotebookRow; permission: Permission | null }> {
    const notebook = await db.queryOne<NotebookRow>(`
      SELECT id, "userId", "workspaceId", "isDeleted"
      FROM notebooks WHERE id = ?
    `, [notebookId]);
    if (!notebook) return { permission: null };
    if (notebook.userId === userId) return { notebook, permission: "manage" };

    const member = await db.queryOne<RoleRow>(`
      SELECT role FROM notebook_members
      WHERE "notebookId" = ? AND "userId" = ? AND status = 'active'
      LIMIT 1
    `, [notebookId, userId]);
    if (member) return { notebook, permission: rolePermission(member.role) };

    if (!notebook.workspaceId) return { notebook, permission: null };
    if (await readWorkspaceOwner(notebook.workspaceId) === userId) {
      return { notebook, permission: "manage" };
    }
    const workspaceMember = await db.queryOne<RoleRow>(`
      SELECT role FROM workspace_members
      WHERE "workspaceId" = ? AND "userId" = ?
      LIMIT 1
    `, [notebook.workspaceId, userId]);
    return { notebook, permission: rolePermission(workspaceMember?.role) };
  }

  async function assertWorkspaceReadable(workspaceId: string, userId: string): Promise<void> {
    const ownerId = await readWorkspaceOwner(workspaceId);
    if (!ownerId) {
      throw new NoteCoreRuntimeError("工作区不存在", "WORKSPACE_NOT_FOUND", 404);
    }
    if (ownerId === userId) return;
    const member = await db.queryOne<RoleRow>(`
      SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?
    `, [workspaceId, userId]);
    if (!member) {
      throw new NoteCoreRuntimeError("无权访问该工作区", "FORBIDDEN", 403);
    }
  }

  async function listNotes(
    userId: string,
    input: NoteCollectionListInput = {},
  ): Promise<Array<Record<string, unknown>>> {
    if (input.search?.trim()) {
      throw new NoteCoreRuntimeError(
        "PostgreSQL 全文搜索尚未迁移",
        "POSTGRES_SEARCH_MIGRATION_PENDING",
        503,
        { issue: 252 },
      );
    }

    const params: unknown[] = [userId];
    const where: string[] = [];
    const tagIds = (input.tagIds || input.tagId || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const tagMode = input.tagMode === "or" ? "or" : "and";

    if (input.notebookId) {
      const resolved = await resolveNotebookPermission(input.notebookId, userId);
      if (!resolved.notebook || !hasPermission(resolved.permission, "read")) {
        throw new NoteCoreRuntimeError(
          "Notebook not found or forbidden",
          "NOT_FOUND",
          404,
        );
      }
      where.push(`n."notebookId" IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM notebooks WHERE id = ?
          UNION ALL
          SELECT child.id FROM notebooks child
          INNER JOIN descendants parent ON child."parentId" = parent.id
        )
        SELECT id FROM descendants
      )`);
      params.push(input.notebookId);
    } else if (input.workspaceId && input.workspaceId !== "personal") {
      await assertWorkspaceReadable(input.workspaceId, userId);
      where.push('n."workspaceId" = ?');
      params.push(input.workspaceId);
    } else {
      where.push('n."userId" = ? AND n."workspaceId" IS NULL');
      params.push(userId);
    }

    if (input.isTrashed === "1") {
      where.push('n."isTrashed" = true');
    } else {
      where.push('n."isTrashed" = false');
    }

    if (input.isFavorite === "1") {
      where.push(`EXISTS (
        SELECT 1 FROM favorites selected_favorite
        WHERE selected_favorite."noteId" = n.id
          AND selected_favorite."userId" = ?
      )`);
      params.push(userId);
    }

    if (tagIds.length > 0) {
      const placeholders = tagIds.map(() => "?").join(",");
      if (tagMode === "and" && tagIds.length > 1) {
        where.push(`n.id IN (
          SELECT filtered_tags."noteId" FROM note_tags filtered_tags
          WHERE filtered_tags."tagId" IN (${placeholders})
          GROUP BY filtered_tags."noteId"
          HAVING COUNT(DISTINCT filtered_tags."tagId") >= ?
        )`);
        params.push(...tagIds, tagIds.length);
      } else {
        where.push(`EXISTS (
          SELECT 1 FROM note_tags filtered_tags
          WHERE filtered_tags."noteId" = n.id
            AND filtered_tags."tagId" IN (${placeholders})
        )`);
        params.push(...tagIds);
      }
    }

    if (input.dateFrom) {
      where.push('n."updatedAt" >= ?');
      params.push(`${input.dateFrom} 00:00:00`);
    }
    if (input.dateTo) {
      where.push('n."updatedAt" <= ?');
      params.push(`${input.dateTo} 23:59:59`);
    }

    const sortBy = ["updatedAt", "createdAt", "title"].includes(input.sortBy || "")
      ? input.sortBy as "updatedAt" | "createdAt" | "title"
      : "manual";
    const direction = input.sortOrder === "asc" ? "ASC" : "DESC";
    const orderBy = sortBy === "manual"
      ? 'n."isPinned" DESC, n."sortOrder" ASC, n."updatedAt" DESC, n.id ASC'
      : sortBy === "title"
        ? `n."isPinned" DESC, lower(n.title) ${direction}, n.id ASC`
        : `n."isPinned" DESC, n."${sortBy}" ${direction}, n.id ASC`;

    const rows = await db.queryMany<NoteListRow>(`
      SELECT n.id,
             n."userId",
             n."notebookId",
             n."workspaceId",
             n.title,
             n."contentText",
             n."isPinned",
             CASE WHEN EXISTS(
               SELECT 1 FROM favorites f
               WHERE f."noteId" = n.id AND f."userId" = ?
             ) THEN 1 ELSE 0 END AS "isFavorite",
             n."isLocked",
             n."isArchived",
             n."isTrashed",
             n.version,
             n."sortOrder",
             n."createdAt",
             n."updatedAt",
             n."contentFormat",
             creator.username AS "creatorName"
      FROM notes n
      LEFT JOIN users creator ON creator.id = n."userId"
      WHERE ${where.join(" AND ")}
      ORDER BY ${orderBy}
    `, params);
    return rows.map(normalizeListRow);
  }

  async function existingTargetIds(content: string): Promise<Set<string>> {
    const ids = [...new Set(
      extractNoteLinksFromContent(content).map((link) => link.targetNoteId.toLowerCase()),
    )];
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => "?").join(",");
    const rows = await db.queryMany<{ id: string }>(
      `SELECT id FROM notes WHERE id IN (${placeholders})`,
      ids,
    );
    return new Set(rows.map((row) => row.id.toLowerCase()));
  }

  async function existingAttachmentIds(content: string): Promise<Set<string>> {
    const ids = [...extractAttachmentIdsFromContent(content)];
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => "?").join(",");
    const rows = await db.queryMany<{ id: string }>(
      `SELECT id FROM attachments WHERE id IN (${placeholders})`,
      ids,
    );
    return new Set(rows.map((row) => row.id.toLowerCase()));
  }

  async function createNote(
    userId: string,
    input: NoteCollectionCreateInput,
  ): Promise<Record<string, unknown>> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new NoteCoreRuntimeError("请求格式错误", "INVALID_BODY", 400);
    }
    if (typeof input.notebookId !== "string" || !input.notebookId) {
      throw new NoteCoreRuntimeError("notebookId is required", "NOTEBOOK_REQUIRED", 400);
    }

    const resolved = await resolveNotebookPermission(input.notebookId, userId);
    if (!resolved.notebook) {
      throw new NoteCoreRuntimeError("笔记本不存在", "NOTEBOOK_NOT_FOUND", 404);
    }
    if (booleanNumber(resolved.notebook.isDeleted) === 1) {
      throw new NoteCoreRuntimeError(
        "笔记本已删除，无法在其下创建笔记",
        "NOTEBOOK_TRASHED",
        400,
      );
    }
    if (!hasPermission(resolved.permission, "write")) {
      throw new NoteCoreRuntimeError("您在该笔记本无创建权限", "FORBIDDEN", 403);
    }

    const clientId = typeof input.id === "string" ? input.id : "";
    const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
      ? clientId
      : uuid();
    const contentFormat = input.contentFormat === "markdown"
      ? "markdown"
      : input.contentFormat === "html"
        ? "html"
        : "tiptap-json";
    const defaultContent = contentFormat === "markdown"
      ? "# 无标题 Markdown\n\n"
      : contentFormat === "html"
        ? "<p></p>"
        : JSON.stringify({ type: "doc", content: [] });
    const submittedContent = typeof input.content === "string" ? input.content : defaultContent;
    const plan = buildNoteBlockIndexPlan(id, submittedContent, contentFormat, []);
    if (!plan) {
      throw new NoteCoreRuntimeError(
        contentFormat === "tiptap-json" ? "Tiptap JSON 内容无效" : "内容格式无效",
        contentFormat === "tiptap-json" ? "INVALID_TIPTAP_CONTENT" : "INVALID_CONTENT",
        400,
        { contentFormat },
      );
    }

    const statements: DbStatement[] = [{
      sql: `INSERT INTO notes (
              id, "userId", "workspaceId", "notebookId", title,
              content, "contentText", "contentFormat"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        userId,
        resolved.notebook.workspaceId,
        input.notebookId,
        typeof input.title === "string" && input.title ? input.title : "无标题笔记",
        plan.content,
        plan.contentText,
        contentFormat,
      ],
    }];

    for (const block of plan.rows) {
      statements.push({
        sql: `INSERT INTO note_blocks_index (
                "noteId", "blockId", "blockType", "parentBlockId", "blockOrder",
                "plainText", "contentHash", path, "startOffset", "endOffset",
                "createdAt", "updatedAt"
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        params: [
          block.noteId,
          block.blockId,
          block.blockType,
          block.parentBlockId,
          block.blockOrder,
          block.plainText,
          block.contentHash,
          block.path,
          block.startOffset,
          block.endOffset,
        ],
      });
    }

    const validTargets = await existingTargetIds(plan.content);
    const insertPrefix = dbDialect === "postgres" ? "INSERT INTO" : "INSERT OR IGNORE INTO";
    const conflictSuffix = dbDialect === "postgres" ? " ON CONFLICT DO NOTHING" : "";
    for (const link of extractNoteLinksFromContent(plan.content)) {
      if (!validTargets.has(link.targetNoteId.toLowerCase())) continue;
      statements.push({
        sql: `${insertPrefix} note_links (
                id, "userId", "sourceNoteId", "targetNoteId", "targetBlockId",
                "sourceBlockId", "linkType", "linkText", excerpt,
                "createdAt", "updatedAt"
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)${conflictSuffix}`,
        params: [
          uuid(),
          userId,
          id,
          link.targetNoteId,
          link.targetBlockId,
          link.sourceBlockId,
          link.linkType,
          link.linkText,
          link.excerpt,
        ],
      });
    }

    const validAttachments = await existingAttachmentIds(plan.content);
    for (const attachmentId of validAttachments) {
      statements.push({
        sql: `${insertPrefix} attachment_references (
                "attachmentId", "noteId", "createdAt"
              ) VALUES (?, ?, CURRENT_TIMESTAMP)${conflictSuffix}`,
        params: [attachmentId, id],
      });
    }

    try {
      await db.executeStatements(statements);
    } catch (error) {
      if (uniqueConstraint(error)) {
        throw new NoteCoreRuntimeError("笔记 ID 已存在", "NOTE_ID_CONFLICT", 409);
      }
      throw error;
    }

    return core.getNote(userId, id);
  }

  return {
    listNotes,
    createNote,
    resolveNotebookPermissionAsync: resolveNotebookPermission,
  };
}
