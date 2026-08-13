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
import {
  createSqlitePostgresCopyRuntime,
  type SqlitePostgresCopyVerificationReport,
} from "./sqlite-postgres-copy-runtime";

export type SqlitePostgresConflictPolicy = "abort" | "overwrite-with-backup";

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
    execution: {
      batchSize: number;
      source: "verified-backup";
      writes: "transactional-upsert-checkpoint";
      conflictPolicy: SqlitePostgresConflictPolicy;
    };
  };
  blockers: SqlitePostgresMigrationRisk[];
  warnings: SqlitePostgresMigrationRisk[];
};

export type SqlitePostgresMigrationRuntimeOptions = {
  repository?: ReturnType<typeof createSqlitePostgresMigrationRepository>;
  copy?: ReturnType<typeof createSqlitePostgresCopyRuntime>;
  inspectSource?: typeof inspectSqliteMigrationSource;
};

const TARGET_METADATA_TABLES = new Set([
  "postgres_schema_migrations",
  "postgres_migration_state",
  "sqlite_postgres_migration_runs",
  "sqlite_postgres_migration_table_checkpoints",
  "sqlite_postgres_migration_batch_checkpoints",
  "sqlite_postgres_migration_row_changes",
]);

const DEFAULT_BATCH_SIZE = 200;

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

function normalizeBatchSize(value: number | undefined): number {
  return Math.max(1, Math.min(2_000, Math.trunc(value ?? DEFAULT_BATCH_SIZE)));
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
  selfReferential: string[];
} {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const selfReferential = tables
    .filter((table) => table.dependencies.includes(table.name))
    .map((table) => table.name)
    .sort();
  const dependencies = new Map(
    tables.map((table) => [
      table.name,
      new Set(table.dependencies.filter(
        (dependency) => dependency !== table.name && byName.has(dependency),
      )),
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
  return { ordered, cyclic, selfReferential };
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
  const copy = options.copy || createSqlitePostgresCopyRuntime(adapter, { repository });

  async function dryRun(input: {
    sourcePath: string;
    backupPath?: string | null;
    allowNonEmptyTarget?: boolean;
    conflictPolicy?: SqlitePostgresConflictPolicy;
    batchSize?: number;
  }): Promise<SqlitePostgresMigrationDryRunReport> {
    const source = inspectSource(input.sourcePath);
    const backup = input.backupPath ? inspectSource(input.backupPath) : null;
    const target = await inspectPostgresTarget(adapter);
    const blockers: SqlitePostgresMigrationRisk[] = [];
    const warnings: SqlitePostgresMigrationRisk[] = [];
    const batchSize = normalizeBatchSize(input.batchSize);
    const conflictPolicy = input.conflictPolicy || "abort";

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
    } else if (!target.targetWasEmpty && conflictPolicy !== "overwrite-with-backup") {
      blockers.push({
        code: "POSTGRES_NON_EMPTY_CONFLICT_POLICY_REQUIRED",
        message: "非空目标迁移必须显式选择 overwrite-with-backup 冲突策略",
        details: { conflictPolicy },
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
        message: "源数据库存在非空 WAL；正式执行将只读取已验证的冻结备份",
        details: { walSize: source.walSize },
      });
    }
    if (input.allowNonEmptyTarget && !target.targetWasEmpty
      && conflictPolicy === "overwrite-with-backup") {
      warnings.push({
        code: "POSTGRES_NON_EMPTY_OVERWRITE_WITH_BACKUP",
        message: "已启用非空目标覆盖；updated 行会保存完整原值快照并受并发修改保护",
        details: { totalBusinessRows: target.totalBusinessRows, conflictPolicy },
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
    const withoutPrimaryKey = migratable
      .filter((table) => table.primaryKeyColumns.length === 0)
      .map((table) => table.name)
      .sort();
    if (withoutPrimaryKey.length > 0) {
      blockers.push({
        code: "SQLITE_PRIMARY_KEY_REQUIRED",
        message: "实际复制要求每个业务表具备稳定主键游标",
        details: { tables: withoutPrimaryKey },
      });
    }

    const { ordered, cyclic, selfReferential } = orderTables(migratable);
    if (cyclic.length > 0) {
      blockers.push({
        code: "SQLITE_FOREIGN_KEY_CYCLE_UNSUPPORTED",
        message: "检测到跨表循环外键，当前安全执行器不会绕过 PostgreSQL 约束",
        details: { tables: cyclic },
      });
    }
    if (selfReferential.length > 0) {
      warnings.push({
        code: "SQLITE_SELF_REFERENTIAL_TABLES",
        message: "自引用外键将在行复制后以幂等修复批次恢复",
        details: { tables: selfReferential },
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
        execution: {
          batchSize,
          source: "verified-backup",
          writes: "transactional-upsert-checkpoint",
          conflictPolicy,
        },
      },
      blockers,
      warnings,
    };
  }

  async function prepareApply(input: {
    idempotencyKey: string;
    sourcePath: string;
    backupPath: string;
    allowNonEmptyTarget?: boolean;
    conflictPolicy?: SqlitePostgresConflictPolicy;
    batchSize?: number;
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
      execution: report.plan.execution,
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
  }

  return {
    dryRun,
    prepareApply,

    async apply(input: {
      idempotencyKey: string;
      sourcePath: string;
      backupPath: string;
      allowNonEmptyTarget?: boolean;
      conflictPolicy?: SqlitePostgresConflictPolicy;
      batchSize?: number;
      maxBatches?: number | null;
    }): Promise<{
      report: SqlitePostgresMigrationDryRunReport | null;
      snapshot: SqlitePostgresMigrationSnapshot;
      reused: boolean;
    }> {
      let prepared: Awaited<ReturnType<typeof prepareApply>> | null = null;
      let existing: SqlitePostgresMigrationSnapshot | null = null;
      try {
        existing = await repository.getSnapshotByIdempotencyKey(input.idempotencyKey);
      } catch (error) {
        if (!(error instanceof SqlitePostgresMigrationError)
          || error.code !== "SQLITE_PG_MIGRATION_RUN_NOT_FOUND") {
          throw error;
        }
      }
      if (!existing) {
        prepared = await prepareApply(input);
        existing = prepared.snapshot;
      }
      const snapshot = await copy.apply({
        runId: existing.run.id,
        snapshotPath: input.backupPath,
        maxBatches: input.maxBatches,
      });
      return {
        report: prepared?.report ?? null,
        snapshot,
        reused: prepared?.reused ?? true,
      };
    },

    async verify(input: {
      idempotencyKey: string;
      backupPath: string;
    }): Promise<SqlitePostgresCopyVerificationReport> {
      const snapshot = await repository.getSnapshotByIdempotencyKey(input.idempotencyKey);
      return copy.verify({
        runId: snapshot.run.id,
        snapshotPath: input.backupPath,
      });
    },

    getStatus(runId: string): Promise<SqlitePostgresMigrationSnapshot> {
      return repository.getSnapshotByRunId(runId);
    },

    getStatusByIdempotencyKey(
      idempotencyKey: string,
    ): Promise<SqlitePostgresMigrationSnapshot> {
      return repository.getSnapshotByIdempotencyKey(idempotencyKey);
    },
  };
}
