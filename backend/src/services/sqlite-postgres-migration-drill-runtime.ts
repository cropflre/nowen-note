import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import type { DatabaseAdapter } from "../db/adapters/types";
import {
  createSqlitePostgresMigrationDrillRepository,
  type SqlitePostgresForeignKeyViolation,
} from "../repositories/sqlitePostgresMigrationDrillRepository";
import {
  createSqlitePostgresMigrationRuntime,
  type SqlitePostgresConflictPolicy,
} from "./sqlite-postgres-migration-runtime";
import {
  createSqlitePostgresRollbackRuntime,
  type SqlitePostgresRollbackReport,
} from "./sqlite-postgres-rollback-runtime";

export type SqlitePostgresDrillTableValidation = {
  tableName: string;
  trackedRows: number;
  expectedRows: number;
  currentRows: number;
  primaryKeySetMatched: boolean;
  rowCountMatched: boolean;
  checksumMatched: boolean;
  expectedChecksum: string;
  currentChecksum: string;
  mismatches: number;
};

export type SqlitePostgresDrillPostRollbackValidation = {
  ok: boolean;
  tables: SqlitePostgresDrillTableValidation[];
  foreignKeyViolations: SqlitePostgresForeignKeyViolation[];
};

export type SqlitePostgresMigrationDrillReport = {
  schemaVersion: 1;
  generatedAt: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ok: boolean;
  runId: string;
  idempotencyKey: string;
  scenario: "empty-target" | "non-empty-target";
  source: {
    sourcePathHint: string;
    backupPathHint: string;
    sourceFileSize: number;
    backupFileSize: number;
    totalTables: number;
    totalRows: number;
  };
  execution: {
    batchSize: number;
    maxBatchesPerPass: number | null;
    maxRollbackBatchesPerPass: number | null;
    applyPasses: number;
    rollbackPasses: number;
    conflictPolicy: SqlitePostgresConflictPolicy;
  };
  stages: {
    apply: {
      status: string;
      attempts: number;
      completedTables: number;
      totalTables: number;
      copiedRows: number;
      verifiedRows: number;
    };
    verify: Awaited<ReturnType<ReturnType<typeof createSqlitePostgresMigrationRuntime>["verify"]>>;
    rollback: SqlitePostgresRollbackReport;
    postRollback: SqlitePostgresDrillPostRollbackValidation;
  };
  summary: {
    inserted: number;
    updated: number;
    unchanged: number;
    rolledBack: number;
    deleted: number;
    restored: number;
    concurrentConflicts: number;
    failures: number;
  };
  requirements: {
    sourceReadOnly: true;
    backupReadOnly: true;
    keepBackupUntil: string;
    recommendedFreeBytes: number;
  };
  warnings: string[];
};

export type SqlitePostgresMigrationDrillRuntimeOptions = {
  migration?: ReturnType<typeof createSqlitePostgresMigrationRuntime>;
  rollback?: ReturnType<typeof createSqlitePostgresRollbackRuntime>;
  drillRepository?: ReturnType<typeof createSqlitePostgresMigrationDrillRepository>;
};

function stableJson(value: unknown): string {
  if (value == null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function pathHint(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "database.db";
}

function checksumRows(rows: Array<{ primaryKeyHash: string; row: Record<string, unknown> }>): string {
  return sha256(rows
    .sort((left, right) => left.primaryKeyHash.localeCompare(right.primaryKeyHash))
    .map((entry) => `${entry.primaryKeyHash}:${stableJson(entry.row)}`)
    .join("\n"));
}

export function createSqlitePostgresMigrationDrillRuntime(
  adapter: DatabaseAdapter,
  options: SqlitePostgresMigrationDrillRuntimeOptions = {},
) {
  const migration = options.migration || createSqlitePostgresMigrationRuntime(adapter);
  const rollback = options.rollback || createSqlitePostgresRollbackRuntime(adapter);
  const drillRepository = options.drillRepository
    || createSqlitePostgresMigrationDrillRepository(adapter);

  async function validatePostRollback(input: {
    runId: string;
    tables: Array<{ tableName: string }>;
    batchSize: number;
  }): Promise<SqlitePostgresDrillPostRollbackValidation> {
    const tables: SqlitePostgresDrillTableValidation[] = [];
    for (const table of input.tables) {
      const changes = await drillRepository.listRowChanges({
        runId: input.runId,
        tableName: table.tableName,
      });
      const current = await drillRepository.loadCurrentRows({
        tableName: table.tableName,
        changes,
        batchSize: input.batchSize,
      });
      const expected = changes
        .filter((change) => change.changeKind !== "inserted" && change.originalRow)
        .map((change) => ({
          primaryKeyHash: change.primaryKeyHash,
          row: change.originalRow!,
        }));
      const actual = [...current].map(([primaryKeyHash, row]) => ({ primaryKeyHash, row }));
      let mismatches = 0;
      for (const change of changes) {
        const row = current.get(change.primaryKeyHash);
        if (change.changeKind === "inserted") {
          if (row) mismatches += 1;
          continue;
        }
        if (!change.originalRow || stableJson(row) !== stableJson(change.originalRow)) {
          mismatches += 1;
        }
      }
      const expectedChecksum = checksumRows(expected);
      const currentChecksum = checksumRows(actual);
      const primaryKeySetMatched = changes.every((change) => (
        change.changeKind === "inserted"
          ? !current.has(change.primaryKeyHash)
          : current.has(change.primaryKeyHash)
      ));
      const rowCountMatched = current.size === expected.length;
      const checksumMatched = expectedChecksum === currentChecksum;
      tables.push({
        tableName: table.tableName,
        trackedRows: changes.length,
        expectedRows: expected.length,
        currentRows: current.size,
        primaryKeySetMatched,
        rowCountMatched,
        checksumMatched,
        expectedChecksum,
        currentChecksum,
        mismatches,
      });
    }
    const foreignKeyViolations = await drillRepository.inspectForeignKeyViolations();
    return {
      ok: tables.every((table) => table.primaryKeySetMatched
        && table.rowCountMatched
        && table.checksumMatched
        && table.mismatches === 0)
        && foreignKeyViolations.length === 0,
      tables,
      foreignKeyViolations,
    };
  }

  return {
    async run(input: {
      idempotencyKey: string;
      sourcePath: string;
      backupPath: string;
      allowNonEmptyTarget?: boolean;
      conflictPolicy?: SqlitePostgresConflictPolicy;
      batchSize?: number;
      maxBatchesPerPass?: number | null;
      maxRollbackBatchesPerPass?: number | null;
    }): Promise<SqlitePostgresMigrationDrillReport> {
      const startedAt = new Date();
      const batchSize = Math.max(1, Math.min(2_000, Math.trunc(input.batchSize ?? 200)));
      const conflictPolicy = input.conflictPolicy || "abort";
      let applyPasses = 0;
      let applyResult: Awaited<ReturnType<typeof migration.apply>>;
      do {
        applyPasses += 1;
        applyResult = await migration.apply({
          idempotencyKey: input.idempotencyKey,
          sourcePath: input.sourcePath,
          backupPath: input.backupPath,
          allowNonEmptyTarget: input.allowNonEmptyTarget,
          conflictPolicy,
          batchSize,
          maxBatches: input.maxBatchesPerPass,
        });
        if (applyPasses > 10_000) {
          throw new Error("SQLite → PostgreSQL drill exceeded 10,000 apply passes.");
        }
      } while (applyResult.snapshot.run.status !== "completed");

      const verify = await migration.verify({
        idempotencyKey: input.idempotencyKey,
        backupPath: input.backupPath,
      });

      let rollbackPasses = 0;
      let rollbackReport: SqlitePostgresRollbackReport;
      do {
        rollbackPasses += 1;
        rollbackReport = await rollback.rollback({
          runId: applyResult.snapshot.run.id,
          maxBatches: input.maxRollbackBatchesPerPass,
        });
        if (rollbackPasses > 10_000) {
          throw new Error("SQLite → PostgreSQL drill exceeded 10,000 rollback passes.");
        }
      } while (!rollbackReport.complete);

      const postRollback = await validatePostRollback({
        runId: applyResult.snapshot.run.id,
        tables: applyResult.snapshot.tables,
        batchSize,
      });
      const completedAt = new Date();
      const inserted = rollbackReport.tables.reduce((sum, table) => sum + table.insertedRows, 0);
      const updated = rollbackReport.tables.reduce((sum, table) => sum + table.updatedRows, 0);
      const unchanged = rollbackReport.tables.reduce((sum, table) => sum + table.unchangedRows, 0);
      const deleted = rollbackReport.tables.reduce((sum, table) => sum + table.deletedRows, 0);
      const restored = rollbackReport.tables.reduce((sum, table) => sum + table.restoredRows, 0);
      const concurrentConflicts = rollbackReport.tables.reduce(
        (sum, table) => sum + table.concurrentConflicts,
        0,
      );
      const sourceFileSize = statSync(input.sourcePath).size;
      const backupFileSize = statSync(input.backupPath).size;
      const report: SqlitePostgresMigrationDrillReport = {
        schemaVersion: 1,
        generatedAt: completedAt.toISOString(),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        ok: applyResult.snapshot.run.status === "completed"
          && verify.ok
          && rollbackReport.complete
          && postRollback.ok,
        runId: applyResult.snapshot.run.id,
        idempotencyKey: input.idempotencyKey,
        scenario: applyResult.snapshot.run.targetWasEmpty ? "empty-target" : "non-empty-target",
        source: {
          sourcePathHint: pathHint(input.sourcePath),
          backupPathHint: pathHint(input.backupPath),
          sourceFileSize,
          backupFileSize,
          totalTables: applyResult.snapshot.run.totalTables,
          totalRows: applyResult.snapshot.run.totalRows,
        },
        execution: {
          batchSize,
          maxBatchesPerPass: input.maxBatchesPerPass == null
            ? null
            : Math.max(1, Math.trunc(input.maxBatchesPerPass)),
          maxRollbackBatchesPerPass: input.maxRollbackBatchesPerPass == null
            ? null
            : Math.max(1, Math.trunc(input.maxRollbackBatchesPerPass)),
          applyPasses,
          rollbackPasses,
          conflictPolicy,
        },
        stages: {
          apply: {
            status: applyResult.snapshot.run.status,
            attempts: applyResult.snapshot.run.attempts,
            completedTables: applyResult.snapshot.run.completedTables,
            totalTables: applyResult.snapshot.run.totalTables,
            copiedRows: applyResult.snapshot.run.copiedRows,
            verifiedRows: applyResult.snapshot.run.verifiedRows,
          },
          verify,
          rollback: rollbackReport,
          postRollback,
        },
        summary: {
          inserted,
          updated,
          unchanged,
          rolledBack: rollbackReport.totalRolledBackRows,
          deleted,
          restored,
          concurrentConflicts,
          failures: verify.failures.length
            + rollbackReport.failures.length
            + postRollback.tables.reduce((sum, table) => sum + table.mismatches, 0)
            + postRollback.foreignKeyViolations.length,
        },
        requirements: {
          sourceReadOnly: true,
          backupReadOnly: true,
          keepBackupUntil: "migration verified, rollback window closed, and PostgreSQL backup verified",
          recommendedFreeBytes: Math.ceil((sourceFileSize + backupFileSize) * 3),
        },
        warnings: applyResult.report?.warnings.map((warning) => warning.code) || [],
      };
      await drillRepository.saveFinalReport({
        runId: report.runId,
        report: report as unknown as Record<string, unknown>,
      });
      return report;
    },
  };
}
