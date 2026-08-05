import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

import Database from "better-sqlite3";

export type SqliteMigrationCursor = Record<string, string | number | boolean | null>;

export type SqliteMigrationBatch = {
  rows: Array<Record<string, unknown>>;
  cursorStart: SqliteMigrationCursor | null;
  cursorEnd: SqliteMigrationCursor | null;
};

function quoteIdentifier(value: string): string {
  const name = String(value || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("[pg-data-migration] unsafe SQLite identifier");
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function jsonSafeCursorValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function buildCursor(
  row: Record<string, unknown>,
  primaryKeyColumns: string[],
): SqliteMigrationCursor {
  return Object.fromEntries(
    primaryKeyColumns.map((column) => [column, jsonSafeCursorValue(row[column])]),
  );
}

export function openSqliteMigrationReader(inputPath: string) {
  const absolutePath = resolve(String(inputPath || "").trim());
  if (!inputPath || !existsSync(absolutePath)) {
    throw new Error(
      `[pg-data-migration] frozen SQLite snapshot does not exist: ${basename(absolutePath || "unknown.db")}`,
    );
  }

  const db = new Database(absolutePath, {
    readonly: true,
    fileMustExist: true,
  });
  db.pragma("query_only = ON");
  db.defaultSafeIntegers(true);

  return {
    readBatch(input: {
      tableName: string;
      columns: string[];
      primaryKeyColumns: string[];
      lastCursor?: SqliteMigrationCursor | null;
      limit: number;
    }): SqliteMigrationBatch {
      const columns = Array.from(new Set(input.columns.map((column) => String(column || "").trim())))
        .filter(Boolean);
      const primaryKeyColumns = Array.from(new Set(
        input.primaryKeyColumns.map((column) => String(column || "").trim()),
      )).filter(Boolean);
      if (columns.length === 0) {
        throw new Error("[pg-data-migration] source table has no readable columns");
      }
      if (primaryKeyColumns.length === 0) {
        throw new Error("[pg-data-migration] source table has no stable primary key cursor");
      }
      for (const primaryKey of primaryKeyColumns) {
        if (!columns.includes(primaryKey)) {
          throw new Error("[pg-data-migration] primary key column is missing from source projection");
        }
      }

      const tableSql = quoteIdentifier(input.tableName);
      const columnSql = columns.map(quoteIdentifier).join(", ");
      const orderSql = primaryKeyColumns.map(quoteIdentifier).join(", ");
      const limit = Math.max(1, Math.min(2_000, Math.trunc(input.limit || 200)));
      const params: unknown[] = [];
      let whereSql = "";

      if (input.lastCursor) {
        const cursorValues = primaryKeyColumns.map((column) => {
          if (!(column in input.lastCursor!)) {
            throw new Error("[pg-data-migration] persisted cursor is incomplete");
          }
          return input.lastCursor![column];
        });
        const cursorColumns = primaryKeyColumns.map(quoteIdentifier).join(", ");
        const placeholders = primaryKeyColumns.map(() => "?").join(", ");
        whereSql = ` WHERE (${cursorColumns}) > (${placeholders})`;
        params.push(...cursorValues);
      }
      params.push(limit);

      const rows = db.prepare(
        `SELECT ${columnSql}
           FROM ${tableSql}${whereSql}
          ORDER BY ${orderSql}
          LIMIT ?`,
      ).all(...params) as Array<Record<string, unknown>>;
      const cursorStart = rows.length > 0
        ? buildCursor(rows[0], primaryKeyColumns)
        : null;
      const cursorEnd = rows.length > 0
        ? buildCursor(rows[rows.length - 1], primaryKeyColumns)
        : null;
      return { rows, cursorStart, cursorEnd };
    },

    close(): void {
      db.close();
    },
  };
}

export type SqliteMigrationReader = ReturnType<typeof openSqliteMigrationReader>;
