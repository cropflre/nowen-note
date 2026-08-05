import { createHash } from "node:crypto";

import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbStatement,
} from "../db/adapters/types";
import {
  createSqlitePostgresMigrationRepository,
  SqlitePostgresMigrationError,
  type SqlitePostgresMigrationSnapshot,
} from "../repositories/sqlitePostgresMigrationRepository";

const DEFAULT_BATCH_SIZE = 200;

type Repository = ReturnType<typeof createSqlitePostgresMigrationRepository>;

type RowChange = {
  runId: string;
  tableName: string;
  primaryKey: Record<string, unknown>;
  primaryKeyHash: string;
  batchSequence: number | string;
  changeKind: "inserted" | "updated" | "unchanged";
  originalRow: Record<string, unknown> | null;
  migratedRow: Record<string, unknown> | null;
  rollbackStatus: "planned" | "rolled_back" | "failed";
};

export type SqlitePostgresRollbackTableReport = {
  tableName: string;
  trackedRows: number;
  insertedRows: number;
  updatedRows: number;
  unchangedRows: number;
  rolledBackRows: number;
  deletedRows: number;
  restoredRows: number;
  remainingTargetRows: number;
  concurrentConflicts: number;
};

export type SqlitePostgresRollbackReport = {
  generatedAt: string;
  ok: boolean;
  complete: boolean;
  runId: string;
  status: string;
  totalTrackedRows: number;
  totalRolledBackRows: number;
  tables: SqlitePostgresRollbackTableReport[];
  failures: Array<{
    tableName: string;
    code: string;
    message: string;
  }>;
};

export type SqlitePostgresRollbackRuntimeOptions = {
  repository?: Repository;
  batchSize?: number;
};

function quoteIdentifier(value: string): string {
  const name = String(value || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_IDENTIFIER_INVALID",
      "回滚表名或主键列名不安全",
      500,
    );
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stableJson(value: unknown): string {
  if (value == null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function errorMessage(error: unknown): string {
  if (error instanceof SqlitePostgresMigrationError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function primaryKeyEntries(change: RowChange): Array<[string, unknown]> {
  const entries = Object.entries(change.primaryKey || {});
  if (entries.length === 0) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_ROLLBACK_PRIMARY_KEY_MISSING",
      "run-owned 写入记录缺少主键",
      500,
      { tableName: change.tableName },
    );
  }
  return entries;
}

function markRolledBackSql(): string {
  return `UPDATE sqlite_postgres_migration_row_changes
             SET "rollbackStatus" = 'rolled_back',
                 "rollbackAttempts" = "rollbackAttempts" + 1,
                 "lastError" = NULL,
                 "rolledBackAt" = CURRENT_TIMESTAMP,
                 "updatedAt" = CURRENT_TIMESTAMP
           WHERE "runId" = ? AND "tableName" = ? AND "primaryKeyHash" = ?
             AND "rollbackStatus" = 'planned'`;
}

function unchangedStatement(change: RowChange): DbStatement {
  return {
    sql: markRolledBackSql(),
    params: [change.runId, change.tableName, change.primaryKeyHash],
    requireChanges: 1,
  };
}

function insertedStatement(change: RowChange): DbStatement {
  const entries = primaryKeyEntries(change);
  if (!change.migratedRow) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_ROLLBACK_MIGRATED_SNAPSHOT_MISSING",
      "inserted 行缺少 migratedRow，无法执行并发安全删除",
      409,
      { tableName: change.tableName, primaryKeyHash: change.primaryKeyHash },
    );
  }
  const predicate = entries
    .map(([column]) => `target.${quoteIdentifier(column)} = ?`)
    .join(" AND ");
  return {
    sql: `WITH deleted AS (
            DELETE FROM ${quoteIdentifier(change.tableName)} AS target
             WHERE ${predicate}
               AND to_jsonb(target) = ?::jsonb
            RETURNING 1
          ), remaining AS (
            SELECT 1
              FROM ${quoteIdentifier(change.tableName)} AS target
             WHERE ${predicate}
          )
          UPDATE sqlite_postgres_migration_row_changes
             SET "rollbackStatus" = 'rolled_back',
                 "rollbackAttempts" = "rollbackAttempts" + 1,
                 "lastError" = NULL,
                 "rolledBackAt" = CURRENT_TIMESTAMP,
                 "updatedAt" = CURRENT_TIMESTAMP
           WHERE "runId" = ? AND "tableName" = ? AND "primaryKeyHash" = ?
             AND "rollbackStatus" = 'planned'
             AND (EXISTS (SELECT 1 FROM deleted)
               OR NOT EXISTS (SELECT 1 FROM remaining))`,
    params: [
      ...entries.map(([, value]) => value),
      JSON.stringify(change.migratedRow),
      ...entries.map(([, value]) => value),
      change.runId,
      change.tableName,
      change.primaryKeyHash,
    ],
    requireChanges: 1,
  };
}

function updatedStatement(change: RowChange): DbStatement {
  const entries = primaryKeyEntries(change);
  if (!change.originalRow || !change.migratedRow) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_ROLLBACK_SNAPSHOT_MISSING",
      "updated 行缺少 originalRow 或 migratedRow，拒绝猜测恢复内容",
      409,
      { tableName: change.tableName, primaryKeyHash: change.primaryKeyHash },
    );
  }
  const primaryKeyNames = new Set(entries.map(([column]) => column));
  const restoreColumns = Object.keys(change.originalRow)
    .filter((column) => !primaryKeyNames.has(column));
  if (restoreColumns.length === 0) return unchangedStatement(change);
  const predicate = entries
    .map(([column]) => `target.${quoteIdentifier(column)} = ?`)
    .join(" AND ");
  return {
    sql: `WITH original AS (
            SELECT *
              FROM jsonb_populate_record(
                NULL::${quoteIdentifier(change.tableName)},
                ?::jsonb
              )
          ), restored AS (
            UPDATE ${quoteIdentifier(change.tableName)} AS target
               SET ${restoreColumns
                 .map((column) => `${quoteIdentifier(column)} = original.${quoteIdentifier(column)}`)
                 .join(", ")}
              FROM original
             WHERE ${predicate}
               AND to_jsonb(target) = ?::jsonb
            RETURNING 1
          ), already_restored AS (
            SELECT 1
              FROM ${quoteIdentifier(change.tableName)} AS target
             WHERE ${predicate}
               AND to_jsonb(target) = ?::jsonb
          )
          UPDATE sqlite_postgres_migration_row_changes
             SET "rollbackStatus" = 'rolled_back',
                 "rollbackAttempts" = "rollbackAttempts" + 1,
                 "lastError" = NULL,
                 "rolledBackAt" = CURRENT_TIMESTAMP,
                 "updatedAt" = CURRENT_TIMESTAMP
           WHERE "runId" = ? AND "tableName" = ? AND "primaryKeyHash" = ?
             AND "rollbackStatus" = 'planned'
             AND (EXISTS (SELECT 1 FROM restored)
               OR EXISTS (SELECT 1 FROM already_restored))`,
    params: [
      JSON.stringify(change.originalRow),
      ...entries.map(([, value]) => value),
      JSON.stringify(change.migratedRow),
      ...entries.map(([, value]) => value),
      JSON.stringify(change.originalRow),
      change.runId,
      change.tableName,
      change.primaryKeyHash,
    ],
    requireChanges: 1,
  };
}

function rollbackStatement(change: RowChange): DbStatement {
  if (change.changeKind === "inserted") return insertedStatement(change);
  if (change.changeKind === "updated") return updatedStatement(change);
  return unchangedStatement(change);
}

async function loadCurrentRows(
  adapter: DatabaseAdapter,
  tableName: string,
  changes: RowChange[],
  batchSize: number,
): Promise<Map<string, Record<string, unknown>>> {
  const current = new Map<string, Record<string, unknown>>();
  for (let offset = 0; offset < changes.length; offset += batchSize) {
    const batch = changes.slice(offset, offset + batchSize);
    if (batch.length === 0) continue;
    const params: unknown[] = [];
    const predicates = batch.map((change) => {
      const entries = primaryKeyEntries(change);
      params.push(...entries.map(([, value]) => value));
      return `(${entries
        .map(([column]) => `target.${quoteIdentifier(column)} = ?`)
        .join(" AND ")})`;
    });
    const rows = await adapter.queryMany<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(target) AS row
         FROM ${quoteIdentifier(tableName)} AS target
        WHERE ${predicates.join(" OR ")}`,
      params,
    );
    const primaryKeyNames = Object.keys(batch[0].primaryKey || {});
    for (const entry of rows) {
      const primaryKey = Object.fromEntries(
        primaryKeyNames.map((column) => [column, entry.row[column]]),
      );
      current.set(sha256(primaryKey), entry.row);
    }
  }
  return current;
}

export function createSqlitePostgresRollbackRuntime(
  adapter: DatabaseAdapter,
  options: SqlitePostgresRollbackRuntimeOptions = {},
) {
  const repository = options.repository || createSqlitePostgresMigrationRepository(adapter);
  const batchSize = Math.max(1, Math.min(2_000, Math.trunc(
    options.batchSize ?? DEFAULT_BATCH_SIZE,
  )));

  async function buildReport(
    snapshot: SqlitePostgresMigrationSnapshot,
  ): Promise<SqlitePostgresRollbackReport> {
    const tables: SqlitePostgresRollbackTableReport[] = [];
    const failures: SqlitePostgresRollbackReport["failures"] = [];
    const ordered = [...snapshot.tables]
      .sort((left, right) => right.dependencyOrder - left.dependencyOrder
        || right.tableName.localeCompare(left.tableName));
    for (const table of ordered) {
      const changes = await adapter.queryMany<RowChange>(
        `SELECT *
           FROM sqlite_postgres_migration_row_changes
          WHERE "runId" = ? AND "tableName" = ?
          ORDER BY "batchSequence" DESC, "primaryKeyHash"`,
        [snapshot.run.id, table.tableName],
      );
      const currentRows = await loadCurrentRows(adapter, table.tableName, changes, batchSize);
      let deletedRows = 0;
      let restoredRows = 0;
      let remainingTargetRows = 0;
      let concurrentConflicts = 0;
      for (const change of changes) {
        const current = currentRows.get(change.primaryKeyHash);
        if (change.changeKind === "inserted") {
          if (!current) deletedRows += 1;
          else if (change.rollbackStatus === "rolled_back") {
            remainingTargetRows += 1;
            concurrentConflicts += 1;
          }
        } else if (change.changeKind === "updated"
          && change.rollbackStatus === "rolled_back") {
          if (change.originalRow && stableJson(current) === stableJson(change.originalRow)) {
            restoredRows += 1;
          } else {
            concurrentConflicts += 1;
          }
        }
      }
      const rolledBackRows = changes.filter(
        (change) => change.rollbackStatus === "rolled_back",
      ).length;
      tables.push({
        tableName: table.tableName,
        trackedRows: changes.length,
        insertedRows: changes.filter((change) => change.changeKind === "inserted").length,
        updatedRows: changes.filter((change) => change.changeKind === "updated").length,
        unchangedRows: changes.filter((change) => change.changeKind === "unchanged").length,
        rolledBackRows,
        deletedRows,
        restoredRows,
        remainingTargetRows,
        concurrentConflicts,
      });
      if (remainingTargetRows > 0 || concurrentConflicts > 0) {
        failures.push({
          tableName: table.tableName,
          code: "SQLITE_PG_MIGRATION_ROLLBACK_STATE_MISMATCH",
          message: "回滚后的目标行状态与 run-owned 快照不一致",
        });
      }
    }
    const totalTrackedRows = tables.reduce((sum, table) => sum + table.trackedRows, 0);
    const totalRolledBackRows = tables.reduce((sum, table) => sum + table.rolledBackRows, 0);
    const pending = await adapter.queryOne<{ count: number | string }>(
      `SELECT COUNT(*)::bigint AS count
         FROM sqlite_postgres_migration_row_changes
        WHERE "runId" = ? AND "rollbackStatus" <> 'rolled_back'`,
      [snapshot.run.id],
    );
    const complete = numberValue(pending?.count) === 0 && failures.length === 0;
    return {
      generatedAt: new Date().toISOString(),
      ok: complete,
      complete,
      runId: snapshot.run.id,
      status: complete ? "rolled_back" : "rolling_back",
      totalTrackedRows,
      totalRolledBackRows,
      tables,
      failures,
    };
  }

  async function rollback(input: {
    runId: string;
    maxBatches?: number | null;
  }): Promise<SqlitePostgresRollbackReport> {
    let snapshot = await repository.getSnapshotByRunId(input.runId);
    if (snapshot.run.status === "rolled_back") return buildReport(snapshot);
    if (!["planned", "copying", "verifying", "completed", "failed", "rolling_back"].includes(
      snapshot.run.status,
    )) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_ROLLBACK_STATE_INVALID",
        "当前 migration run 状态不允许回滚",
        409,
        { status: snapshot.run.status },
      );
    }

    const tracked = await adapter.queryOne<{ count: number | string }>(
      `SELECT COUNT(*)::bigint AS count
         FROM sqlite_postgres_migration_row_changes
        WHERE "runId" = ?`,
      [snapshot.run.id],
    );
    if (numberValue(tracked?.count) === 0 && snapshot.run.copiedRows > 0) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_ROLLBACK_OWNERSHIP_MISSING",
        "该 migration run 存在已复制数据，但缺少 run-owned 主键记录，拒绝猜测恢复范围",
        409,
      );
    }
    const missingSnapshots = await adapter.queryOne<{ count: number | string }>(
      `SELECT COUNT(*)::bigint AS count
         FROM sqlite_postgres_migration_row_changes
        WHERE "runId" = ?
          AND "changeKind" IN ('inserted', 'updated')
          AND ("migratedRow" IS NULL
            OR ("changeKind" = 'updated' AND "originalRow" IS NULL))`,
      [snapshot.run.id],
    );
    if (numberValue(missingSnapshots?.count) > 0) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_ROLLBACK_SNAPSHOT_MISSING",
        "migration run 缺少并发安全 rollback 所需的完整行快照",
        409,
      );
    }

    await adapter.execute(
      `UPDATE sqlite_postgres_migration_runs
          SET status = 'rolling_back',
              "rollbackStartedAt" = COALESCE("rollbackStartedAt", CURRENT_TIMESTAMP),
              "currentTable" = NULL,
              "lastError" = NULL,
              "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [snapshot.run.id],
    );

    const remainingBatches = {
      value: input.maxBatches == null
        ? null
        : Math.max(1, Math.trunc(input.maxBatches)),
    };
    const ordered = [...snapshot.tables]
      .sort((left, right) => right.dependencyOrder - left.dependencyOrder
        || right.tableName.localeCompare(left.tableName));

    try {
      for (const table of ordered) {
        while (true) {
          const changes = await adapter.queryMany<RowChange>(
            `SELECT *
               FROM sqlite_postgres_migration_row_changes
              WHERE "runId" = ? AND "tableName" = ?
                AND "rollbackStatus" = 'planned'
              ORDER BY "batchSequence" DESC, "primaryKeyHash"
              LIMIT ?`,
            [snapshot.run.id, table.tableName, batchSize],
          );
          if (changes.length === 0) break;
          const statements = changes.map(rollbackStatement);
          statements.push({
            sql: `UPDATE sqlite_postgres_migration_runs
                     SET "currentTable" = ?, "updatedAt" = CURRENT_TIMESTAMP
                   WHERE id = ? AND status = 'rolling_back'`,
            params: [table.tableName, snapshot.run.id],
            requireChanges: 1,
          });
          try {
            await adapter.executeStatements(statements);
          } catch (error) {
            if (error instanceof DbStatementChangeError) {
              throw new SqlitePostgresMigrationError(
                "SQLITE_PG_MIGRATION_ROLLBACK_CONCURRENT_MODIFICATION",
                "目标行在迁移完成后发生变化，rollback 拒绝覆盖用户的新修改",
                409,
                { tableName: table.tableName },
              );
            }
            throw error;
          }
          if (remainingBatches.value != null) {
            remainingBatches.value -= 1;
            if (remainingBatches.value <= 0) {
              snapshot = await repository.getSnapshotByRunId(snapshot.run.id);
              const report = await buildReport(snapshot);
              await adapter.execute(
                `UPDATE sqlite_postgres_migration_runs
                    SET "rollbackReport" = ?::jsonb,
                        "currentTable" = NULL,
                        "updatedAt" = CURRENT_TIMESTAMP
                  WHERE id = ?`,
                [JSON.stringify(report), snapshot.run.id],
              );
              return report;
            }
          }
        }
      }

      snapshot = await repository.getSnapshotByRunId(snapshot.run.id);
      const report = await buildReport(snapshot);
      if (!report.complete) {
        throw new SqlitePostgresMigrationError(
          "SQLITE_PG_MIGRATION_ROLLBACK_VERIFY_FAILED",
          "rollback 后 run-owned 行恢复验证未通过",
          409,
          { failures: report.failures },
        );
      }
      await adapter.execute(
        `UPDATE sqlite_postgres_migration_runs
            SET status = 'rolled_back',
                "rollbackReport" = ?::jsonb,
                "currentTable" = NULL,
                "lastError" = NULL,
                "rolledBackAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [JSON.stringify(report), snapshot.run.id],
      );
      return { ...report, status: "rolled_back" };
    } catch (error) {
      const message = errorMessage(error).slice(0, 2_000);
      await adapter.execute(
        `UPDATE sqlite_postgres_migration_runs
            SET status = 'failed', "lastError" = ?,
                "currentTable" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [message, snapshot.run.id],
      );
      throw error;
    }
  }

  return { rollback, buildReport };
}
