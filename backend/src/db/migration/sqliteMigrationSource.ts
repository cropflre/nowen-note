import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import Database from "better-sqlite3";

export type SqliteMigrationColumn = {
  name: string;
  declaredType: string;
  notNull: boolean;
  primaryKeyOrder: number;
};

export type SqliteMigrationTable = {
  name: string;
  rowCount: number;
  columns: SqliteMigrationColumn[];
  primaryKeyColumns: string[];
  dependencies: string[];
  schemaHash: string;
};

export type SqliteMigrationSourceSnapshot = {
  sourcePathHint: string;
  sourceFingerprint: string;
  sourceSchemaVersion: number;
  fileSize: number;
  modifiedAt: string;
  journalMode: string;
  walPresent: boolean;
  walSize: number;
  integrityOk: boolean;
  integrityMessages: string[];
  foreignKeyViolationCount: number;
  foreignKeyViolationTables: string[];
  schemaHash: string;
  totalRows: number;
  tables: SqliteMigrationTable[];
  excludedTables: string[];
};

type SqliteSchemaRow = {
  name: string;
  sql: string | null;
};

type SqliteTableInfoRow = {
  name: string;
  type: string | null;
  notnull: number;
  pk: number;
};

type SqliteForeignKeyRow = {
  table: string;
};

const EXCLUDED_TABLE_NAMES = new Set([
  "schema_migrations",
  "notes_fts",
  "vec_note_chunks",
]);

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSchema(sql: string | null): string {
  return String(sql || "").replace(/\s+/g, " ").trim();
}

function isExcludedTable(name: string, sql: string | null): boolean {
  if (name.startsWith("sqlite_")) return true;
  if (name.startsWith("notes_fts_")) return true;
  if (EXCLUDED_TABLE_NAMES.has(name)) return true;
  const normalized = normalizeSchema(sql).toLowerCase();
  return normalized.includes("virtual table") && (
    normalized.includes("using fts5")
    || normalized.includes("using vec0")
  );
}

function readSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version?: number | string | null } | undefined;
    const value = Number(row?.version ?? 0);
    if (Number.isInteger(value) && value >= 0) return value;
  } catch {
    // Older or partial databases may not have schema_migrations yet.
  }

  const value = Number(db.pragma("user_version", { simple: true }) ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function inspectTable(
  db: Database.Database,
  row: SqliteSchemaRow,
): SqliteMigrationTable {
  const tableName = quoteIdentifier(row.name);
  const countRow = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as {
    count?: number | bigint;
  } | undefined;
  const columns = db.pragma(
    `table_info(${quoteIdentifier(row.name)})`,
  ) as SqliteTableInfoRow[];
  const dependencies = Array.from(new Set(
    (db.pragma(`foreign_key_list(${quoteIdentifier(row.name)})`) as SqliteForeignKeyRow[])
      .map((entry) => String(entry.table || "").trim())
      .filter(Boolean),
  )).sort();

  const normalizedColumns = columns.map((column) => ({
    name: column.name,
    declaredType: String(column.type || ""),
    notNull: Number(column.notnull) === 1,
    primaryKeyOrder: Number(column.pk || 0),
  }));
  const primaryKeyColumns = normalizedColumns
    .filter((column) => column.primaryKeyOrder > 0)
    .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder)
    .map((column) => column.name);

  return {
    name: row.name,
    rowCount: Number(countRow?.count ?? 0),
    columns: normalizedColumns,
    primaryKeyColumns,
    dependencies,
    schemaHash: hash(normalizeSchema(row.sql)),
  };
}

export function inspectSqliteMigrationSource(
  inputPath: string,
): SqliteMigrationSourceSnapshot {
  const absolutePath = resolve(String(inputPath || "").trim());
  if (!inputPath || !existsSync(absolutePath)) {
    throw new Error(
      `[pg-data-migration] SQLite source file does not exist: ${basename(absolutePath || "unknown.db")}`,
    );
  }
  const sourceStat = statSync(absolutePath);
  if (!sourceStat.isFile()) {
    throw new Error(
      `[pg-data-migration] SQLite source is not a regular file: ${basename(absolutePath)}`,
    );
  }

  const walPath = `${absolutePath}-wal`;
  const walPresent = existsSync(walPath);
  const walSize = walPresent ? statSync(walPath).size : 0;
  const db = new Database(absolutePath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    db.pragma("query_only = ON");
    const journalMode = String(
      db.pragma("journal_mode", { simple: true }) || "unknown",
    );
    const integrityRows = db.pragma("integrity_check") as Array<Record<string, unknown>>;
    const integrityMessages = integrityRows
      .flatMap((row) => Object.values(row))
      .map((value) => String(value));
    const integrityOk = integrityMessages.length === 1
      && integrityMessages[0]?.toLowerCase() === "ok";
    const foreignKeyRows = db.pragma("foreign_key_check") as Array<Record<string, unknown>>;
    const foreignKeyViolationTables = Array.from(new Set(
      foreignKeyRows
        .map((row) => String(row.table || "").trim())
        .filter(Boolean),
    )).sort();

    const schemaRows = db.prepare(
      `SELECT name, sql
         FROM sqlite_schema
        WHERE type = 'table'
        ORDER BY name`,
    ).all() as SqliteSchemaRow[];
    const excludedTables = schemaRows
      .filter((row) => isExcludedTable(row.name, row.sql))
      .map((row) => row.name);
    const includedRows = schemaRows.filter(
      (row) => !isExcludedTable(row.name, row.sql),
    );
    const tables = includedRows.map((row) => inspectTable(db, row));
    const schemaHash = hash(
      includedRows
        .map((row) => `${row.name}:${normalizeSchema(row.sql)}`)
        .join("\n"),
    );
    const totalRows = tables.reduce((sum, table) => sum + table.rowCount, 0);
    const sourceSchemaVersion = readSchemaVersion(db);
    const sourceFingerprint = hash(JSON.stringify({
      schemaHash,
      sourceSchemaVersion,
      fileSize: sourceStat.size,
      modifiedAtMs: Math.trunc(sourceStat.mtimeMs),
      tables: tables.map((table) => [table.name, table.rowCount, table.schemaHash]),
    }));

    return {
      sourcePathHint: basename(absolutePath),
      sourceFingerprint,
      sourceSchemaVersion,
      fileSize: sourceStat.size,
      modifiedAt: sourceStat.mtime.toISOString(),
      journalMode,
      walPresent,
      walSize,
      integrityOk,
      integrityMessages: integrityMessages.slice(0, 20),
      foreignKeyViolationCount: foreignKeyRows.length,
      foreignKeyViolationTables,
      schemaHash,
      totalRows,
      tables,
      excludedTables,
    };
  } finally {
    db.close();
  }
}
