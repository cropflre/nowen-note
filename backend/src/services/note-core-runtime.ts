import { v4 as uuid } from "uuid";

import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbStatement,
} from "../db/adapters/types";
import type { DatabaseDialect } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";
import { extractAttachmentIdsFromContent } from "../lib/attachmentRefs";
import { buildTiptapBlockIndexPlan } from "../lib/noteBlocksRuntime";
import { extractNoteLinksFromContent } from "../lib/noteLinks";
import type { Permission } from "../middleware/acl";
import { createNoteTagsRepository } from "../repositories/noteTagsRepository";
import type { NoteLinkEntry } from "../repositories/types";
import { createNoteLinkTitlesRuntime } from "./note-link-titles-runtime";

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

export class NoteCoreRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 503,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NoteCoreRuntimeError";
  }
}

interface NoteScopeRow {
  userId: string;
  notebookId: string;
  workspaceId: string | null;
}

interface RoleRow {
  role: string;
}

interface PermissionRow {
  permission: string;
}

interface NoteRow extends NoteScopeRow {
  id: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  isPinned: boolean | number;
  isFavorite: boolean | number;
  isLocked: boolean | number;
  isArchived: boolean | number;
  isTrashed: boolean | number;
  version: number;
  sortOrder: number;
  createdAt: string | Date;
  updatedAt: string | Date;
  trashedAt: string | Date | null;
}

export interface NoteCoreSaveInput {
  version?: unknown;
  title?: unknown;
  content?: unknown;
  contentText?: unknown;
  contentFormat?: unknown;
  [key: string]: unknown;
}

export interface NoteCoreRuntimeResult {
  note: Record<string, unknown>;
  warnings: string[];
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

function hasPermission(actual: Permission | null, required: Permission): boolean {
  return Boolean(actual && PERMISSION_LEVEL[actual] >= PERMISSION_LEVEL[required]);
}

function rolePermission(role: string | null | undefined): Permission | null {
  if (!role || role === "none") return null;
  return ROLE_PERMISSION[role] ?? null;
}

function booleanNumber(value: boolean | number | null | undefined): number {
  return value === true || value === 1 ? 1 : 0;
}

function normalizeNote(row: NoteRow, slim: boolean): Record<string, unknown> {
  const note: Record<string, unknown> = {
    ...row,
    isPinned: booleanNumber(row.isPinned),
    isFavorite: booleanNumber(row.isFavorite),
    isLocked: booleanNumber(row.isLocked),
    isArchived: booleanNumber(row.isArchived),
    isTrashed: booleanNumber(row.isTrashed),
  };
  if (slim) {
    delete note.content;
    delete note.contentText;
  }
  return note;
}

async function filterExistingTargets(
  adapter: DatabaseAdapter,
  sourceNoteId: string,
  links: NoteLinkEntry[],
): Promise<NoteLinkEntry[]> {
  const candidates = links.filter(
    (link) => !(link.targetNoteId === sourceNoteId.toLowerCase() && !link.targetBlockId),
  );
  const ids = [...new Set(candidates.map((link) => link.targetNoteId.toLowerCase()))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const existingRows = await adapter.queryMany<{ id: string }>(
    `SELECT id FROM notes WHERE id IN (${placeholders})`,
    ids,
  );
  const existing = new Set(existingRows.map((row) => String(row.id).toLowerCase()));
  return candidates.filter((link) => existing.has(link.targetNoteId.toLowerCase()));
}

async function filterExistingAttachments(
  adapter: DatabaseAdapter,
  content: string,
): Promise<string[]> {
  const ids = [...extractAttachmentIdsFromContent(content)];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await adapter.queryMany<{ id: string }>(
    `SELECT id FROM attachments WHERE id IN (${placeholders})`,
    ids,
  );
  return rows.map((row) => String(row.id).toLowerCase());
}

export function createNoteCoreRuntime(
  adapter?: DatabaseAdapter,
  dialect?: DatabaseDialect,
) {
  const db = resolveAdapter(adapter);
  const dbDialect = resolveDialect(dialect);
  const tagsRepository = createNoteTagsRepository(db);
  const titleRuntime = createNoteLinkTitlesRuntime(db, dbDialect);

  async function resolvePermission(
    noteId: string,
    userId: string,
  ): Promise<{ permission: Permission | null; scope?: NoteScopeRow }> {
    const scope = await db.queryOne<NoteScopeRow>(
      `SELECT "userId" AS "userId", "notebookId" AS "notebookId", "workspaceId" AS "workspaceId"
         FROM notes WHERE id = ?`,
      [noteId],
    );
    if (!scope) return { permission: null };
    if (scope.userId === userId) return { permission: "manage", scope };

    const notebookMember = await db.queryOne<RoleRow>(
      `SELECT role FROM notebook_members
        WHERE "notebookId" = ? AND "userId" = ? AND status = 'active'
        LIMIT 1`,
      [scope.notebookId, userId],
    );
    if (notebookMember) {
      return { permission: rolePermission(notebookMember.role), scope };
    }

    if (!scope.workspaceId) return { permission: null, scope };

    const acl = await db.queryOne<PermissionRow>(
      `SELECT permission FROM note_acl WHERE "noteId" = ? AND "userId" = ?`,
      [noteId, userId],
    );
    if (acl) {
      const permission = acl.permission in PERMISSION_LEVEL
        ? acl.permission as Permission
        : null;
      return { permission, scope };
    }

    const workspaceMember = await db.queryOne<RoleRow>(
      `SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?`,
      [scope.workspaceId, userId],
    );
    return { permission: rolePermission(workspaceMember?.role), scope };
  }

  async function readNoteRow(userId: string, noteId: string): Promise<NoteRow | undefined> {
    return db.queryOne<NoteRow>(
      `SELECT n.id,
              n."userId" AS "userId",
              n."notebookId" AS "notebookId",
              n."workspaceId" AS "workspaceId",
              n.title,
              n.content,
              n."contentText" AS "contentText",
              n."contentFormat" AS "contentFormat",
              n."isPinned" AS "isPinned",
              CASE WHEN EXISTS(
                SELECT 1 FROM favorites f WHERE f."noteId" = n.id AND f."userId" = ?
              ) THEN 1 ELSE 0 END AS "isFavorite",
              n."isLocked" AS "isLocked",
              n."isArchived" AS "isArchived",
              n."isTrashed" AS "isTrashed",
              n.version,
              n."sortOrder" AS "sortOrder",
              n."createdAt" AS "createdAt",
              n."updatedAt" AS "updatedAt",
              n."trashedAt" AS "trashedAt"
         FROM notes n
        WHERE n.id = ?`,
      [userId, noteId],
    );
  }

  async function getNote(
    userId: string,
    noteId: string,
    options: { slim?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const resolved = await resolvePermission(noteId, userId);
    if (!hasPermission(resolved.permission, "read")) {
      throw new NoteCoreRuntimeError("Note not found or forbidden", "NOT_FOUND", 404);
    }
    const row = await readNoteRow(userId, noteId);
    if (!row) throw new NoteCoreRuntimeError("Note not found", "NOT_FOUND", 404);
    const tags = await tagsRepository.listTagsByNoteIdAsync(noteId);
    return {
      ...normalizeNote(row, Boolean(options.slim)),
      tags,
      permission: resolved.permission,
    };
  }

  async function saveNote(
    userId: string,
    noteId: string,
    input: NoteCoreSaveInput,
  ): Promise<NoteCoreRuntimeResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new NoteCoreRuntimeError("请求格式错误", "INVALID_BODY", 400);
    }

    const unsupported = Object.keys(input).filter(
      (key) => !["version", "title", "content", "contentText", "contentFormat"].includes(key),
    );
    if (unsupported.length > 0) {
      throw new NoteCoreRuntimeError(
        `PostgreSQL Runtime 尚未迁移字段：${unsupported.join(", ")}`,
        "POSTGRES_NOTE_FIELD_MIGRATION_PENDING",
        503,
        { fields: unsupported },
      );
    }

    const requestedChange = ["title", "content", "contentText", "contentFormat"]
      .some((field) => input[field] !== undefined);
    if (!requestedChange) {
      return { note: await getNote(userId, noteId), warnings: [] };
    }
    if (!Number.isInteger(input.version) || Number(input.version) < 0) {
      throw new NoteCoreRuntimeError(
        "缺少 version 字段，无法安全保存",
        "VERSION_REQUIRED",
        400,
      );
    }

    const resolved = await resolvePermission(noteId, userId);
    if (!hasPermission(resolved.permission, "write")) {
      throw new NoteCoreRuntimeError("权限不足", "FORBIDDEN", 403);
    }

    const current = await readNoteRow(userId, noteId);
    if (!current) throw new NoteCoreRuntimeError("Note not found", "NOT_FOUND", 404);
    if (current.version !== input.version) {
      throw new NoteCoreRuntimeError(
        "Version conflict",
        "VERSION_CONFLICT",
        409,
        { currentVersion: current.version },
      );
    }
    if (booleanNumber(current.isLocked) === 1) {
      throw new NoteCoreRuntimeError("Note is locked", "NOTE_LOCKED", 403);
    }

    const nextTitle = input.title === undefined ? current.title : String(input.title);
    const nextFormat = input.contentFormat === undefined
      ? current.contentFormat
      : String(input.contentFormat);
    const submittedContent = input.content === undefined
      ? current.content
      : String(input.content);

    if (nextFormat !== "tiptap-json") {
      throw new NoteCoreRuntimeError(
        "PostgreSQL Runtime 当前仅迁移 Tiptap JSON 内容保存；Markdown/HTML 将在下一切片完成",
        "POSTGRES_NOTE_FORMAT_MIGRATION_PENDING",
        503,
        { contentFormat: nextFormat },
      );
    }

    const blockPlan = buildTiptapBlockIndexPlan(noteId, submittedContent);
    if (!blockPlan) {
      throw new NoteCoreRuntimeError("Tiptap JSON 内容无效", "INVALID_TIPTAP_CONTENT", 400);
    }

    const nextContent = blockPlan.content;
    const nextContentText = blockPlan.contentText;
    const contentChanged = nextContent !== current.content
      || nextContentText !== current.contentText
      || nextFormat !== current.contentFormat;
    const titleChanged = nextTitle !== current.title;
    if (!contentChanged && !titleChanged) {
      return { note: await getNote(userId, noteId), warnings: [] };
    }

    const statements: DbStatement[] = [
      {
        sql: `UPDATE notes
                 SET title = ?,
                     content = ?,
                     "contentText" = ?,
                     "contentFormat" = ?,
                     version = version + 1,
                     "updatedAt" = CURRENT_TIMESTAMP
               WHERE id = ? AND version = ?`,
        params: [
          nextTitle,
          nextContent,
          nextContentText,
          nextFormat,
          noteId,
          current.version,
        ],
        requireChanges: 1,
      },
      {
        sql: `INSERT INTO note_versions (
                id, "noteId", "userId", title, content, "contentText",
                "contentFormat", version, "changeType", "changeSummary", "createdAt"
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'edit', ?, CURRENT_TIMESTAMP)`,
        params: [
          uuid(),
          noteId,
          userId,
          current.title,
          current.content,
          current.contentText,
          current.contentFormat,
          current.version,
          titleChanged && contentChanged
            ? "更新标题和正文"
            : titleChanged
              ? "更新标题"
              : "更新正文",
        ],
      },
    ];

    if (contentChanged) {
      const links = await filterExistingTargets(
        db,
        noteId,
        extractNoteLinksFromContent(nextContent),
      );
      const attachmentIds = await filterExistingAttachments(db, nextContent);

      statements.push({
        sql: `DELETE FROM note_blocks_index WHERE "noteId" = ?`,
        params: [noteId],
      });
      for (const block of blockPlan.rows) {
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

      statements.push({
        sql: `DELETE FROM note_links WHERE "sourceNoteId" = ?`,
        params: [noteId],
      });
      const insertPrefix = dbDialect === "postgres" ? "INSERT INTO" : "INSERT OR IGNORE INTO";
      const conflictSuffix = dbDialect === "postgres" ? " ON CONFLICT DO NOTHING" : "";
      for (const link of links) {
        statements.push({
          sql: `${insertPrefix} note_links (
                  id, "userId", "sourceNoteId", "targetNoteId", "targetBlockId",
                  "sourceBlockId", "linkType", "linkText", excerpt,
                  "createdAt", "updatedAt"
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)${conflictSuffix}`,
          params: [
            uuid(),
            current.userId,
            noteId,
            link.targetNoteId,
            link.targetBlockId,
            link.sourceBlockId,
            link.linkType,
            link.linkText,
            link.excerpt,
          ],
        });
      }

      statements.push({
        sql: `DELETE FROM attachment_references WHERE "noteId" = ?`,
        params: [noteId],
      });
      for (const attachmentId of attachmentIds) {
        statements.push({
          sql: `${insertPrefix} attachment_references (
                  "attachmentId", "noteId", "createdAt"
                ) VALUES (?, ?, CURRENT_TIMESTAMP)${conflictSuffix}`,
          params: [attachmentId, noteId],
        });
      }
    }

    try {
      await db.executeStatements(statements);
    } catch (error) {
      if (error instanceof DbStatementChangeError) {
        const latest = await db.queryOne<{ version: number }>(
          `SELECT version FROM notes WHERE id = ?`,
          [noteId],
        );
        throw new NoteCoreRuntimeError(
          "Version conflict",
          "VERSION_CONFLICT",
          409,
          { currentVersion: latest?.version ?? current.version },
        );
      }
      throw error;
    }

    const warnings: string[] = [];
    if (titleChanged) {
      try {
        await titleRuntime.syncAutomaticNoteLinkTitlesAsync(
          noteId,
          current.title,
          nextTitle,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[note-core-runtime] automatic title propagation failed:", message);
        warnings.push(`automatic title propagation failed: ${message}`);
      }
    }

    return {
      note: await getNote(userId, noteId),
      warnings,
    };
  }

  return {
    resolveNotePermissionAsync: resolvePermission,
    getNote,
    saveNote,
  };
}
