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

export type NoteTransferStagedAttachment = {
  sourceAttachmentId: string;
  sourceNoteId: string;
  targetAttachmentId: string;
  targetNoteId: string;
  sourcePath: string;
  stagedPath: string;
  filename: string;
  mimeType: string;
  size: number;
  hash: string | null;
  status: "planned" | "copying" | "staged" | "committed" | "failed" | "cleaned";
  attempts: number;
  lastError: string | null;
  verifiedSize: number | null;
  verifiedHash: string | null;
  stagedAt: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NoteTransferStagingClaim = {
  operationId: string;
  sourceAttachmentId: string;
  sourceNoteId: string;
  targetAttachmentId: string;
  targetNoteId: string;
  sourcePath: string;
  stagedPath: string;
  filename: string;
  mimeType: string;
  size: number;
  hash: string | null;
  attempts: number;
  leaseToken: string;
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
  stagedAttachments: NoteTransferStagedAttachment[];
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

type StagedAttachmentRow = Omit<
  NoteTransferStagedAttachment,
  "size" | "attempts" | "verifiedSize" | "stagedAt" | "leaseExpiresAt" | "createdAt" | "updatedAt"
> & {
  size: number | string;
  attempts: number | string;
  verifiedSize: number | string | null;
  stagedAt: string | Date | null;
  leaseExpiresAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
};

type StagingClaimRow = Omit<NoteTransferStagingClaim, "size" | "attempts" | "leaseToken"> & {
  size: number | string;
  attempts: number | string;
};

type SourceAttachmentRow = {
  id: string;
  noteId: string;
  path: string;
  filename: string;
  mimeType: string | null;
  size: number | string;
  hash: string | null;
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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
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
    const stagedAttachments = await db.queryMany<StagedAttachmentRow>(
      `SELECT sourceAttachmentId, sourceNoteId, targetAttachmentId, targetNoteId,
              sourcePath, stagedPath, filename, mimeType, size, hash,
              status, attempts, lastError, verifiedSize, verifiedHash,
              stagedAt, leaseExpiresAt, createdAt, updatedAt
         FROM note_transfer_staged_attachments
        WHERE operationId = ?
        ORDER BY sourceNoteId, sourceAttachmentId`,
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
      stagedAttachments: stagedAttachments.map((attachment) => ({
        sourceAttachmentId: attachment.sourceAttachmentId,
        sourceNoteId: attachment.sourceNoteId,
        targetAttachmentId: attachment.targetAttachmentId,
        targetNoteId: attachment.targetNoteId,
        sourcePath: attachment.sourcePath,
        stagedPath: attachment.stagedPath,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: toNumber(attachment.size),
        hash: attachment.hash,
        status: attachment.status,
        attempts: toNumber(attachment.attempts),
        lastError: attachment.lastError,
        verifiedSize: attachment.verifiedSize == null ? null : toNumber(attachment.verifiedSize),
        verifiedHash: attachment.verifiedHash,
        stagedAt: attachment.stagedAt == null ? null : toTimestamp(attachment.stagedAt),
        leaseExpiresAt: attachment.leaseExpiresAt == null
          ? null
          : toTimestamp(attachment.leaseExpiresAt),
        createdAt: toTimestamp(attachment.createdAt),
        updatedAt: toTimestamp(attachment.updatedAt),
      })),
      reused: false,
    };
  }


  async function loadSourceAttachments(
    operation: PreparedNoteTransferOperation,
  ): Promise<SourceAttachmentRow[]> {
    if (!operation.includeAttachments || operation.plan.sourceNoteIds.length === 0) return [];
    return db.queryMany<SourceAttachmentRow>(
      `SELECT id, noteId, path, filename, mimeType, size, hash
         FROM attachments
        WHERE noteId IN (${placeholders(operation.plan.sourceNoteIds.length)})
        ORDER BY createdAt, id`,
      operation.plan.sourceNoteIds,
    );
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

    async beginStaging(input: {
      actorUserId: string;
      idempotencyKey: string;
    }): Promise<PreparedNoteTransferOperation> {
      const key = normalizeIdempotencyKey(input.idempotencyKey);
      const operation = await loadOperation(input.actorUserId, key);
      if (!operation) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_PLAN_NOT_FOUND",
          "转移计划不存在",
          404,
        );
      }
      assertNotExpired(operation);
      if (operation.status === "staging") return { ...operation, reused: true };
      if (operation.status !== "prepared") {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_STATE_CONFLICT",
          `当前状态 ${operation.status} 无法进入 staging`,
          409,
          { operationId: operation.id, status: operation.status },
        );
      }

      const sourceAttachments = await loadSourceAttachments(operation);
      const attachmentBytes = sourceAttachments.reduce(
        (total, attachment) => total + toNumber(attachment.size),
        0,
      );
      if (
        sourceAttachments.length !== operation.plan.attachmentCount
        || attachmentBytes !== operation.plan.attachmentBytes
      ) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_ATTACHMENT_SNAPSHOT_STALE",
          "附件数量或大小已变化，请重新预检",
          409,
          {
            operationId: operation.id,
            expectedCount: operation.plan.attachmentCount,
            actualCount: sourceAttachments.length,
            expectedBytes: operation.plan.attachmentBytes,
            actualBytes: attachmentBytes,
          },
        );
      }

      const stagedAttachments = sourceAttachments.map((attachment) => {
        const targetNoteId = operation.plan.targetNoteIds[attachment.noteId];
        if (!targetNoteId) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_PLAN_STALE",
            "附件对应的目标笔记映射不存在，请重新预检",
            409,
            { sourceAttachmentId: attachment.id, sourceNoteId: attachment.noteId },
          );
        }
        const targetAttachmentId = randomUUID();
        return {
          source: attachment,
          targetAttachmentId,
          targetNoteId,
          stagedPath: `note-transfer-staging/${operation.id}/${targetAttachmentId}`,
          mimeType: attachment.mimeType || "application/octet-stream",
        };
      });

      const statements: DbStatement[] = [
        targetGuard({
          actorUserId: input.actorUserId,
          targetNotebookId: operation.targetNotebookId,
          targetWorkspaceId: operation.targetWorkspaceId,
        }),
        ...operation.plan.sourceNoteIds.map((sourceNoteId) => sourceGuard({
          actorUserId: input.actorUserId,
          sourceWorkspaceId: operation.sourceWorkspaceId,
          sourceNoteId,
          sourceVersion: operation.sourceVersions[sourceNoteId],
        })),
      ];

      if (operation.includeAttachments) {
        const notePlaceholders = placeholders(operation.plan.sourceNoteIds.length);
        statements.push({
          sql: `SELECT 1
                  WHERE (SELECT COUNT(*) FROM attachments WHERE noteId IN (${notePlaceholders})) = ?
                    AND (SELECT COALESCE(SUM(size), 0) FROM attachments WHERE noteId IN (${notePlaceholders})) = ?`,
          params: [
            ...operation.plan.sourceNoteIds,
            operation.plan.attachmentCount,
            ...operation.plan.sourceNoteIds,
            operation.plan.attachmentBytes,
          ],
          requireChanges: 1,
        });
      }

      statements.push({
        sql: `UPDATE note_transfer_operations
                 SET status = 'staging', updatedAt = CURRENT_TIMESTAMP
               WHERE id = ? AND userId = ? AND idempotencyKey = ?
                 AND status = 'prepared' AND expiresAt > CURRENT_TIMESTAMP`,
        params: [operation.id, input.actorUserId, key],
        requireChanges: 1,
      });

      for (const attachment of stagedAttachments) {
        statements.push({
          sql: `INSERT INTO note_transfer_staged_attachments (
                  operationId, sourceAttachmentId, sourceNoteId,
                  targetAttachmentId, targetNoteId, sourcePath, stagedPath,
                  filename, mimeType, size, hash, status
                )
                SELECT ?, source.id, source.noteId, ?, ?, source.path, ?,
                       source.filename, COALESCE(source.mimeType, 'application/octet-stream'),
                       source.size, source.hash, 'planned'
                  FROM attachments source
                 WHERE source.id = ? AND source.noteId = ? AND source.path = ?
                   AND source.filename = ?
                   AND COALESCE(source.mimeType, 'application/octet-stream') = ?
                   AND source.size = ?
                   AND COALESCE(source.hash, '') = COALESCE(?, '')`,
          params: [
            operation.id,
            attachment.targetAttachmentId,
            attachment.targetNoteId,
            attachment.stagedPath,
            attachment.source.id,
            attachment.source.noteId,
            attachment.source.path,
            attachment.source.filename,
            attachment.mimeType,
            toNumber(attachment.source.size),
            attachment.source.hash,
          ],
          requireChanges: 1,
        });
      }

      try {
        await db.executeStatements(statements);
      } catch (error) {
        const raced = await loadOperation(input.actorUserId, key).catch(() => null);
        if (raced?.status === "staging") return { ...raced, reused: true };
        if (error instanceof DbStatementChangeError) mapTransactionError(error);
        throw error;
      }

      const staged = await loadOperation(input.actorUserId, key);
      if (!staged || staged.status !== "staging") {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_STAGING_PERSIST_FAILED",
          "转移 staging 状态保存失败",
          409,
        );
      }
      return staged;
    },

    async requeueFailedStagedAttachments(input: {
      actorUserId: string;
      idempotencyKey: string;
      maxAttempts: number;
    }): Promise<number> {
      const key = normalizeIdempotencyKey(input.idempotencyKey);
      const result = await db.execute(
        `UPDATE note_transfer_staged_attachments manifest
            SET status = 'planned', leaseToken = NULL, leaseExpiresAt = NULL,
                updatedAt = CURRENT_TIMESTAMP
           FROM note_transfer_operations operation
          WHERE manifest.operationId = operation.id
            AND operation.userId = ? AND operation.idempotencyKey = ?
            AND operation.status = 'staging'
            AND manifest.status = 'failed' AND manifest.attempts < ?`,
        [input.actorUserId, key, input.maxAttempts],
      );
      return result.changes;
    },

    async claimNextStagedAttachment(input: {
      actorUserId: string;
      idempotencyKey: string;
      maxAttempts: number;
      leaseSeconds: number;
    }): Promise<NoteTransferStagingClaim | null> {
      const key = normalizeIdempotencyKey(input.idempotencyKey);
      const leaseToken = randomUUID();
      const row = await db.queryOne<StagingClaimRow>(
        `WITH candidate AS (
           SELECT manifest.operationId, manifest.sourceAttachmentId
             FROM note_transfer_staged_attachments manifest
             JOIN note_transfer_operations operation
               ON operation.id = manifest.operationId
            WHERE operation.userId = ? AND operation.idempotencyKey = ?
              AND operation.status = 'staging'
              AND manifest.attempts < ?
              AND (
                manifest.status = 'planned'
                OR (
                  manifest.status = 'copying'
                  AND (manifest.leaseExpiresAt IS NULL OR manifest.leaseExpiresAt <= CURRENT_TIMESTAMP)
                )
              )
            ORDER BY manifest.sourceNoteId, manifest.sourceAttachmentId
            FOR UPDATE OF manifest SKIP LOCKED
            LIMIT 1
         )
         UPDATE note_transfer_staged_attachments manifest
            SET status = 'copying', attempts = manifest.attempts + 1,
                leaseToken = ?,
                leaseExpiresAt = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                lastError = NULL, updatedAt = CURRENT_TIMESTAMP
           FROM candidate
          WHERE manifest.operationId = candidate.operationId
            AND manifest.sourceAttachmentId = candidate.sourceAttachmentId
         RETURNING manifest.operationId, manifest.sourceAttachmentId,
                   manifest.sourceNoteId, manifest.targetAttachmentId,
                   manifest.targetNoteId, manifest.sourcePath, manifest.stagedPath,
                   manifest.filename, manifest.mimeType, manifest.size, manifest.hash,
                   manifest.attempts`,
        [
          input.actorUserId,
          key,
          input.maxAttempts,
          leaseToken,
          Math.max(30, input.leaseSeconds),
        ],
      );
      if (!row) return null;
      return {
        operationId: row.operationId,
        sourceAttachmentId: row.sourceAttachmentId,
        sourceNoteId: row.sourceNoteId,
        targetAttachmentId: row.targetAttachmentId,
        targetNoteId: row.targetNoteId,
        sourcePath: row.sourcePath,
        stagedPath: row.stagedPath,
        filename: row.filename,
        mimeType: row.mimeType,
        size: toNumber(row.size),
        hash: row.hash,
        attempts: toNumber(row.attempts),
        leaseToken,
      };
    },

    async markStagedAttachmentComplete(input: {
      operationId: string;
      sourceAttachmentId: string;
      leaseToken: string;
      verifiedSize: number;
      verifiedHash: string;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE note_transfer_staged_attachments
            SET status = 'staged', verifiedSize = ?, verifiedHash = ?,
                stagedAt = CURRENT_TIMESTAMP, leaseToken = NULL, leaseExpiresAt = NULL,
                lastError = NULL, updatedAt = CURRENT_TIMESTAMP
          WHERE operationId = ? AND sourceAttachmentId = ?
            AND status = 'copying' AND leaseToken = ?`,
        [
          input.verifiedSize,
          input.verifiedHash,
          input.operationId,
          input.sourceAttachmentId,
          input.leaseToken,
        ],
      );
      if (result.changes !== 1) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_STAGING_LEASE_LOST",
          "附件 staging 租约已失效，请重新恢复操作",
          409,
          { operationId: input.operationId, sourceAttachmentId: input.sourceAttachmentId },
        );
      }
    },

    async markStagedAttachmentFailed(input: {
      operationId: string;
      sourceAttachmentId: string;
      leaseToken: string;
      error: string;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE note_transfer_staged_attachments
            SET status = 'failed', lastError = ?,
                leaseToken = NULL, leaseExpiresAt = NULL,
                updatedAt = CURRENT_TIMESTAMP
          WHERE operationId = ? AND sourceAttachmentId = ?
            AND status = 'copying' AND leaseToken = ?`,
        [
          input.error.slice(0, 2000),
          input.operationId,
          input.sourceAttachmentId,
          input.leaseToken,
        ],
      );
      if (result.changes !== 1) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_STAGING_LEASE_LOST",
          "附件 staging 租约已失效，请重新恢复操作",
          409,
          { operationId: input.operationId, sourceAttachmentId: input.sourceAttachmentId },
        );
      }
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
