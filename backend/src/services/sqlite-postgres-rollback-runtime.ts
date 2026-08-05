import type { DatabaseAdapter, DbStatement } from "../db/adapters/types";
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
  changeKind: "inserted" | "updated";
  rollbackStatus: "planned" | "rolled_back" | "failed";
};

export type SqlitePostgresRollbackTableReport = {
  tableName: string;
  trackedRows: number;
  rolledBackRows: number;
  remainingTargetRows: number;
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

function errorMessage(error: unknown): string {
  if (error instanceof SqlitePostgresMigrationError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function deleteStatement(change: RowChange): DbStatement {
  const entries = Object.entries(change.primaryKey || {});
  if (entries.length === 0) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_ROLLBACK_PRIMARY_KEY_MISSING",
      "run-owned 写入记录缺少主键",
      500,
      { tableName: change.tableName },
    );
  }
  return {
    sql: `DELETE FROM ${quoteIdentifier(change.tableName)}
           WHERE ${entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(" AND ")}`,
    params: entries.map(([, value]) => value),
  };
}

function markRolledBackStatement(change: RowChange): DbStatement {
  return {
    sql: `UPDATE sqlite_postgres_migration_row_changes
             SET "rollbackStatus" = 'rolled_back',
                 "rollbackAttempts" = "rollbackAttempts" + 1,
                 "lastError" = NULL,
                 "rolledBackAt" = CURRENT_TIMESTAMP,
                 "updatedAt" = CURRENT_TIMESTAMP
           WHERE "runId" = ? AND "tableName" = ? AND "primaryKeyHash" = ?
             AND "rollbackStatus" = 'planned'`,
    params: [change.runId, change.tableName, change.primaryKeyHash],
    requireChanges: 1,
  };
}

async function countTrackedTargetRows(
  adapter: DatabaseAdapter,
  tableName: string,
  changes: RowChange[],
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (let offset = 0; offset < changes.length; offset += batchSize) {
    const batch = changes.slice(offset, offset + batchSize);
    if (batch.length === 0) continue;
    const params: unknown[] = [];
    const predicates = batch.map((change) => {
      const entries = Object.entries(change.primaryKey || {});
      if (entries.length === 0) {
        throw new SqlitePostgresMigrationError(
          "SQLITE_PG_MIGRATION_ROLLBACK_PRIMARY_KEY_MISSING",
          "run-owned 写入记录缺少主键",
          500,
          { tableName },
        );
      }
      params.push(...entries.map(([, value]) => value));
      return `(${entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(" AND ")})`;
    });
    const row = await adapter.queryOne<{ count: number | string }>(
      `SELECT COUNT(*)::bigint AS count
         FROM ${quoteIdentifier(tableName)}
        WHERE ${predicates.join(" OR ")}`,
      params,
    );
    total += numberValue(row?.count);
  }
  return total;
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
      const remainingTargetRows = await countTrackedTargetRows(
        adapter,
        table.tableName,
        changes,
        batchSize,
      );
      const rolledBackRows = changes.filter(
        (change) => change.rollbackStatus === "rolled_back",
      ).length;
      tables.push({
        tableName: table.tableName,
        trackedRows: changes.length,
        rolledBackRows,
        remainingTargetRows,
      });
      if (remainingTargetRows > 0) {
        failures.push({
          tableName: table.tableName,
          code: "SQLITE_PG_MIGRATION_ROLLBACK_ROWS_REMAIN",
          message: "回滚后仍存在本次 migration run 拥有的目标行",
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
    if (!snapshot.run.targetWasEmpty) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_NON_EMPTY_ROLLBACK_NOT_ENABLED",
        "当前 rollback 仅支持迁移前为空的 PostgreSQL 目标库",
        409,
      );
    }
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

    const tracked = await adapter.queryOne<{
      count: number | string;
      updatedCount: number | string;
    }>(
      `SELECT COUNT(*)::bigint AS count,
              COUNT(*) FILTER (WHERE "changeKind" = 'updated')::bigint AS "updatedCount"
         FROM sqlite_postgres_migration_row_changes
        WHERE "runId" = ?`,
      [snapshot.run.id],
    );
    if (numberValue(tracked?.updatedCount) > 0) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_UPDATED_ROW_ROLLBACK_NOT_ENABLED",
        "当前切片尚未开放覆盖更新记录的原值恢复",
        409,
      );
    }
    if (numberValue(tracked?.count) === 0 && snapshot.run.copiedRows > 0) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_ROLLBACK_OWNERSHIP_MISSING",
        "该 migration run 存在已复制数据，但缺少 run-owned 主键记录，拒绝猜测删除范围",
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
          const statements: DbStatement[] = [];
          for (const change of changes) {
            statements.push(deleteStatement(change));
            statements.push(markRolledBackStatement(change));
          }
          statements.push({
            sql: `UPDATE sqlite_postgres_migration_runs
                     SET "currentTable" = ?, "updatedAt" = CURRENT_TIMESTAMP
                   WHERE id = ? AND status = 'rolling_back'`,
            params: [table.tableName, snapshot.run.id],
            requireChanges: 1,
          });
          await adapter.executeStatements(statements);
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
          "rollback 后 run-owned 行清理验证未通过",
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
