import { createHash } from "node:crypto";

import type { DatabaseAdapter, DbStatement } from "../db/adapters/types";
import {
  inspectSqliteMigrationSource,
  type SqliteMigrationSourceSnapshot,
  type SqliteMigrationTable,
} from "../db/migration/sqliteMigrationSource";
import {
  openSqliteMigrationReader,
  type SqliteMigrationCursor,
  type SqliteMigrationReader,
} from "../db/migration/sqliteMigrationReader";
import {
  createSqlitePostgresMigrationRepository,
  SqlitePostgresMigrationError,
  type SqlitePostgresMigrationBatchCheckpoint,
  type SqlitePostgresMigrationSnapshot,
  type SqlitePostgresMigrationTableClaim,
} from "../repositories/sqlitePostgresMigrationRepository";

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_LEASE_SECONDS = 600;
const DEFAULT_MAX_ATTEMPTS = 10;

type Repository = ReturnType<typeof createSqlitePostgresMigrationRepository>;

type TargetColumn = {
  name: string;
  dataType: string;
  udtName: string;
  nullable: boolean;
  columnDefault: string | null;
  identity: boolean;
};

type TargetForeignKey = {
  columnName: string;
  foreignTableName: string;
  nullable: boolean;
};

type TargetTableShape = {
  columns: TargetColumn[];
  foreignKeys: TargetForeignKey[];
};

type CanonicalBatch = {
  batchSequence: number;
  rowCount: number;
  checksum: string;
};

export type SqlitePostgresCopyVerificationTable = {
  tableName: string;
  sourceRows: number;
  targetRows: number;
  sourceChecksum: string;
  targetChecksum: string;
  matched: boolean;
};

export type SqlitePostgresCopyVerificationReport = {
  generatedAt: string;
  ok: boolean;
  runId: string;
  tables: SqlitePostgresCopyVerificationTable[];
  failures: Array<{
    tableName: string;
    code: string;
    message: string;
  }>;
};

export type SqlitePostgresCopyRuntimeOptions = {
  repository?: Repository;
  inspectSource?: typeof inspectSqliteMigrationSource;
  openReader?: typeof openSqliteMigrationReader;
  batchSize?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
};

function quoteIdentifier(value: string): string {
  const name = String(value || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_IDENTIFIER_INVALID",
      "迁移表或列名不安全",
      500,
    );
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function stableJson(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Buffer.isBuffer(value)) {
    return `{"$bytea":${JSON.stringify(value.toString("hex"))}}`;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  let text = String(value || "").trim();
  if (!text) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_TIMESTAMP_INVALID",
      "SQLite 时间字段包含空值但目标列要求时间类型",
      409,
    );
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text = `${text}T00:00:00Z`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
    text = `${text.replace(" ", "T")}Z`;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_TIMESTAMP_INVALID",
      "SQLite 时间字段无法转换为 PostgreSQL TIMESTAMPTZ",
      409,
    );
  }
  return parsed.toISOString();
}

function normalizeBoolean(value: unknown): boolean {
  if (value === true || value === 1 || value === 1n || value === "1") return true;
  if (value === false || value === 0 || value === 0n || value === "0") return false;
  const text = String(value).trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  throw new SqlitePostgresMigrationError(
    "SQLITE_PG_MIGRATION_BOOLEAN_INVALID",
    "SQLite BOOLEAN 字段不是 0/1 或 true/false",
    409,
  );
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_JSON_INVALID",
      "SQLite JSON 字段包含无效 JSON",
      409,
    );
  }
}

function convertValue(column: TargetColumn, value: unknown): unknown {
  if (value == null) return null;
  const dataType = column.dataType.toLowerCase();
  const udtName = column.udtName.toLowerCase();

  if (dataType === "boolean") return normalizeBoolean(value);
  if (dataType.includes("timestamp") || dataType === "date") return normalizeTimestamp(value);
  if (dataType === "bytea" || udtName === "bytea") {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    return Buffer.from(String(value), "utf8");
  }
  if (dataType === "json" || dataType === "jsonb" || udtName === "json" || udtName === "jsonb") {
    return parseJson(value);
  }
  if (dataType === "bigint" || udtName === "int8") {
    return typeof value === "bigint" ? value.toString() : String(value);
  }
  if (dataType === "integer" || dataType === "smallint" || udtName === "int4" || udtName === "int2") {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_INTEGER_INVALID",
        "SQLite 整数字段无法转换为 PostgreSQL INTEGER",
        409,
      );
    }
    return parsed;
  }
  if (dataType === "numeric" || dataType === "decimal") return String(value);
  if (dataType === "real" || dataType === "double precision") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_NUMBER_INVALID",
        "SQLite 数值字段无法转换为 PostgreSQL 浮点类型",
        409,
      );
    }
    return parsed;
  }
  if (dataType === "array") {
    const parsed = typeof value === "string" ? parseJson(value) : value;
    if (!Array.isArray(parsed)) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_ARRAY_INVALID",
        "SQLite 字段无法转换为 PostgreSQL ARRAY",
        409,
      );
    }
    return parsed;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function canonicalValue(column: TargetColumn, value: unknown): unknown {
  const converted = convertValue(column, value);
  if (converted == null) return null;
  const dataType = column.dataType.toLowerCase();
  const udtName = column.udtName.toLowerCase();
  if (dataType.includes("timestamp") || dataType === "date") return normalizeTimestamp(converted);
  if (dataType === "bytea" || udtName === "bytea") {
    return Buffer.isBuffer(converted)
      ? { $bytea: converted.toString("hex") }
      : { $bytea: Buffer.from(converted as Uint8Array).toString("hex") };
  }
  if (dataType === "json" || dataType === "jsonb" || udtName === "json" || udtName === "jsonb") {
    return parseJson(converted);
  }
  if (dataType === "bigint" || dataType === "numeric" || dataType === "decimal"
    || udtName === "int8") {
    return String(converted);
  }
  return converted;
}

function checksumRows(rows: Array<Record<string, unknown>>, columns: TargetColumn[]): string {
  const payload = rows.map((row) => stableJson(Object.fromEntries(
    columns.map((column) => [column.name, canonicalValue(column, row[column.name])]),
  ))).join("\n");
  return sha256(payload);
}

function checksumBatches(batches: CanonicalBatch[]): string {
  return sha256(
    batches
      .sort((left, right) => left.batchSequence - right.batchSequence)
      .map((batch) => `${batch.batchSequence}:${batch.rowCount}:${batch.checksum}`)
      .join("\n"),
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof SqlitePostgresMigrationError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function jsonCursor(row: Record<string, unknown>, columns: string[]): SqliteMigrationCursor {
  return Object.fromEntries(columns.map((column) => {
    const value = row[column];
    if (value == null || typeof value === "string" || typeof value === "number"
      || typeof value === "boolean") {
      return [column, value ?? null];
    }
    if (typeof value === "bigint") return [column, value.toString()];
    if (value instanceof Date) return [column, value.toISOString()];
    return [column, String(value)];
  }));
}

function sourceSnapshotFromRun(snapshot: SqlitePostgresMigrationSnapshot): SqliteMigrationSourceSnapshot {
  return snapshot.run.sourceSnapshot as unknown as SqliteMigrationSourceSnapshot;
}

function assertFrozenSnapshotMatches(
  expected: SqliteMigrationSourceSnapshot,
  actual: SqliteMigrationSourceSnapshot,
): void {
  const expectedRows = new Map(expected.tables.map((table) => [table.name, table.rowCount]));
  const matches = actual.integrityOk
    && actual.foreignKeyViolationCount === 0
    && actual.schemaHash === expected.schemaHash
    && actual.sourceSchemaVersion === expected.sourceSchemaVersion
    && actual.tables.length === expected.tables.length
    && actual.tables.every((table) => expectedRows.get(table.name) === table.rowCount);
  if (!matches) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_FROZEN_SNAPSHOT_MISMATCH",
      "执行时提供的 SQLite 冻结备份与已持久化迁移计划不一致",
      409,
    );
  }
  if (actual.walPresent && actual.walSize > 0) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_FROZEN_SNAPSHOT_HAS_WAL",
      "执行源仍存在非空 WAL，不是可安全恢复的冻结快照",
      409,
      { walSize: actual.walSize },
    );
  }
}

async function inspectTargetTable(
  adapter: DatabaseAdapter,
  tableName: string,
): Promise<TargetTableShape> {
  const columns = await adapter.queryMany<{
    name: string;
    dataType: string;
    udtName: string;
    isNullable: string;
    columnDefault: string | null;
    isIdentity: string;
  }>(
    `SELECT column_name AS name,
            data_type AS "dataType",
            udt_name AS "udtName",
            is_nullable AS "isNullable",
            column_default AS "columnDefault",
            is_identity AS "isIdentity"
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ?
      ORDER BY ordinal_position`,
    [tableName],
  );
  if (columns.length === 0) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_TARGET_TABLE_MISSING",
      "目标 PostgreSQL 表不存在",
      409,
      { tableName },
    );
  }
  const normalizedColumns: TargetColumn[] = columns.map((column) => ({
    name: column.name,
    dataType: column.dataType,
    udtName: column.udtName,
    nullable: column.isNullable === "YES",
    columnDefault: column.columnDefault,
    identity: column.isIdentity === "YES",
  }));
  const nullableByName = new Map(normalizedColumns.map((column) => [column.name, column.nullable]));
  const foreignKeys = await adapter.queryMany<{
    columnName: string;
    foreignTableName: string;
  }>(
    `SELECT kcu.column_name AS "columnName",
            ccu.table_name AS "foreignTableName"
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.constraint_schema = kcu.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = ?
      ORDER BY kcu.ordinal_position`,
    [tableName],
  );
  return {
    columns: normalizedColumns,
    foreignKeys: foreignKeys.map((foreignKey) => ({
      ...foreignKey,
      nullable: nullableByName.get(foreignKey.columnName) === true,
    })),
  };
}

function resolveColumns(
  sourceTable: SqliteMigrationTable,
  target: TargetTableShape,
): TargetColumn[] {
  const sourceNames = new Set(sourceTable.columns.map((column) => column.name));
  const targetByName = new Map(target.columns.map((column) => [column.name, column]));
  const missingTargetColumns = [...sourceNames].filter((name) => !targetByName.has(name));
  if (missingTargetColumns.length > 0) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_TARGET_COLUMNS_MISSING",
      "目标 PostgreSQL 缺少 SQLite 源列",
      409,
      { tableName: sourceTable.name, columns: missingTargetColumns },
    );
  }
  const requiredTargetColumns = target.columns.filter((column) => (
    !sourceNames.has(column.name)
    && !column.nullable
    && column.columnDefault == null
    && !column.identity
  ));
  if (requiredTargetColumns.length > 0) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_SOURCE_COLUMNS_MISSING",
      "SQLite 源表缺少目标 PostgreSQL 必填列",
      409,
      {
        tableName: sourceTable.name,
        columns: requiredTargetColumns.map((column) => column.name),
      },
    );
  }
  return sourceTable.columns.map((column) => targetByName.get(column.name)!);
}

function buildUpsertStatement(input: {
  tableName: string;
  columns: TargetColumn[];
  primaryKeyColumns: string[];
  row: Record<string, unknown>;
  deferredSelfColumns: Set<string>;
}): DbStatement {
  const columnNames = input.columns.map((column) => column.name);
  const values = input.columns.map((column) => (
    input.deferredSelfColumns.has(column.name)
      ? null
      : convertValue(column, input.row[column.name])
  ));
  const identityOverride = input.columns.some((column) => column.identity)
    ? " OVERRIDING SYSTEM VALUE"
    : "";
  const updates = columnNames
    .filter((column) => !input.primaryKeyColumns.includes(column))
    .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`);
  const conflictSql = updates.length > 0
    ? `DO UPDATE SET ${updates.join(", ")}`
    : "DO NOTHING";
  return {
    sql: `INSERT INTO ${quoteIdentifier(input.tableName)}
            (${columnNames.map(quoteIdentifier).join(", ")})${identityOverride}
          VALUES (${columnNames.map(() => "?").join(", ")})
          ON CONFLICT (${input.primaryKeyColumns.map(quoteIdentifier).join(", ")})
          ${conflictSql}`,
    params: values,
  };
}


function buildRowOwnershipStatement(input: {
  runId: string;
  tableName: string;
  columns: TargetColumn[];
  primaryKeyColumns: string[];
  row: Record<string, unknown>;
  batchSequence: number;
}): DbStatement {
  const byName = new Map(input.columns.map((column) => [column.name, column]));
  const primaryKey = Object.fromEntries(input.primaryKeyColumns.map((columnName) => {
    const column = byName.get(columnName);
    if (!column) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_PRIMARY_KEY_COLUMN_MISSING",
        "目标表缺少 run-owned tracking 所需主键列",
        500,
        { tableName: input.tableName, column: columnName },
      );
    }
    return [columnName, canonicalValue(column, input.row[columnName])];
  }));
  const canonicalRow = Object.fromEntries(input.columns.map((column) => [
    column.name,
    canonicalValue(column, input.row[column.name]),
  ]));
  return {
    sql: `INSERT INTO sqlite_postgres_migration_row_changes (
            "runId", "tableName", "primaryKey", "primaryKeyHash",
            "batchSequence", "changeKind", "originalRow", "migratedChecksum"
          ) VALUES (?, ?, ?::jsonb, ?, ?, 'inserted', NULL, ?)
          ON CONFLICT ("runId", "tableName", "primaryKeyHash") DO UPDATE
            SET "batchSequence" = LEAST(
                  sqlite_postgres_migration_row_changes."batchSequence",
                  EXCLUDED."batchSequence"
                ),
                "migratedChecksum" = EXCLUDED."migratedChecksum",
                "updatedAt" = CURRENT_TIMESTAMP`,
    params: [
      input.runId,
      input.tableName,
      JSON.stringify(primaryKey),
      sha256(stableJson(primaryKey)),
      Math.max(0, Math.trunc(input.batchSequence)),
      sha256(stableJson(canonicalRow)),
    ],
  };
}

async function repairSelfReferences(input: {
  adapter: DatabaseAdapter;
  reader: SqliteMigrationReader;
  tableName: string;
  primaryKeyColumns: string[];
  deferredColumns: TargetColumn[];
  batchSize: number;
}): Promise<void> {
  if (input.deferredColumns.length === 0) return;
  const projection = Array.from(new Set([
    ...input.primaryKeyColumns,
    ...input.deferredColumns.map((column) => column.name),
  ]));
  let cursor: SqliteMigrationCursor | null = null;
  while (true) {
    const batch = input.reader.readBatch({
      tableName: input.tableName,
      columns: projection,
      primaryKeyColumns: input.primaryKeyColumns,
      lastCursor: cursor,
      limit: input.batchSize,
    });
    if (batch.rows.length === 0) return;
    const statements: DbStatement[] = batch.rows.map((row) => ({
      sql: `UPDATE ${quoteIdentifier(input.tableName)}
               SET ${input.deferredColumns
                 .map((column) => `${quoteIdentifier(column.name)} = ?`)
                 .join(", ")}
             WHERE ${input.primaryKeyColumns
               .map((column) => `${quoteIdentifier(column)} = ?`)
               .join(" AND ")}`,
      params: [
        ...input.deferredColumns.map((column) => convertValue(column, row[column.name])),
        ...input.primaryKeyColumns.map((column) => row[column]),
      ],
      requireChanges: 1,
    }));
    await input.adapter.executeStatements(statements);
    cursor = batch.cursorEnd;
  }
}

async function repairIdentitySequences(
  adapter: DatabaseAdapter,
  tableName: string,
  columns: TargetColumn[],
): Promise<void> {
  for (const column of columns.filter((entry) => entry.identity)) {
    const sequence = await adapter.queryOne<{ sequenceName: string | null }>(
      `SELECT pg_get_serial_sequence(?, ?) AS "sequenceName"`,
      [`public.${tableName}`, column.name],
    );
    if (!sequence?.sequenceName) continue;
    await adapter.queryOne(
      `SELECT setval(
          ?::regclass,
          COALESCE(MAX(${quoteIdentifier(column.name)})::bigint, 1),
          COUNT(*) > 0
        )
         FROM ${quoteIdentifier(tableName)}`,
      [sequence.sequenceName],
    );
  }
}

async function readTargetBatch(input: {
  adapter: DatabaseAdapter;
  tableName: string;
  columns: TargetColumn[];
  primaryKeyColumns: string[];
  lastCursor: SqliteMigrationCursor | null;
  limit: number;
}): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = [];
  let whereSql = "";
  if (input.lastCursor) {
    const cursorValues = input.primaryKeyColumns.map((column) => input.lastCursor![column]);
    whereSql = ` WHERE (${input.primaryKeyColumns.map(quoteIdentifier).join(", ")})
                       > (${input.primaryKeyColumns.map(() => "?").join(", ")})`;
    params.push(...cursorValues);
  }
  params.push(input.limit);
  return input.adapter.queryMany<Record<string, unknown>>(
    `SELECT ${input.columns.map((column) => quoteIdentifier(column.name)).join(", ")}
       FROM ${quoteIdentifier(input.tableName)}${whereSql}
      ORDER BY ${input.primaryKeyColumns.map(quoteIdentifier).join(", ")}
      LIMIT ?`,
    params,
  );
}

async function verifyTargetBatches(input: {
  adapter: DatabaseAdapter;
  tableName: string;
  columns: TargetColumn[];
  primaryKeyColumns: string[];
  sourceBatches: CanonicalBatch[];
  batchSize: number;
}): Promise<{ rowCount: number; checksum: string }> {
  const targetBatches: CanonicalBatch[] = [];
  let cursor: SqliteMigrationCursor | null = null;
  let sequence = 0;
  let rowCount = 0;
  while (true) {
    const rows = await readTargetBatch({ ...input, lastCursor: cursor, limit: input.batchSize });
    if (rows.length === 0) break;
    const checksum = checksumRows(rows, input.columns);
    targetBatches.push({ batchSequence: sequence, rowCount: rows.length, checksum });
    rowCount += rows.length;
    cursor = jsonCursor(rows[rows.length - 1], input.primaryKeyColumns);
    sequence += 1;
  }

  if (targetBatches.length !== input.sourceBatches.length) {
    throw new SqlitePostgresMigrationError(
      "SQLITE_PG_MIGRATION_BATCH_COUNT_MISMATCH",
      "PostgreSQL 目标表批次数与 SQLite 源表不一致",
      409,
      { tableName: input.tableName },
    );
  }
  for (let index = 0; index < input.sourceBatches.length; index += 1) {
    const source = input.sourceBatches[index];
    const target = targetBatches[index];
    if (source.rowCount !== target.rowCount || source.checksum !== target.checksum) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_BATCH_CHECKSUM_MISMATCH",
        "PostgreSQL 目标批次与 SQLite 源批次内容不一致",
        409,
        { tableName: input.tableName, batchSequence: source.batchSequence },
      );
    }
  }
  return { rowCount, checksum: checksumBatches(targetBatches) };
}

function canonicalBatchesFromCheckpoints(
  batches: SqlitePostgresMigrationBatchCheckpoint[],
): CanonicalBatch[] {
  return batches.map((batch) => {
    if (!batch.checksum) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_BATCH_CHECKSUM_MISSING",
        "已完成迁移批次缺少 checksum",
        500,
        { tableName: batch.tableName, batchSequence: batch.batchSequence },
      );
    }
    return {
      batchSequence: batch.batchSequence,
      rowCount: batch.rowCount,
      checksum: batch.checksum,
    };
  });
}

export function createSqlitePostgresCopyRuntime(
  adapter: DatabaseAdapter,
  options: SqlitePostgresCopyRuntimeOptions = {},
) {
  const repository = options.repository || createSqlitePostgresMigrationRepository(adapter);
  const inspectSource = options.inspectSource || inspectSqliteMigrationSource;
  const openReader = options.openReader || openSqliteMigrationReader;
  const configuredBatchSize = Math.max(1, Math.min(2_000, Math.trunc(
    options.batchSize ?? DEFAULT_BATCH_SIZE,
  )));
  const leaseSeconds = Math.max(30, Math.trunc(options.leaseSeconds ?? DEFAULT_LEASE_SECONDS));
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));

  function batchSizeFor(snapshot: SqlitePostgresMigrationSnapshot): number {
    const execution = (snapshot.run.plan as { execution?: { batchSize?: number } }).execution;
    return Math.max(1, Math.min(2_000, Math.trunc(
      execution?.batchSize ?? configuredBatchSize,
    )));
  }

  async function processClaim(input: {
    claim: SqlitePostgresMigrationTableClaim;
    source: SqliteMigrationSourceSnapshot;
    reader: SqliteMigrationReader;
    batchSize: number;
    remainingBatches: { value: number | null };
  }): Promise<"verified" | "bounded"> {
    const sourceTable = input.source.tables.find((table) => table.name === input.claim.tableName);
    if (!sourceTable) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_SOURCE_TABLE_MISSING",
        "冻结 SQLite 快照缺少计划中的表",
        409,
        { tableName: input.claim.tableName },
      );
    }
    if (sourceTable.primaryKeyColumns.length === 0) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_PRIMARY_KEY_REQUIRED",
        "实际复制阶段要求每个业务表具备稳定主键",
        409,
        { tableName: sourceTable.name },
      );
    }

    const target = await inspectTargetTable(adapter, sourceTable.name);
    const columns = resolveColumns(sourceTable, target);
    const targetByName = new Map(columns.map((column) => [column.name, column]));
    const deferredSelfColumns = target.foreignKeys
      .filter((foreignKey) => foreignKey.foreignTableName === sourceTable.name)
      .map((foreignKey) => {
        if (!foreignKey.nullable) {
          throw new SqlitePostgresMigrationError(
            "SQLITE_PG_MIGRATION_SELF_REFERENCE_NOT_NULL",
            "检测到不可置空的自引用外键，当前安全执行器无法分阶段恢复",
            409,
            { tableName: sourceTable.name, column: foreignKey.columnName },
          );
        }
        return targetByName.get(foreignKey.columnName);
      })
      .filter((column): column is TargetColumn => Boolean(column));
    const deferredNames = new Set(deferredSelfColumns.map((column) => column.name));

    let cursor = input.claim.lastCursor as SqliteMigrationCursor | null;
    let copiedRows = input.claim.copiedRows;
    while (true) {
      const batch = input.reader.readBatch({
        tableName: sourceTable.name,
        columns: sourceTable.columns.map((column) => column.name),
        primaryKeyColumns: sourceTable.primaryKeyColumns,
        lastCursor: cursor,
        limit: input.batchSize,
      });
      if (batch.rows.length === 0) break;
      const completed = await repository.getCompletedBatches({
        runId: input.claim.runId,
        tableName: sourceTable.name,
      });
      const batchSequence = completed.length;
      const canonicalRows = batch.rows.map((row) => Object.fromEntries(
        columns.map((column) => [column.name, convertValue(column, row[column.name])]),
      ));
      const checksum = checksumRows(canonicalRows, columns);
const statements = batch.rows.flatMap((row) => [
  buildUpsertStatement({
    tableName: sourceTable.name,
    columns,
    primaryKeyColumns: sourceTable.primaryKeyColumns,
    row,
    deferredSelfColumns: deferredNames,
  }),
  buildRowOwnershipStatement({
    runId: input.claim.runId,
    tableName: sourceTable.name,
    columns,
    primaryKeyColumns: sourceTable.primaryKeyColumns,
    row,
    batchSequence,
  }),
]);
      copiedRows += batch.rows.length;
      await repository.commitBatch({
        runId: input.claim.runId,
        tableName: sourceTable.name,
        leaseToken: input.claim.leaseToken,
        batchSequence,
        cursorStart: batch.cursorStart,
        cursorEnd: batch.cursorEnd,
        rowCount: batch.rows.length,
        checksum,
        copiedRows,
        lastCursor: batch.cursorEnd!,
        leaseSeconds,
        statements,
      });
      cursor = batch.cursorEnd;
      if (input.remainingBatches.value != null) {
        input.remainingBatches.value -= 1;
        if (input.remainingBatches.value <= 0) {
          await repository.releaseTableLease({
            runId: input.claim.runId,
            tableName: sourceTable.name,
            leaseToken: input.claim.leaseToken,
          });
          return "bounded";
        }
      }
    }

    if (copiedRows !== sourceTable.rowCount) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_SOURCE_ROW_COUNT_DRIFT",
        "SQLite 冻结快照实际读取行数与预检计划不一致",
        409,
        { tableName: sourceTable.name, expected: sourceTable.rowCount, actual: copiedRows },
      );
    }
    const completedBatches = canonicalBatchesFromCheckpoints(
      await repository.getCompletedBatches({
        runId: input.claim.runId,
        tableName: sourceTable.name,
      }),
    );
    const sourceChecksum = checksumBatches(completedBatches);
    await repository.markTableVerifying({
      runId: input.claim.runId,
      tableName: sourceTable.name,
      leaseToken: input.claim.leaseToken,
      sourceChecksum,
      leaseSeconds,
    });
    await repairSelfReferences({
      adapter,
      reader: input.reader,
      tableName: sourceTable.name,
      primaryKeyColumns: sourceTable.primaryKeyColumns,
      deferredColumns: deferredSelfColumns,
      batchSize: input.batchSize,
    });
    await repairIdentitySequences(adapter, sourceTable.name, columns);
    const verified = await verifyTargetBatches({
      adapter,
      tableName: sourceTable.name,
      columns,
      primaryKeyColumns: sourceTable.primaryKeyColumns,
      sourceBatches: completedBatches,
      batchSize: input.batchSize,
    });
    if (verified.rowCount !== sourceTable.rowCount || verified.checksum !== sourceChecksum) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_TABLE_VERIFY_FAILED",
        "PostgreSQL 目标表整体验证失败",
        409,
        { tableName: sourceTable.name },
      );
    }
    await repository.markTableVerified({
      runId: input.claim.runId,
      tableName: sourceTable.name,
      leaseToken: input.claim.leaseToken,
      verifiedRows: verified.rowCount,
      targetChecksum: verified.checksum,
    });
    return "verified";
  }

  async function apply(input: {
    runId: string;
    snapshotPath: string;
    maxBatches?: number | null;
  }): Promise<SqlitePostgresMigrationSnapshot> {
    let snapshot = await repository.getSnapshotByRunId(input.runId);
    if (snapshot.run.status === "completed") return snapshot;
    if (!snapshot.run.targetWasEmpty) {
      throw new SqlitePostgresMigrationError(
        "SQLITE_PG_MIGRATION_NON_EMPTY_APPLY_NOT_ENABLED",
        "当前复制执行切片仅允许写入预检时为空的 PostgreSQL 目标库",
        409,
      );
    }
    const expectedSource = sourceSnapshotFromRun(snapshot);
    const frozenSource = inspectSource(input.snapshotPath);
    assertFrozenSnapshotMatches(expectedSource, frozenSource);
    const reader = openReader(input.snapshotPath);
    const remainingBatches = {
      value: input.maxBatches == null
        ? null
        : Math.max(1, Math.trunc(input.maxBatches)),
    };
    const batchSize = batchSizeFor(snapshot);

    try {
      while (true) {
        const claim = await repository.claimNextTable({
          runId: snapshot.run.id,
          maxAttempts,
          leaseSeconds,
        });
        if (!claim) break;
        try {
          const result = await processClaim({
            claim,
            source: frozenSource,
            reader,
            batchSize,
            remainingBatches,
          });
          if (result === "bounded") return repository.getSnapshotByRunId(snapshot.run.id);
        } catch (error) {
          await repository.markTableFailed({
            runId: claim.runId,
            tableName: claim.tableName,
            leaseToken: claim.leaseToken,
            error: errorMessage(error),
            retryDelaySeconds: 0,
          }).catch((leaseError) => {
            if (!(leaseError instanceof SqlitePostgresMigrationError)
              || leaseError.code !== "SQLITE_PG_MIGRATION_TABLE_LEASE_LOST") {
              throw leaseError;
            }
          });
          throw error;
        }
        snapshot = await repository.getSnapshotByRunId(snapshot.run.id);
      }
      return repository.getSnapshotByRunId(snapshot.run.id);
    } finally {
      reader.close();
    }
  }

  async function recomputeSourceBatches(input: {
    reader: SqliteMigrationReader;
    sourceTable: SqliteMigrationTable;
    columns: TargetColumn[];
    batchSize: number;
  }): Promise<CanonicalBatch[]> {
    const batches: CanonicalBatch[] = [];
    let cursor: SqliteMigrationCursor | null = null;
    let sequence = 0;
    while (true) {
      const batch = input.reader.readBatch({
        tableName: input.sourceTable.name,
        columns: input.sourceTable.columns.map((column) => column.name),
        primaryKeyColumns: input.sourceTable.primaryKeyColumns,
        lastCursor: cursor,
        limit: input.batchSize,
      });
      if (batch.rows.length === 0) return batches;
      const canonicalRows = batch.rows.map((row) => Object.fromEntries(
        input.columns.map((column) => [column.name, convertValue(column, row[column.name])]),
      ));
      batches.push({
        batchSequence: sequence,
        rowCount: batch.rows.length,
        checksum: checksumRows(canonicalRows, input.columns),
      });
      cursor = batch.cursorEnd;
      sequence += 1;
    }
  }

  async function verify(input: {
    runId: string;
    snapshotPath: string;
  }): Promise<SqlitePostgresCopyVerificationReport> {
    const snapshot = await repository.getSnapshotByRunId(input.runId);
    const expectedSource = sourceSnapshotFromRun(snapshot);
    const frozenSource = inspectSource(input.snapshotPath);
    assertFrozenSnapshotMatches(expectedSource, frozenSource);
    const reader = openReader(input.snapshotPath);
    const batchSize = batchSizeFor(snapshot);
    const tables: SqlitePostgresCopyVerificationTable[] = [];
    const failures: SqlitePostgresCopyVerificationReport["failures"] = [];
    try {
      for (const sourceTable of frozenSource.tables) {
        try {
          if (sourceTable.primaryKeyColumns.length === 0) {
            throw new SqlitePostgresMigrationError(
              "SQLITE_PG_MIGRATION_PRIMARY_KEY_REQUIRED",
              "独立校验要求业务表具备稳定主键",
              409,
              { tableName: sourceTable.name },
            );
          }
          const target = await inspectTargetTable(adapter, sourceTable.name);
          const columns = resolveColumns(sourceTable, target);
          const sourceBatches = await recomputeSourceBatches({
            reader,
            sourceTable,
            columns,
            batchSize,
          });
          const sourceChecksum = checksumBatches(sourceBatches);
          const targetResult = await verifyTargetBatches({
            adapter,
            tableName: sourceTable.name,
            columns,
            primaryKeyColumns: sourceTable.primaryKeyColumns,
            sourceBatches,
            batchSize,
          });
          const matched = targetResult.rowCount === sourceTable.rowCount
            && targetResult.checksum === sourceChecksum;
          tables.push({
            tableName: sourceTable.name,
            sourceRows: sourceTable.rowCount,
            targetRows: targetResult.rowCount,
            sourceChecksum,
            targetChecksum: targetResult.checksum,
            matched,
          });
          if (!matched) {
            failures.push({
              tableName: sourceTable.name,
              code: "SQLITE_PG_MIGRATION_TABLE_VERIFY_FAILED",
              message: "目标表行数或 checksum 不一致",
            });
          }
        } catch (error) {
          failures.push({
            tableName: sourceTable.name,
            code: error instanceof SqlitePostgresMigrationError
              ? error.code
              : "SQLITE_PG_MIGRATION_VERIFY_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      reader.close();
    }
    return {
      generatedAt: new Date().toISOString(),
      ok: failures.length === 0,
      runId: snapshot.run.id,
      tables,
      failures,
    };
  }

  return { apply, verify };
}
