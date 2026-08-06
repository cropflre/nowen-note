import { createHash } from "node:crypto";

import type { DatabaseAdapter } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";
import { SqlitePostgresMigrationError } from "./sqlitePostgresMigrationRepository";

export type SqlitePostgresDrillRowChange = {
  runId: string;
  tableName: string;
  primaryKey: Record<string, unknown>;
  primaryKeyHash: string;
  changeKind: "inserted" | "updated" | "unchanged";
  originalRow: Record<string, unknown> | null;
  migratedRow: Record<string, unknown> | null;
  rollbackStatus: "planned" | "rolled_back" | "failed";
};

export type SqlitePostgresForeignKeyViolation = {
  constraintName: string;
  childTable: string;
  parentTable: string;
  childColumns: string[];
  parentColumns: string[];
  orphanRows: number;
};

type ForeignKeyShape = {
  constraintName: string;
  childTable: string;
  parentTable: string;
  childColumns: string[];
  parentColumns: string[];
};

function quoteIdentifier(value: string): string {
  const name = String(value || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_IDENTIFIER_INVALID",
      "迁移演练表名或列名不安全",
      500,
      { name },
    );
  }
  return `"${name.replace(/"/g, '""')}"`;
}

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

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createSqlitePostgresMigrationDrillRepository(
  adapter?: DatabaseAdapter,
) {
  const db = adapter ?? getDatabaseAdapter();

  return {
    async listRowChanges(input: {
      runId: string;
      tableName: string;
    }): Promise<SqlitePostgresDrillRowChange[]> {
      return db.queryMany<SqlitePostgresDrillRowChange>(
        `SELECT "runId", "tableName", "primaryKey", "primaryKeyHash",
                "changeKind", "originalRow", "migratedRow", "rollbackStatus"
           FROM sqlite_postgres_migration_row_changes
          WHERE "runId" = ? AND "tableName" = ?
          ORDER BY "primaryKeyHash"`,
        [input.runId, input.tableName],
      );
    },

    async loadCurrentRows(input: {
      tableName: string;
      changes: SqlitePostgresDrillRowChange[];
      batchSize?: number;
    }): Promise<Map<string, Record<string, unknown>>> {
      const current = new Map<string, Record<string, unknown>>();
      const batchSize = Math.max(1, Math.min(2_000, Math.trunc(input.batchSize ?? 200)));
      for (let offset = 0; offset < input.changes.length; offset += batchSize) {
        const batch = input.changes.slice(offset, offset + batchSize);
        if (batch.length === 0) continue;
        const params: unknown[] = [];
        const predicates = batch.map((change) => {
          const entries = Object.entries(change.primaryKey || {});
          if (entries.length === 0) {
            throw new SqlitePostgresMigrationError(
              "SQLITE_PG_MIGRATION_DRILL_PRIMARY_KEY_MISSING",
              "迁移演练记录缺少主键",
              500,
              { tableName: input.tableName },
            );
          }
          params.push(...entries.map(([, value]) => value));
          return `(${entries
            .map(([column]) => `target.${quoteIdentifier(column)} = ?`)
            .join(" AND ")})`;
        });
        const rows = await db.queryMany<{ row: Record<string, unknown> }>(
          `SELECT to_jsonb(target) AS row
             FROM ${quoteIdentifier(input.tableName)} AS target
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
    },

    async inspectForeignKeyViolations(input: {
      excludedTables?: string[];
    } = {}): Promise<SqlitePostgresForeignKeyViolation[]> {
      const excluded = new Set([
        "postgres_schema_migrations",
        "postgres_migration_state",
        "sqlite_postgres_migration_runs",
        "sqlite_postgres_migration_table_checkpoints",
        "sqlite_postgres_migration_batch_checkpoints",
        "sqlite_postgres_migration_row_changes",
        ...(input.excludedTables || []),
      ]);
      const constraints = await db.queryMany<ForeignKeyShape>(
        `SELECT constraint_row.constraint_name AS "constraintName",
                constraint_row.child_table AS "childTable",
                constraint_row.parent_table AS "parentTable",
                array_agg(constraint_row.child_column ORDER BY constraint_row.ordinality)
                  AS "childColumns",
                array_agg(constraint_row.parent_column ORDER BY constraint_row.ordinality)
                  AS "parentColumns"
           FROM (
             SELECT constraint_info.conname AS constraint_name,
                    child.relname AS child_table,
                    parent.relname AS parent_table,
                    child_attribute.attname AS child_column,
                    parent_attribute.attname AS parent_column,
                    child_key.ordinality
               FROM pg_constraint constraint_info
               JOIN pg_class child ON child.oid = constraint_info.conrelid
               JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
               JOIN pg_class parent ON parent.oid = constraint_info.confrelid
               JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
               JOIN LATERAL unnest(constraint_info.conkey) WITH ORDINALITY
                 AS child_key(attnum, ordinality) ON TRUE
               JOIN LATERAL unnest(constraint_info.confkey) WITH ORDINALITY
                 AS parent_key(attnum, ordinality)
                 ON parent_key.ordinality = child_key.ordinality
               JOIN pg_attribute child_attribute
                 ON child_attribute.attrelid = child.oid
                AND child_attribute.attnum = child_key.attnum
               JOIN pg_attribute parent_attribute
                 ON parent_attribute.attrelid = parent.oid
                AND parent_attribute.attnum = parent_key.attnum
              WHERE constraint_info.contype = 'f'
                AND child_namespace.nspname = 'public'
                AND parent_namespace.nspname = 'public'
           ) AS constraint_row
          GROUP BY constraint_row.constraint_name,
                   constraint_row.child_table,
                   constraint_row.parent_table
          ORDER BY constraint_row.child_table, constraint_row.constraint_name`,
      );
      const violations: SqlitePostgresForeignKeyViolation[] = [];
      for (const constraint of constraints) {
        if (excluded.has(constraint.childTable) || excluded.has(constraint.parentTable)) continue;
        const childColumns = Array.isArray(constraint.childColumns)
          ? constraint.childColumns
          : [];
        const parentColumns = Array.isArray(constraint.parentColumns)
          ? constraint.parentColumns
          : [];
        if (childColumns.length === 0 || childColumns.length !== parentColumns.length) continue;
        const count = await db.queryOne<{ count: number | string }>(
          `SELECT COUNT(*)::bigint AS count
             FROM ${quoteIdentifier(constraint.childTable)} AS child
             LEFT JOIN ${quoteIdentifier(constraint.parentTable)} AS parent
               ON ${childColumns.map((column, index) => (
                 `child.${quoteIdentifier(column)} = parent.${quoteIdentifier(parentColumns[index])}`
               )).join(" AND ")}
            WHERE ${childColumns
              .map((column) => `child.${quoteIdentifier(column)} IS NOT NULL`)
              .join(" AND ")}
              AND parent.${quoteIdentifier(parentColumns[0])} IS NULL`,
        );
        const orphanRows = numberValue(count?.count);
        if (orphanRows > 0) {
          violations.push({
            ...constraint,
            childColumns,
            parentColumns,
            orphanRows,
          });
        }
      }
      return violations;
    },

    async saveFinalReport(input: {
      runId: string;
      report: Record<string, unknown>;
    }): Promise<void> {
      const result = await db.execute(
        `UPDATE sqlite_postgres_migration_runs
            SET report = ?::jsonb, "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [JSON.stringify(input.report), input.runId],
      );
      if (result.changes !== 1) {
        throw new SqlitePostgresMigrationError(
          "SQLITE_PG_MIGRATION_RUN_NOT_FOUND",
          "无法保存迁移演练最终报告",
          404,
          { runId: input.runId },
        );
      }
    },
  };
}
