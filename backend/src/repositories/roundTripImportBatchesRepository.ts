import type { DatabaseAdapter } from "../db/adapters/types";
import { nowExpression } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";

export type RoundTripImportBatchStatus = "running" | "completed" | "failed" | "undone";

export interface RoundTripImportBatchRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  workspaceScope: string;
  importMode: string;
  packageKind: string | null;
  sourceInstanceId: string | null;
  sourceExportBatchId: string | null;
  status: RoundTripImportBatchStatus;
  previewJson: string;
  resultJson: string;
  undoStateJson: string;
  undoAvailable: boolean;
  undoUnavailableReason: string | null;
  undoExpiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
  undoneAt: string | null;
  undoError: string | null;
}

export interface CreateRoundTripImportBatchInput {
  id: string;
  userId: string;
  workspaceId: string | null;
  workspaceScope: string;
  importMode: string;
  packageKind: string | null;
  sourceInstanceId: string | null;
  sourceExportBatchId: string | null;
  previewJson: string;
  undoStateJson: string;
  undoAvailable: boolean;
  undoUnavailableReason: string | null;
  undoExpiresAt: string;
}

function resolveAdapter(adapter?: DatabaseAdapter): DatabaseAdapter {
  return adapter ?? getDatabaseAdapter();
}

function resolveNowExpression(): string {
  try {
    return nowExpression(getDatabaseDialect());
  } catch {
    return nowExpression("sqlite");
  }
}

function asIsoString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function normalizeRow(row: Record<string, unknown>): RoundTripImportBatchRow {
  return {
    id: String(row.id),
    userId: String(row.userId),
    workspaceId: row.workspaceId === null || row.workspaceId === undefined ? null : String(row.workspaceId),
    workspaceScope: String(row.workspaceScope),
    importMode: String(row.importMode),
    packageKind: row.packageKind === null || row.packageKind === undefined ? null : String(row.packageKind),
    sourceInstanceId: row.sourceInstanceId === null || row.sourceInstanceId === undefined ? null : String(row.sourceInstanceId),
    sourceExportBatchId: row.sourceExportBatchId === null || row.sourceExportBatchId === undefined ? null : String(row.sourceExportBatchId),
    status: String(row.status) as RoundTripImportBatchStatus,
    previewJson: String(row.previewJson ?? "{}"),
    resultJson: String(row.resultJson ?? "{}"),
    undoStateJson: String(row.undoStateJson ?? "{}"),
    undoAvailable: asBoolean(row.undoAvailable),
    undoUnavailableReason: row.undoUnavailableReason === null || row.undoUnavailableReason === undefined ? null : String(row.undoUnavailableReason),
    undoExpiresAt: asIsoString(row.undoExpiresAt),
    createdAt: asIsoString(row.createdAt) ?? "",
    completedAt: asIsoString(row.completedAt),
    undoneAt: asIsoString(row.undoneAt),
    undoError: row.undoError === null || row.undoError === undefined ? null : String(row.undoError),
  };
}

export function createRoundTripImportBatchesRepository(adapter?: DatabaseAdapter) {
  const getAdapter = () => resolveAdapter(adapter);

  return {
    async create(input: CreateRoundTripImportBatchInput): Promise<void> {
      await getAdapter().execute(
        `INSERT INTO roundtrip_import_batches (
          id, "userId", "workspaceId", "workspaceScope", "importMode", "packageKind",
          "sourceInstanceId", "sourceExportBatchId", status, "previewJson", "resultJson",
          "undoStateJson", "undoAvailable", "undoUnavailableReason", "undoExpiresAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, '{}', ?, ?, ?, ?)`,
        [
          input.id,
          input.userId,
          input.workspaceId,
          input.workspaceScope,
          input.importMode,
          input.packageKind,
          input.sourceInstanceId,
          input.sourceExportBatchId,
          input.previewJson,
          input.undoStateJson,
          input.undoAvailable,
          input.undoUnavailableReason,
          input.undoExpiresAt,
        ],
      );
    },

    async markFailed(batchId: string, resultJson: string, reason: string | null): Promise<void> {
      const now = resolveNowExpression();
      await getAdapter().execute(
        `UPDATE roundtrip_import_batches
            SET status = 'failed', "resultJson" = ?, "completedAt" = ${now},
                "undoAvailable" = FALSE,
                "undoUnavailableReason" = COALESCE(?, "undoUnavailableReason", '导入失败，未产生可撤销批次')
          WHERE id = ?`,
        [resultJson, reason, batchId],
      );
    },

    async markCompleted(args: {
      batchId: string;
      resultJson: string;
      undoStateJson: string;
      undoAvailable: boolean;
      undoUnavailableReason: string | null;
    }): Promise<void> {
      const now = resolveNowExpression();
      await getAdapter().execute(
        `UPDATE roundtrip_import_batches
            SET status = 'completed', "resultJson" = ?, "undoStateJson" = ?,
                "undoAvailable" = ?, "undoUnavailableReason" = ?, "completedAt" = ${now}
          WHERE id = ?`,
        [
          args.resultJson,
          args.undoStateJson,
          args.undoAvailable,
          args.undoUnavailableReason,
          args.batchId,
        ],
      );
    },

    async getByUserAndId(userId: string, batchId: string): Promise<RoundTripImportBatchRow | null> {
      const row = await getAdapter().queryOne<Record<string, unknown>>(
        `SELECT * FROM roundtrip_import_batches WHERE id = ? AND "userId" = ?`,
        [batchId, userId],
      );
      return row ? normalizeRow(row) : null;
    },

    async listByUser(
      userId: string,
      options: { workspaceScope?: string; limit: number },
    ): Promise<RoundTripImportBatchRow[]> {
      const rows = options.workspaceScope === undefined
        ? await getAdapter().queryMany<Record<string, unknown>>(
          `SELECT * FROM roundtrip_import_batches
            WHERE "userId" = ?
            ORDER BY "createdAt" DESC
            LIMIT ?`,
          [userId, options.limit],
        )
        : await getAdapter().queryMany<Record<string, unknown>>(
          `SELECT * FROM roundtrip_import_batches
            WHERE "userId" = ? AND "workspaceScope" = ?
            ORDER BY "createdAt" DESC
            LIMIT ?`,
          [userId, options.workspaceScope, options.limit],
        );
      return rows.map(normalizeRow);
    },

    async findExpiredUndoIds(nowIso: string): Promise<string[]> {
      const rows = await getAdapter().queryMany<{ id: string }>(
        `SELECT id FROM roundtrip_import_batches
          WHERE "undoAvailable" = TRUE
            AND "undoExpiresAt" IS NOT NULL
            AND "undoExpiresAt" <= ?`,
        [nowIso],
      );
      return rows.map((row) => String(row.id));
    },

    async markUndoExpired(ids: string[]): Promise<void> {
      if (!ids.length) return;
      await getAdapter().executeBatch(
        `UPDATE roundtrip_import_batches
            SET "undoAvailable" = FALSE,
                "undoUnavailableReason" = COALESCE("undoUnavailableReason", '撤销窗口已过期')
          WHERE id = ?`,
        ids.map((id) => [id]),
      );
    },

    async setUndoError(batchId: string, message: string | null): Promise<void> {
      await getAdapter().execute(
        `UPDATE roundtrip_import_batches SET "undoError" = ? WHERE id = ?`,
        [message, batchId],
      );
    },
  };
}

export const roundTripImportBatchesRepository = createRoundTripImportBatchesRepository();
