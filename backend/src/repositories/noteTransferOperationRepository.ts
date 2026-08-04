import { createHash, randomUUID } from "node:crypto";

import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbStatement,
} from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";

export type NoteTransferOperationMode = "copy" | "move";
export type NoteTransferOperationStatus =
  | "prepared"
  | "staging"
  | "committing"
  | "completed"
  | "failed"
  | "cancelled";

export type NoteTransferOperationItem = {
  sourceNoteId: string;
  targetNoteId: string;
  sourceVersion: number;
  itemOrder: number;
  status: "planned" | "staged" | "committed" | "failed" | "cancelled";
};

export type PreparedNoteTransferOperation = {
  id: string;
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  mode: NoteTransferOperationMode;
  sourceWorkspaceId: string | null;
  targetWorkspaceId: string | null;
  targetNotebookId: string;
  status: NoteTransferOperationStatus;
  includeAttachments: boolean;
  includeTags: boolean;
  sourceNoteCount: number;
  sourceVersions: Record<string, number>;
  plan: {
    sourceNoteIds: string[];
    targetNoteIds: Record<string, string>;
    attachmentCount: number;
    attachmentBytes: number;
    tagCount: number;
    internalNoteLinkCount: number;
    externalNoteLinkCount: number;
  };
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  items: NoteTransferOperationItem[];
  reused: boolean;
};

type OperationRow = {
  id: string;
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  mode: NoteTransferOperationMode;
  sourceWorkspaceId: string | null;
  targetWorkspaceId: string | null;
  targetNotebookId: string;
  status: NoteTransferOperationStatus;
  includeAttachments: boolean | number | string;
  includeTags: boolean | number | string;
  sourceNoteCount: number | string;
  sourceVersions: Record<string, number> | string;
  plan: PreparedNoteTransferOperation["plan"] | string;
  createdAt: string | Date;
  updatedAt: string | Date;
  expiresAt: string | Date;
};

type ItemRow = {
  sourceNoteId: string;
  targetNoteId: string;
  sourceVersion: number | string;
  itemOrder: number | string;
  status: NoteTransferOperationItem["status"];
};

export class NoteTransferOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NoteTransferOperationError";
  }
}

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function toBoolean(value: boolean | number | string): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

function toNumber(value: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 128) {
    throw new NoteTransferOperationError(
      "NOTE_TRANSFER_IDEMPOTENCY_KEY_INVALID",
      "幂等键长度需为 8～128 个字符",
    );
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new NoteTransferOperationError(
      "NOTE_TRANSFER_IDEMPOTENCY_KEY_INVALID",
      "幂等键仅支持字母、数字、点、下划线、冒号和连字符",
    );
  }
  return normalized;
}

function isExpiredPrepared(operation: PreparedNoteTransferOperation): boolean {
  return operation.status === "prepared"
    && new Date(operation.expiresAt).getTime() <= Date.now();
}

function assertNotExpired(operation: PreparedNoteTransferOperation): void {
  if (!isExpiredPrepared(operation)) return;
  throw new NoteTransferOperationError(
    "NOTE_TRANSFER_PLAN_EXPIRED",
    "转移计划已过期，请使用新的幂等键重新预检",
    410,
    { operationId: operation.id },
  );
}

function validateSourceSnapshot(
  sourceNoteIds: string[],
  sourceVersions: Record<string, number>,
): void {
  if (sourceNoteIds.length === 0) {
    throw new NoteTransferOperationError("SOURCE_NOTES_REQUIRED", "请至少选择一篇笔记");
  }
  if (sourceNoteIds.length > 100) {
    throw new NoteTransferOperationError(
      "TRANSFER_BATCH_TOO_LARGE",
      "单次最多转移 100 篇笔记",
    );
  }
  if (new Set(sourceNoteIds).size !== sourceNoteIds.length) {
    throw new NoteTransferOperationError(
      "NOTE_TRANSFER_SOURCE_DUPLICATE",
      "转移计划中的源笔记不能重复",
    );
  }
  for (const sourceNoteId of sourceNoteIds) {
    const version = sourceVersions[sourceNoteId];
    if (!Number.isInteger(version) || version < 0) {
      throw new NoteTransferOperationError(
        "NOTE_TRANSFER_SOURCE_VERSION_REQUIRED",
        "每篇源笔记都必须包含有效的版本快照",
        400,
        { sourceNoteId },
      );
    }
  }
}

/**
 * Revalidates the exact permission precedence used by resolveNotePermission:
 * resource owner -> notebook membership override -> note ACL -> workspace role.
 */
function sourceGuard(input: {
  actorUserId: string;
  sourceWorkspaceId: string | null;
  sourceNoteId: string;
  sourceVersion: number;
}): DbStatement {
  return {
    sql: `SELECT note.id
            FROM notes note
            LEFT JOIN workspaces workspace
              ON workspace.id = note.workspaceId
            LEFT JOIN workspace_members workspace_member
              ON workspace_member.workspaceId = note.workspaceId
             AND workspace_member.userId = ?
            LEFT JOIN notebook_members notebook_member
              ON notebook_member.notebookId = note.notebookId
             AND notebook_member.userId = ?
             AND notebook_member.status = 'active'
            LEFT JOIN note_acl note_permission
              ON note_permission.noteId = note.id
             AND note_permission.userId = ?
           WHERE note.id = ?
             AND note.version = ?
             AND note.isTrashed = false
             AND COALESCE(note.workspaceId, '') = COALESCE(?, '')
             AND (
               note.userId = ?
               OR CASE
                 WHEN notebook_member.role IS NOT NULL THEN
                   notebook_member.role IN ('owner', 'admin', 'manage')
                 WHEN note.workspaceId IS NULL THEN false
                 WHEN note_permission.permission IS NOT NULL THEN
                   note_permission.permission = 'manage'
                 WHEN workspace.ownerId = ? THEN true
                 ELSE workspace_member.role IN ('owner', 'admin')
               END
             )`,
    params: [
      input.actorUserId,
      input.actorUserId,
      input.actorUserId,
      input.sourceNoteId,
      input.sourceVersion,
      input.sourceWorkspaceId,
      input.actorUserId,
      input.actorUserId,
    ],
    requireChanges: 1,
  };
}

/**
 * Revalidates resolveNotebookPermission precedence and requires write or manage.
 */
function targetGuard(input: {
  actorUserId: string;
  targetNotebookId: string;
  targetWorkspaceId: string | null;
}): DbStatement {
  return {
    sql: `SELECT notebook.id
            FROM notebooks notebook
            LEFT JOIN workspaces workspace
              ON workspace.id = notebook.workspaceId
            LEFT JOIN workspace_members workspace_member
              ON workspace_member.workspaceId = notebook.workspaceId
             AND workspace_member.userId = ?
            LEFT JOIN notebook_members notebook_member
              ON notebook_member.notebookId = notebook.id
             AND notebook_member.userId = ?
             AND notebook_member.status = 'active'
           WHERE notebook.id = ?
             AND notebook.isDeleted = false
             AND COALESCE(notebook.workspaceId, '') = COALESCE(?, '')
             AND (
               notebook.userId = ?
               OR CASE
                 WHEN notebook_member.role IS NOT NULL THEN
                   notebook_member.role IN ('owner', 'admin', 'manage', 'editor', 'write')
                 WHEN notebook.workspaceId IS NULL THEN false
                 WHEN workspace.ownerId = ? THEN true
                 ELSE workspace_member.role IN ('owner', 'admin', 'editor')
               END
             )`,
    params: [
      input.actorUserId,
      input.actorUserId,
      input.targetNotebookId,
      input.targetWorkspaceId,
      input.actorUserId,
      input.actorUserId,
    ],
    requireChanges: 1,
  };
}

function mapTransactionError(error: unknown): never {
  if (error instanceof DbStatementChangeError) {
    throw new NoteTransferOperationError(
      "NOTE_TRANSFER_PLAN_STALE",
      "源笔记版本、空间或权限已变化，请重新预检",
      409,
    );
  }
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  if (code === "23505") {
    throw new NoteTransferOperationError(
      "NOTE_TRANSFER_IDEMPOTENCY_CONFLICT",
      "该幂等键已被其他请求占用",
      409,
    );
  }
  throw error;
}

export function createNoteTransferOperationRepository(adapter?: DatabaseAdapter) {
  const db = resolveAdapter(adapter);

  async function loadOperation(
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<PreparedNoteTransferOperation | null> {
    const row = await db.queryOne<OperationRow>(
      `SELECT id, userId, idempotencyKey, requestHash, mode,
              sourceWorkspaceId, targetWorkspaceId, targetNotebookId, status,
              includeAttachments, includeTags, sourceNoteCount,
              sourceVersions, plan, createdAt, updatedAt, expiresAt
         FROM note_transfer_operations
        WHERE userId = ? AND idempotencyKey = ?`,
      [actorUserId, idempotencyKey],
    );
    if (!row) return null;
    const items = await db.queryMany<ItemRow>(
      `SELECT sourceNoteId, targetNoteId, sourceVersion, itemOrder, status
         FROM note_transfer_operation_items
        WHERE operationId = ?
        ORDER BY itemOrder, sourceNoteId`,
      [row.id],
    );
    return {
      id: row.id,
      userId: row.userId,
      idempotencyKey: row.idempotencyKey,
      requestHash: row.requestHash,
      mode: row.mode,
      sourceWorkspaceId: row.sourceWorkspaceId,
      targetWorkspaceId: row.targetWorkspaceId,
      targetNotebookId: row.targetNotebookId,
      status: row.status,
      includeAttachments: toBoolean(row.includeAttachments),
      includeTags: toBoolean(row.includeTags),
      sourceNoteCount: toNumber(row.sourceNoteCount),
      sourceVersions: parseJson(row.sourceVersions, {}),
      plan: parseJson(row.plan, {
        sourceNoteIds: [],
        targetNoteIds: {},
        attachmentCount: 0,
        attachmentBytes: 0,
        tagCount: 0,
        internalNoteLinkCount: 0,
        externalNoteLinkCount: 0,
      }),
      createdAt: toTimestamp(row.createdAt),
      updatedAt: toTimestamp(row.updatedAt),
      expiresAt: toTimestamp(row.expiresAt),
      items: items.map((item) => ({
        sourceNoteId: item.sourceNoteId,
        targetNoteId: item.targetNoteId,
        sourceVersion: toNumber(item.sourceVersion),
        itemOrder: toNumber(item.itemOrder),
        status: item.status,
      })),
      reused: false,
    };
  }

  return {
    async getPrepared(input: {
      actorUserId: string;
      idempotencyKey: string;
    }): Promise<PreparedNoteTransferOperation | null> {
      const key = normalizeIdempotencyKey(input.idempotencyKey);
      const operation = await loadOperation(input.actorUserId, key);
      if (operation) assertNotExpired(operation);
      return operation;
    },

    async prepareOperation(input: {
      actorUserId: string;
      idempotencyKey: string;
      mode: NoteTransferOperationMode;
      sourceWorkspaceId: string | null;
      targetWorkspaceId: string | null;
      targetNotebookId: string;
      includeAttachments: boolean;
      includeTags: boolean;
      sourceNoteIds: string[];
      sourceVersions: Record<string, number>;
      attachmentCount: number;
      attachmentBytes: number;
      tagCount: number;
      internalNoteLinkCount: number;
      externalNoteLinkCount: number;
    }): Promise<PreparedNoteTransferOperation> {
      const key = normalizeIdempotencyKey(input.idempotencyKey);
      validateSourceSnapshot(input.sourceNoteIds, input.sourceVersions);
      if (input.mode !== "copy" && input.mode !== "move") {
        throw new NoteTransferOperationError("INVALID_TRANSFER_MODE", "mode 必须是 copy 或 move");
      }

      const canonicalRequest = {
        mode: input.mode,
        sourceWorkspaceId: input.sourceWorkspaceId,
        targetWorkspaceId: input.targetWorkspaceId,
        targetNotebookId: input.targetNotebookId,
        includeAttachments: input.includeAttachments,
        includeTags: input.includeTags,
        sourceNoteIds: input.sourceNoteIds,
        sourceVersions: input.sourceVersions,
      };
      const hash = requestHash(canonicalRequest);
      const existing = await loadOperation(input.actorUserId, key);
      if (existing) {
        assertNotExpired(existing);
        if (existing.requestHash !== hash) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_IDEMPOTENCY_CONFLICT",
            "该幂等键已用于不同的转移请求",
            409,
            { operationId: existing.id },
          );
        }
        return { ...existing, reused: true };
      }

      const operationId = randomUUID();
      const targetNoteIds = Object.fromEntries(
        input.sourceNoteIds.map((sourceNoteId) => [sourceNoteId, randomUUID()]),
      );
      const plan: PreparedNoteTransferOperation["plan"] = {
        sourceNoteIds: input.sourceNoteIds,
        targetNoteIds,
        attachmentCount: Math.max(0, input.attachmentCount),
        attachmentBytes: Math.max(0, input.attachmentBytes),
        tagCount: Math.max(0, input.tagCount),
        internalNoteLinkCount: Math.max(0, input.internalNoteLinkCount),
        externalNoteLinkCount: Math.max(0, input.externalNoteLinkCount),
      };

      const statements: DbStatement[] = [
        targetGuard({
          actorUserId: input.actorUserId,
          targetNotebookId: input.targetNotebookId,
          targetWorkspaceId: input.targetWorkspaceId,
        }),
        ...input.sourceNoteIds.map((sourceNoteId) => sourceGuard({
          actorUserId: input.actorUserId,
          sourceWorkspaceId: input.sourceWorkspaceId,
          sourceNoteId,
          sourceVersion: input.sourceVersions[sourceNoteId],
        })),
        {
          sql: `INSERT INTO note_transfer_operations (
                  id, userId, idempotencyKey, requestHash, mode,
                  sourceWorkspaceId, targetWorkspaceId, targetNotebookId, status,
                  includeAttachments, includeTags, sourceNoteCount,
                  sourceVersions, plan
                ) VALUES (
                  ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?,
                  CAST(? AS JSONB), CAST(? AS JSONB)
                )`,
          params: [
            operationId,
            input.actorUserId,
            key,
            hash,
            input.mode,
            input.sourceWorkspaceId,
            input.targetWorkspaceId,
            input.targetNotebookId,
            input.includeAttachments,
            input.includeTags,
            input.sourceNoteIds.length,
            JSON.stringify(input.sourceVersions),
            JSON.stringify(plan),
          ],
          requireChanges: 1,
        },
        ...input.sourceNoteIds.map((sourceNoteId, itemOrder): DbStatement => ({
          sql: `INSERT INTO note_transfer_operation_items (
                  operationId, sourceNoteId, targetNoteId,
                  sourceVersion, itemOrder, status
                ) VALUES (?, ?, ?, ?, ?, 'planned')`,
          params: [
            operationId,
            sourceNoteId,
            targetNoteIds[sourceNoteId],
            input.sourceVersions[sourceNoteId],
            itemOrder,
          ],
          requireChanges: 1,
        })),
      ];

      try {
        await db.executeStatements(statements);
      } catch (error) {
        const raced = await loadOperation(input.actorUserId, key).catch(() => null);
        if (raced?.requestHash === hash) {
          assertNotExpired(raced);
          return { ...raced, reused: true };
        }
        mapTransactionError(error);
      }

      const prepared = await loadOperation(input.actorUserId, key);
      if (!prepared) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_PLAN_PERSIST_FAILED",
          "转移计划保存失败",
          409,
        );
      }
      return prepared;
    },
  };
}
