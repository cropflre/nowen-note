import { createHash } from "node:crypto";

import type { DatabaseAdapter } from "../db/adapters/types";
import {
  inspectSqliteMigrationSource,
  type SqliteMigrationSourceSnapshot,
  type SqliteMigrationTable,
} from "../db/migration/sqliteMigrationSource";
import {
  createSqlitePostgresMigrationRepository,
  SqlitePostgresMigrationError,
  type SqlitePostgresMigrationSnapshot,
  type SqlitePostgresMigrationTablePlan,
} from "../repositories/sqlitePostgresMigrationRepository";

export type SqlitePostgresMigrationRisk = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type PostgresMigrationTargetTable = {
  name: string;
  rowCount: number;
};

export type PostgresMigrationTargetSnapshot = {
  schemaReady: boolean;
  migrationCount: number;
  latestMigration: string | null;
  targetWasEmpty: boolean;
  totalBusinessRows: number;
  tables: PostgresMigrationTargetTable[];
};

export type SqlitePostgresMigrationTablePlanEntry = SqlitePostgresMigrationTablePlan & {
  dependencies: string[];
};

export type SqlitePostgresMigrationDryRunReport = {
  generatedAt: string;
  canApply: boolean;
  source: SqliteMigrationSourceSnapshot;
  backup: {
    provided: boolean;
    verified: boolean;
    snapshot: SqliteMigrationSourceSnapshot | null;
  };
  target: PostgresMigrationTargetSnapshot;
  plan: {
    tables: SqlitePostgresMigrationTablePlanEntry[];
    totalTables: number;
    totalRows: number;
    deferredTables: string[];
    unsupportedTables: string[];
  };
  blockers: SqlitePostgresMigrationRisk[];
  warnings: SqlitePostgresMigrationRisk[];
};

export type SqlitePostgresMigrationRuntimeOptions = {
  repository?: ReturnType<typeof createSqlitePostgresMigrationRepository>;
  inspectSource?: typeof inspectSqliteMigrationSource;
};

const TARGET_METADATA_TABLES = new Set([
  "postgres_schema_migrations",
  "postgres_migration_state",
  "sqlite_postgres_migration_runs",
  "sqlite_postgres_migration_table_checkpoints",
  "sqlite_postgres_migration_batch_checkpoints",
]);

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_TABLE_NAME_INVALID",
      "迁移表名不安全",
      500,
    );
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
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

function backupMatches(
  source: SqliteMigrationSourceSnapshot,
  backup: SqliteMigrationSourceSnapshot,
): boolean {
  if (!backup.integrityOk || backup.foreignKeyViolationCount > 0) return false;
  if (source.schemaHash !== backup.schemaHash) return false;
  if (source.sourceSchemaVersion !== backup.sourceSchemaVersion) return false;
  if (source.totalRows !== backup.totalRows) return false;
  const sourceRows = new Map(source.tables.map((table) => [table.name, table.rowCount]));
  return backup.tables.length === source.tables.length
    && backup.tables.every((table) => sourceRows.get(table.name) === table.rowCount);
}

function orderTables(tables: SqliteMigrationTable[]): {
  ordered: SqliteMigrationTable[];
  cyclic: string[];
} {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const dependencies = new Map(
    tables.map((table) => [
      table.name,
      new Set(table.dependencies.filter((dependency) => byName.has(dependency))),
    ]),
  );
  const remaining = new Set(byName.keys());
  const ordered: SqliteMigrationTable[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) => [...(dependencies.get(name) || [])]
        .every((dependency) => !remaining.has(dependency)))
      .sort();
    if (ready.length === 0) break;
    for (const name of ready) {
      ordered.push(byName.get(name)!);
      remaining.delete(name);
    }
  }

  const cyclic = [...remaining].sort();
  for (const name of cyclic) ordered.push(byName.get(name)!);
  return { ordered, cyclic };
}

async function inspectPostgresTarget(
  adapter: DatabaseAdapter,
): Promise<PostgresMigrationTargetSnapshot> {
  const rows = await adapter.queryMany<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename`,
  );
  const tables: PostgresMigrationTargetTable[] = [];
  for (const row of rows) {
    const name = String(row.tablename || "");
    if (!name) continue;
    const count = await adapter.queryOne<{ count: number | string }>(
      `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(name)}`,
    );
    tables.push({
      name,
      rowCount: Number(count?.count ?? 0),
    });
  }
  const migrationRows = tables.some((table) => table.name === "postgres_schema_migrations")
    ? await adapter.queryMany<{ version: string }>(
      `SELECT version
         FROM postgres_schema_migrations
        ORDER BY version`,
    )
    : [];
  const businessTables = tables.filter((table) => !TARGET_METADATA_TABLES.has(table.name));
  const totalBusinessRows = businessTables.reduce(
    (sum, table) => sum + table.rowCount,
    0,
  );

  return {
    schemaReady: tables.length > 0 && migrationRows.length > 0,
    migrationCount: migrationRows.length,
    latestMigration: migrationRows.at(-1)?.version ?? null,
    targetWasEmpty: totalBusinessRows === 0,
    totalBusinessRows,
    tables,
  };
}

export function createSqlitePostgresMigrationRuntime(
  adapter: DatabaseAdapter,
  options: SqlitePostgresMigrationRuntimeOptions = {},
) {
  const repository = options.repository
    || createSqlitePostgresMigrationRepository(adapter);
  const inspectSource = options.inspectSource || inspectSqliteMigrationSource;

  async function dryRun(input: {
    sourcePath: string;
    backupPath?: string | null;
    allowNonEmptyTarget?: boolean;
  }): Promise<SqlitePostgresMigrationDryRunReport> {
    const source = inspectSource(input.sourcePath);
    const backup = input.backupPath ? inspectSource(input.backupPath) : null;
    const target = await inspectPostgresTarget(adapter);
    const blockers: SqlitePostgresMigrationRisk[] = [];
    const warnings: SqlitePostgresMigrationRisk[] = [];

    if (!source.integrityOk) {
      blockers.push({
        code: "SQLITE_SOURCE_INTEGRITY_FAILED",
        message: "源 SQLite 数据库完整性检查未通过",
        details: { messages: source.integrityMessages },
      });
    }
    if (source.foreignKeyViolationCount > 0) {
      blockers.push({
        code: "SQLITE_SOURCE_FOREIGN_KEY_VIOLATIONS",
        message: "源 SQLite 数据库存在外键孤儿记录",
        details: {
          count: source.foreignKeyViolationCount,
          tables: source.foreignKeyViolationTables,
        },
      });
    }
    if (source.tables.length === 0) {
      blockers.push({
        code: "SQLITE_SOURCE_HAS_NO_BUSINESS_TABLES",
        message: "源 SQLite 数据库没有可迁移的业务表",
      });
    }
    if (!target.schemaReady) {
      blockers.push({
        code: "POSTGRES_TARGET_SCHEMA_NOT_READY",
        message: "目标 PostgreSQL 尚未完成 schema bootstrap 与版本化迁移",
      });
    }
    if (!target.targetWasEmpty && !input.allowNonEmptyTarget) {
      blockers.push({
        code: "POSTGRES_TARGET_NOT_EMPTY",
        message: "目标 PostgreSQL 含有业务数据；默认禁止覆盖非空目标库",
        details: { totalBusinessRows: target.totalBusinessRows },
      });
    }
    if (!backup) {
      blockers.push({
        code: "SQLITE_BACKUP_REQUIRED",
        message: "正式迁移前必须提供并验证 SQLite 全量备份",
      });
    } else if (!backupMatches(source, backup)) {
      blockers.push({
        code: "SQLITE_BACKUP_MISMATCH",
        message: "SQLite 备份与源库的 schema 或逐表行数不一致",
      });
    }

    if (source.walPresent && source.walSize > 0) {
      warnings.push({
        code: "SQLITE_WAL_PRESENT",
        message: "源数据库存在非空 WAL；正式执行前应先生成一致性快照",
        details: { walSize: source.walSize },
      });
    }
    if (input.allowNonEmptyTarget && !target.targetWasEmpty) {
      warnings.push({
        code: "POSTGRES_NON_EMPTY_OVERRIDE",
        message: "已显式允许非空目标库；后续写入必须使用幂等 upsert 与冲突报告",
        details: { totalBusinessRows: target.totalBusinessRows },
      });
    }
    if (source.excludedTables.length > 0) {
      warnings.push({
        code: "SQLITE_DEFERRED_INDEX_TABLES",
        message: "FTS、向量及 SQLite 内部表不会在数据复制阶段直接迁移",
        details: { tables: source.excludedTables },
      });
    }

    const targetNames = new Set(target.tables.map((table) => table.name));
    const unsupportedTables = source.tables
      .filter((table) => !targetNames.has(table.name))
      .map((table) => table.name)
      .sort();
    if (unsupportedTables.length > 0) {
      blockers.push({
        code: "POSTGRES_TARGET_TABLES_MISSING",
        message: "目标 PostgreSQL 缺少源库业务表",
        details: { tables: unsupportedTables },
      });
    }

    const migratable = source.tables.filter((table) => targetNames.has(table.name));
    const { ordered, cyclic } = orderTables(migratable);
    if (cyclic.length > 0) {
      warnings.push({
        code: "SQLITE_FOREIGN_KEY_CYCLE",
        message: "检测到循环外键；执行器需在延迟约束事务中处理这些表",
        details: { tables: cyclic },
      });
    }
    const tablePlan = ordered.map((table, dependencyOrder) => ({
      tableName: table.name,
      dependencyOrder,
      primaryKeyColumns: table.primaryKeyColumns,
      totalRows: table.rowCount,
      dependencies: table.dependencies.filter((dependency) => targetNames.has(dependency)),
    }));

    return {
      generatedAt: new Date().toISOString(),
      canApply: blockers.length === 0,
      source,
      backup: {
        provided: Boolean(backup),
        verified: Boolean(backup && backupMatches(source, backup)),
        snapshot: backup,
      },
      target,
      plan: {
        tables: tablePlan,
        totalTables: tablePlan.length,
        totalRows: tablePlan.reduce((sum, table) => sum + table.totalRows, 0),
        deferredTables: source.excludedTables,
        unsupportedTables,
      },
      blockers,
      warnings,
    };
  }

  return {
    dryRun,

    async prepareApply(input: {
      idempotencyKey: string;
      sourcePath: string;
      backupPath: string;
      allowNonEmptyTarget?: boolean;
    }): Promise<{
      report: SqlitePostgresMigrationDryRunReport;
      snapshot: SqlitePostgresMigrationSnapshot;
      reused: boolean;
    }> {
      const report = await dryRun(input);
      if (!report.canApply) {
        throw new SqlitePostgresMigrationError(
          "SQLITE_PG_MIGRATION_PREFLIGHT_BLOCKED",
          "SQLite → PostgreSQL 迁移预检未通过",
          409,
          {
            blockers: report.blockers.map((blocker) => blocker.code),
          },
        );
      }

      const requestHash = sha256({
        sourceFingerprint: report.source.sourceFingerprint,
        backupFingerprint: report.backup.snapshot?.sourceFingerprint ?? null,
        targetLatestMigration: report.target.latestMigration,
        targetWasEmpty: report.target.targetWasEmpty,
        allowNonEmptyTarget: Boolean(input.allowNonEmptyTarget),
        tables: report.plan.tables,
      });
      const created = await repository.createPlannedRun({
        idempotencyKey: input.idempotencyKey,
        requestHash,
        sourceFingerprint: report.source.sourceFingerprint,
        sourcePathHint: report.source.sourcePathHint,
        sourceSchemaVersion: report.source.sourceSchemaVersion,
        sourceFileSize: report.source.fileSize,
        sourceModifiedAt: report.source.modifiedAt,
        sourceSnapshot: report.source as unknown as Record<string, unknown>,
        plan: report.plan as unknown as Record<string, unknown>,
        targetWasEmpty: report.target.targetWasEmpty,
        allowNonEmptyTarget: Boolean(input.allowNonEmptyTarget),
        tables: report.plan.tables,
      });

      return {
        report,
        snapshot: created.snapshot,
        reused: created.reused,
      };
    },

    getStatus(runId: string): Promise<SqlitePostgresMigrationSnapshot> {
      return repository.getSnapshotByRunId(runId);
    },
  };
}
