import { randomUUID } from "node:crypto";

import type { DatabaseAdapter, DbStatement } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";

export type SqlitePostgresMigrationTableStatus =
  | "planned" | "copying" | "copied" | "verifying" | "verified" | "skipped" | "failed";

export class SqlitePostgresMigrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SqlitePostgresMigrationError";
  }
}

export type SqlitePostgresMigrationTablePlan = {
  tableName: string;
  dependencyOrder: number;
  primaryKeyColumns: string[];
  totalRows: number;
};

export type SqlitePostgresMigrationRun = {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  mode: "apply" | "verify" | "rollback";
  status: string;
  sourceFingerprint: string;
  sourcePathHint: string;
  sourceSchemaVersion: number;
  sourceFileSize: number;
  sourceModifiedAt: string;
  sourceSnapshot: Record<string, unknown>;
  plan: Record<string, unknown>;
  report: Record<string, unknown>;
  targetWasEmpty: boolean;
  allowNonEmptyTarget: boolean;
  currentTable: string | null;
  totalTables: number;
  completedTables: number;
  totalRows: number;
  copiedRows: number;
  verifiedRows: number;
  attempts: number;
  availableAt: string;
  leaseExpiresAt: string | null;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SqlitePostgresMigrationTableCheckpoint = {
  runId: string;
  tableName: string;
  dependencyOrder: number;
  status: SqlitePostgresMigrationTableStatus;
  primaryKeyColumns: string[];
  totalRows: number;
  copiedRows: number;
  verifiedRows: number;
  lastCursor: Record<string, unknown> | null;
  sourceChecksum: string | null;
  targetChecksum: string | null;
  attempts: number;
  availableAt: string;
  leaseExpiresAt: string | null;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SqlitePostgresMigrationBatchCheckpoint = {
  id: string;
  runId: string;
  tableName: string;
  batchSequence: number;
  status: "planned" | "writing" | "completed" | "failed";
  cursorStart: Record<string, unknown> | null;
  cursorEnd: Record<string, unknown> | null;
  rowCount: number;
  checksum: string | null;
  attempts: number;
  leaseExpiresAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type SqlitePostgresMigrationSnapshot = {
  run: SqlitePostgresMigrationRun;
  tables: SqlitePostgresMigrationTableCheckpoint[];
  progress: Record<SqlitePostgresMigrationTableStatus, number> & { complete: boolean };
};

export type SqlitePostgresMigrationTableClaim = {
  runId: string;
  tableName: string;
  dependencyOrder: number;
  totalRows: number;
  copiedRows: number;
  lastCursor: Record<string, unknown> | null;
  leaseToken: string;
};

type Row = Record<string, any>;

function normalizeKey(value: string): string {
  const key = String(value || "").trim();
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_IDEMPOTENCY_KEY_INVALID",
      "迁移幂等键需为 8～128 位字母、数字、点、下划线、冒号或连字符",
    );
  }
  return key;
}

function normalizeHash(value: string, name: string): string {
  const hash = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_HASH_INVALID",
      `${name} 必须是 SHA-256`,
    );
  }
  return hash;
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function optionalTimestamp(value: unknown): string | null {
  return value == null ? null : timestamp(value);
}

function normalizeRun(row: Row): SqlitePostgresMigrationRun {
  return {
    ...row,
    sourceSchemaVersion: numberValue(row.sourceSchemaVersion),
    sourceFileSize: numberValue(row.sourceFileSize),
    totalTables: numberValue(row.totalTables),
    completedTables: numberValue(row.completedTables),
    totalRows: numberValue(row.totalRows),
    copiedRows: numberValue(row.copiedRows),
    verifiedRows: numberValue(row.verifiedRows),
    attempts: numberValue(row.attempts),
    sourceModifiedAt: timestamp(row.sourceModifiedAt),
    availableAt: timestamp(row.availableAt),
    leaseExpiresAt: optionalTimestamp(row.leaseExpiresAt),
    startedAt: optionalTimestamp(row.startedAt),
    completedAt: optionalTimestamp(row.completedAt),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  } as SqlitePostgresMigrationRun;
}

function normalizeTable(row: Row): SqlitePostgresMigrationTableCheckpoint {
  return {
    ...row,
    dependencyOrder: numberValue(row.dependencyOrder),
    totalRows: numberValue(row.totalRows),
    copiedRows: numberValue(row.copiedRows),
    verifiedRows: numberValue(row.verifiedRows),
    attempts: numberValue(row.attempts),
    availableAt: timestamp(row.availableAt),
    leaseExpiresAt: optionalTimestamp(row.leaseExpiresAt),
    startedAt: optionalTimestamp(row.startedAt),
    completedAt: optionalTimestamp(row.completedAt),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  } as SqlitePostgresMigrationTableCheckpoint;
}

function normalizeBatch(row: Row): SqlitePostgresMigrationBatchCheckpoint {
  return {
    ...row,
    batchSequence: numberValue(row.batchSequence),
    rowCount: numberValue(row.rowCount),
    attempts: numberValue(row.attempts),
    leaseExpiresAt: optionalTimestamp(row.leaseExpiresAt),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    completedAt: optionalTimestamp(row.completedAt),
  } as SqlitePostgresMigrationBatchCheckpoint;
}

export function createSqlitePostgresMigrationRepository(adapter?: DatabaseAdapter) {
  const db = adapter ?? getDatabaseAdapter();

  async function findRunByKey(key: string): Promise<SqlitePostgresMigrationRun | null> {
    const row = await db.queryOne<Row>(
      `SELECT * FROM sqlite_postgres_migration_runs WHERE "idempotencyKey" = ?`,
      [normalizeKey(key)],
    );
    return row ? normalizeRun(row) : null;
  }

  async function snapshot(runId: string): Promise<SqlitePostgresMigrationSnapshot> {
    const runRow = await db.queryOne<Row>(
      `SELECT * FROM sqlite_postgres_migration_runs WHERE id = ?`,
      [runId],
    );
    if (!runRow) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_RUN_NOT_FOUND",
        "数据迁移运行记录不存在",
        404,
        { runId },
      );
    }
    const tables = (await db.queryMany<Row>(
      `SELECT *
         FROM sqlite_postgres_migration_table_checkpoints
        WHERE "runId" = ?
        ORDER BY "dependencyOrder", "tableName"`,
      [runId],
    )).map(normalizeTable);
    const statuses: SqlitePostgresMigrationTableStatus[] = [
      "planned", "copying", "copied", "verifying", "verified", "skipped", "failed",
    ];
    const progress = Object.fromEntries(
      statuses.map((status) => [status, tables.filter((table) => table.status === status).length]),
    ) as unknown as SqlitePostgresMigrationSnapshot["progress"];
    progress.complete = tables.length > 0
      && tables.every((table) => table.status === "verified" || table.status === "skipped");
    return { run: normalizeRun(runRow), tables, progress };
  }

  async function refreshRunProgress(runId: string): Promise<void> {
    await db.execute(
      `UPDATE sqlite_postgres_migration_runs run
          SET "completedTables" = summary.completed_tables,
              "copiedRows" = summary.copied_rows,
              "verifiedRows" = summary.verified_rows,
              "updatedAt" = CURRENT_TIMESTAMP
         FROM (
           SELECT "runId",
                  COUNT(*) FILTER (WHERE status IN ('verified', 'skipped'))::int AS completed_tables,
                  COALESCE(SUM("copiedRows"), 0)::bigint AS copied_rows,
                  COALESCE(SUM("verifiedRows"), 0)::bigint AS verified_rows
             FROM sqlite_postgres_migration_table_checkpoints
            WHERE "runId" = ?
            GROUP BY "runId"
         ) summary
        WHERE run.id = summary."runId"`,
      [runId],
    );
  }

  return {
    getSnapshotByRunId: snapshot,

    async getSnapshotByIdempotencyKey(key: string) {
      const run = await findRunByKey(key);
      if (!run) {
        throw new SqlitePostgresMigrationError(
          "SQLITE_PG_MIGRATION_RUN_NOT_FOUND",
          "数据迁移运行记录不存在",
          404,
        );
      }
      return snapshot(run.id);
    },

    async createPlannedRun(input: {
      idempotencyKey: string;
      requestHash: string;
      sourceFingerprint: string;
      sourcePathHint: string;
      sourceSchemaVersion: number;
      sourceFileSize: number;
      sourceModifiedAt: string;
      sourceSnapshot: Record<string, unknown>;
      plan: Record<string, unknown>;
      targetWasEmpty: boolean;
      allowNonEmptyTarget: boolean;
      tables: SqlitePostgresMigrationTablePlan[];
    }) {
      const key = normalizeKey(input.idempotencyKey);
      const requestHash = normalizeHash(input.requestHash, "requestHash");
      const sourceFingerprint = normalizeHash(input.sourceFingerprint, "sourceFingerprint");
      const runId = randomUUID();
      const inserted = await db.execute(
        `INSERT INTO sqlite_postgres_migration_runs (
           id, "idempotencyKey", "requestHash", mode, status,
           "sourceFingerprint", "sourcePathHint", "sourceSchemaVersion",
           "sourceFileSize", "sourceModifiedAt", "sourceSnapshot", plan,
           "targetWasEmpty", "allowNonEmptyTarget", "totalTables", "totalRows"
         ) VALUES (
           ?, ?, ?, 'apply', 'planned', ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?
         )
         ON CONFLICT ("idempotencyKey") DO NOTHING`,
        [
          runId, key, requestHash, sourceFingerprint,
          String(input.sourcePathHint || "nowen-note.db").slice(0, 255),
          Math.max(0, Math.trunc(input.sourceSchemaVersion)),
          Math.max(0, Math.trunc(input.sourceFileSize)),
          input.sourceModifiedAt,
          JSON.stringify(input.sourceSnapshot),
          JSON.stringify(input.plan),
          input.targetWasEmpty,
          input.allowNonEmptyTarget,
          input.tables.length,
          input.tables.reduce((sum, table) => sum + Math.max(0, table.totalRows), 0),
        ],
      );
      const run = await findRunByKey(key);
      if (!run) {
        throw new SqlitePostgresMigrationError(
          "SQLITE_PG_MIGRATION_RUN_CREATE_FAILED",
          "无法创建数据迁移运行记录",
          500,
        );
      }
      if (run.requestHash !== requestHash) {
        throw new SqlitePostgresMigrationError(
          "SQLITE_PG_MIGRATION_IDEMPOTENCY_CONFLICT",
          "该幂等键已用于不同的数据迁移计划",
          409,
          { runId: run.id },
        );
      }
      await db.executeStatements(input.tables.map((table) => ({
        sql: `INSERT INTO sqlite_postgres_migration_table_checkpoints (
                "runId", "tableName", "dependencyOrder", "primaryKeyColumns", "totalRows"
              ) VALUES (?, ?, ?, ?::jsonb, ?)
              ON CONFLICT ("runId", "tableName") DO NOTHING`,
        params: [
          run.id, table.tableName, Math.max(0, table.dependencyOrder),
          JSON.stringify(table.primaryKeyColumns), Math.max(0, table.totalRows),
        ],
      })));
      return { snapshot: await snapshot(run.id), reused: inserted.changes === 0 };
    },

    async claimNextTable(input: {
      runId: string;
      maxAttempts?: number;
      leaseSeconds?: number;
    }): Promise<SqlitePostgresMigrationTableClaim | null> {
      const leaseToken = randomUUID();
      const row = await db.queryOne<Row>(
        `WITH candidate AS (
           SELECT checkpoint."runId", checkpoint."tableName"
             FROM sqlite_postgres_migration_table_checkpoints checkpoint
             JOIN sqlite_postgres_migration_runs run ON run.id = checkpoint."runId"
            WHERE checkpoint."runId" = ?
              AND run.status IN ('planned', 'copying', 'verifying', 'failed')
              AND checkpoint.status IN ('planned', 'copying', 'verifying', 'failed')
              AND checkpoint.attempts < ?
              AND checkpoint."availableAt" <= CURRENT_TIMESTAMP
              AND (
                checkpoint."leaseExpiresAt" IS NULL
                OR checkpoint."leaseExpiresAt" <= CURRENT_TIMESTAMP
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM sqlite_postgres_migration_table_checkpoints dependency
                 WHERE dependency."runId" = checkpoint."runId"
                   AND dependency."dependencyOrder" < checkpoint."dependencyOrder"
                   AND dependency.status NOT IN ('verified', 'skipped')
              )
            ORDER BY checkpoint."dependencyOrder", checkpoint."tableName"
            FOR UPDATE OF checkpoint SKIP LOCKED
            LIMIT 1
         )
         UPDATE sqlite_postgres_migration_table_checkpoints checkpoint
            SET status = 'copying',
                attempts = attempts + 1,
                "leaseToken" = ?,
                "leaseExpiresAt" = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP),
                "lastError" = NULL,
                "updatedAt" = CURRENT_TIMESTAMP
           FROM candidate
          WHERE checkpoint."runId" = candidate."runId"
            AND checkpoint."tableName" = candidate."tableName"
         RETURNING checkpoint.*`,
        [
          input.runId,
          Math.max(1, Math.trunc(input.maxAttempts ?? 10)),
          leaseToken,
          Math.max(30, Math.trunc(input.leaseSeconds ?? 300)),
        ],
      );
      if (!row) return null;
      await db.execute(
        `UPDATE sqlite_postgres_migration_runs
            SET status = 'copying', "currentTable" = ?, "lastError" = NULL,
                "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP),
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ? AND status IN ('planned', 'copying', 'verifying', 'failed')`,
        [row.tableName, row.runId],
      );
      return {
        runId: row.runId,
        tableName: row.tableName,
        dependencyOrder: numberValue(row.dependencyOrder),
        totalRows: numberValue(row.totalRows),
        copiedRows: numberValue(row.copiedRows),
        lastCursor: row.lastCursor ?? null,
        leaseToken,
      };
    },

    async getCompletedBatches(input: {
      runId: string;
      tableName: string;
    }): Promise<SqlitePostgresMigrationBatchCheckpoint[]> {
      return (await db.queryMany<Row>(
        `SELECT *
           FROM sqlite_postgres_migration_batch_checkpoints
          WHERE "runId" = ? AND "tableName" = ? AND status = 'completed'
          ORDER BY "batchSequence"`,
        [input.runId, input.tableName],
      )).map(normalizeBatch);
    },

    async commitBatch(input: {
      runId: string;
      tableName: string;
      leaseToken: string;
      batchSequence: number;
      cursorStart: Record<string, unknown> | null;
      cursorEnd: Record<string, unknown> | null;
      rowCount: number;
      checksum: string;
      copiedRows: number;
      lastCursor: Record<string, unknown>;
      leaseSeconds?: number;
      statements: DbStatement[];
    }): Promise<void> {
      const statements: DbStatement[] = [
        ...input.statements,
        {
          sql: `INSERT INTO sqlite_postgres_migration_batch_checkpoints (
                  id, "runId", "tableName", "batchSequence", status,
                  "cursorStart", "cursorEnd", "rowCount", checksum,
                  attempts, "completedAt", "updatedAt"
                ) VALUES (?, ?, ?, ?, 'completed', ?::jsonb, ?::jsonb, ?, ?, 1,
                          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT ("runId", "tableName", "batchSequence") DO UPDATE
                  SET status = 'completed',
                      "cursorStart" = EXCLUDED."cursorStart",
                      "cursorEnd" = EXCLUDED."cursorEnd",
                      "rowCount" = EXCLUDED."rowCount",
                      checksum = EXCLUDED.checksum,
                      attempts = sqlite_postgres_migration_batch_checkpoints.attempts + 1,
                      "lastError" = NULL,
                      "completedAt" = CURRENT_TIMESTAMP,
                      "updatedAt" = CURRENT_TIMESTAMP`,
          params: [
            randomUUID(), input.runId, input.tableName,
            Math.max(0, Math.trunc(input.batchSequence)),
            JSON.stringify(input.cursorStart), JSON.stringify(input.cursorEnd),
            Math.max(0, Math.trunc(input.rowCount)),
            normalizeHash(input.checksum, "batch checksum"),
          ],
        },
        {
          sql: `UPDATE sqlite_postgres_migration_table_checkpoints
                   SET status = 'copying', "copiedRows" = ?, "lastCursor" = ?::jsonb,
                       "leaseExpiresAt" = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                       "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP
                 WHERE "runId" = ? AND "tableName" = ? AND "leaseToken" = ?`,
          params: [
            Math.max(0, Math.trunc(input.copiedRows)),
            JSON.stringify(input.lastCursor),
            Math.max(30, Math.trunc(input.leaseSeconds ?? 300)),
            input.runId, input.tableName, input.leaseToken,
          ],
          requireChanges: 1,
        },
        {
          sql: `UPDATE sqlite_postgres_migration_runs run
                   SET "copiedRows" = summary.copied_rows,
                       "currentTable" = ?, "updatedAt" = CURRENT_TIMESTAMP
                  FROM (
                    SELECT "runId", COALESCE(SUM("copiedRows"), 0)::bigint AS copied_rows
                      FROM sqlite_postgres_migration_table_checkpoints
                     WHERE "runId" = ?
                     GROUP BY "runId"
                  ) summary
                 WHERE run.id = summary."runId"`,
          params: [input.tableName, input.runId],
        },
      ];
      await db.executeStatements(statements);
    },

    async markTableVerifying(input: {
      runId: string;
      tableName: string;
      leaseToken: string;
      sourceChecksum: string;
      leaseSeconds?: number;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE sqlite_postgres_migration_table_checkpoints
            SET status = 'verifying', "sourceChecksum" = ?,
                "leaseExpiresAt" = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "runId" = ? AND "tableName" = ? AND "leaseToken" = ?`,
        [
          normalizeHash(input.sourceChecksum, "source checksum"),
          Math.max(30, Math.trunc(input.leaseSeconds ?? 300)),
          input.runId, input.tableName, input.leaseToken,
        ],
      );
      if (result.changes !== 1) {
        throw new SqlitePostgresMigrationError(
          "SQLITE_PG_MIGRATION_TABLE_LEASE_LOST",
          "数据迁移表租约已失效",
          409,
        );
      }
      await db.execute(
        `UPDATE sqlite_postgres_migration_runs
            SET status = 'verifying', "currentTable" = ?, "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [input.tableName, input.runId],
      );
    },

    async markTableVerified(input: {
      runId: string;
      tableName: string;
      leaseToken: string;
      verifiedRows: number;
      targetChecksum: string;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE sqlite_postgres_migration_table_checkpoints
            SET status = 'verified', "verifiedRows" = ?, "targetChecksum" = ?,
                "leaseToken" = NULL, "leaseExpiresAt" = NULL,
                "lastError" = NULL, "completedAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "runId" = ? AND "tableName" = ? AND "leaseToken" = ?`,
        [
          Math.max(0, Math.trunc(input.verifiedRows)),
          normalizeHash(input.targetChecksum, "target checksum"),
          input.runId, input.tableName, input.leaseToken,
        ],
      );
      if (result.changes !== 1) {
        throw new SqlitePostgresMigrationError(
          "SQLITE_PG_MIGRATION_TABLE_LEASE_LOST",
          "数据迁移表租约已失效",
          409,
        );
      }
      await refreshRunProgress(input.runId);
      const remaining = await db.queryOne<{ count: number | string }>(
        `SELECT COUNT(*)::bigint AS count
           FROM sqlite_postgres_migration_table_checkpoints
          WHERE "runId" = ? AND status NOT IN ('verified', 'skipped')`,
        [input.runId],
      );
      const complete = numberValue(remaining?.count) === 0;
      await db.execute(
        `UPDATE sqlite_postgres_migration_runs
            SET status = ?, "currentTable" = NULL, "lastError" = NULL,
                "completedAt" = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [complete ? "completed" : "copying", complete, input.runId],
      );
    },

    async releaseTableLease(input: {
      runId: string;
      tableName: string;
      leaseToken: string;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE sqlite_postgres_migration_table_checkpoints
            SET status = 'copying', "leaseToken" = NULL, "leaseExpiresAt" = NULL,
                "availableAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "runId" = ? AND "tableName" = ? AND "leaseToken" = ?`,
        [input.runId, input.tableName, input.leaseToken],
      );
      if (result.changes !== 1) {
        throw new SqlitePostgresMigrationError(
          "SQLITE_PG_MIGRATION_TABLE_LEASE_LOST",
          "数据迁移表租约已失效",
          409,
        );
      }
      await db.execute(
        `UPDATE sqlite_postgres_migration_runs
            SET "currentTable" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [input.runId],
      );
    },

    async markTableCopied(input: {
      runId: string;
      tableName: string;
      leaseToken: string;
      copiedRows: number;
      lastCursor?: Record<string, unknown> | null;
      sourceChecksum?: string | null;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE sqlite_postgres_migration_table_checkpoints
            SET status = 'copied', "copiedRows" = ?, "lastCursor" = ?::jsonb,
                "sourceChecksum" = ?, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
                "lastError" = NULL, "completedAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "runId" = ? AND "tableName" = ? AND "leaseToken" = ?`,
        [
          Math.max(0, Math.trunc(input.copiedRows)),
          JSON.stringify(input.lastCursor ?? null),
          input.sourceChecksum ?? null,
          input.runId, input.tableName, input.leaseToken,
        ],
      );
      if (result.changes !== 1) {
        throw new SqlitePostgresMigrationError(
          "SQLITE_PG_MIGRATION_TABLE_LEASE_LOST",
          "数据迁移表租约已失效",
          409,
        );
      }
      await refreshRunProgress(input.runId);
    },

    async markTableFailed(input: {
      runId: string;
      tableName: string;
      leaseToken: string;
      error: string;
      retryDelaySeconds?: number;
    }): Promise<void> {
      const message = String(input.error || "unknown migration error").slice(0, 2_000);
      const result = await db.execute(
        `UPDATE sqlite_postgres_migration_table_checkpoints
            SET status = 'failed',
                "availableAt" = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                "leaseToken" = NULL, "leaseExpiresAt" = NULL,
                "lastError" = ?, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "runId" = ? AND "tableName" = ? AND "leaseToken" = ?`,
        [
          Math.max(0, Math.trunc(input.retryDelaySeconds ?? 5)),
          message, input.runId, input.tableName, input.leaseToken,
        ],
      );
      if (result.changes !== 1) {
        throw new SqlitePostgresMigrationError(
          "SQLITE_PG_MIGRATION_TABLE_LEASE_LOST",
          "数据迁移表租约已失效",
          409,
        );
      }
      await db.execute(
        `UPDATE sqlite_postgres_migration_runs
            SET status = 'failed', "lastError" = ?, attempts = attempts + 1,
                "currentTable" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [message, input.runId],
      );
    },

    async markRunFailed(input: { runId: string; error: string }): Promise<void> {
      await db.execute(
        `UPDATE sqlite_postgres_migration_runs
            SET status = 'failed', "lastError" = ?, attempts = attempts + 1,
                "currentTable" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ? AND status <> 'completed'`,
        [String(input.error || "unknown migration error").slice(0, 2_000), input.runId],
      );
    },
  };
}
