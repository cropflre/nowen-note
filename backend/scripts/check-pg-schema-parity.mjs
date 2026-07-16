#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const reportArgIndex = process.argv.indexOf("--report-json");
const reportPath = reportArgIndex >= 0 ? process.argv[reportArgIndex + 1] : undefined;

function read(path) {
  return readFileSync(path, "utf-8");
}

function walk(directory, predicate = () => true) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path, predicate));
    else if (predicate(path)) files.push(path);
  }
  return files;
}

function normalizeIdentifier(value) {
  return value.replace(/^["'`\[]|["'`\]]$/g, "").trim().toLowerCase();
}

function isEphemeralMigrationTable(table) {
  return table === "if" || /_(?:new|old|backup|temp|tmp)$/i.test(table);
}

/** Extract JavaScript / TypeScript string literals without evaluating code. */
function extractStringLiterals(source) {
  const literals = [];
  let index = 0;

  while (index < source.length) {
    const quote = source[index];
    if (quote !== "'" && quote !== '"' && quote !== "`") {
      index += 1;
      continue;
    }

    index += 1;
    let value = "";
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        value += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === quote) {
        index += 1;
        break;
      }
      value += char;
      index += 1;
    }
    literals.push(value);
  }

  return literals;
}

function extractCreatedTables(source, { code = false } = {}) {
  const tables = new Set();
  const pattern = /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(["'`\[]?[A-Za-z_][A-Za-z0-9_]*["'`\]]?)/gi;
  const inputs = code ? extractStringLiterals(source) : [source];

  for (const input of inputs) {
    for (const match of input.matchAll(pattern)) {
      const table = normalizeIdentifier(match[1]);
      if (!isEphemeralMigrationTable(table)) tables.add(table);
    }
  }
  return tables;
}

/**
 * Repository 文件同时包含 import 路径、注释和普通业务文字。
 * 只在 JS/TS 字符串字面量内部查 SQL，避免把 `from "uuid"` 等 import
 * 误判为数据库表。
 */
function extractRepositoryTables(source) {
  const tables = new Set();
  const patterns = [
    /\bFROM\s+(["`\[]?[A-Za-z_][A-Za-z0-9_]*["`\]]?)/gi,
    /\bJOIN\s+(["`\[]?[A-Za-z_][A-Za-z0-9_]*["`\]]?)/gi,
    /\bINSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(["`\[]?[A-Za-z_][A-Za-z0-9_]*["`\]]?)/gi,
    /\bUPDATE\s+(["`\[]?[A-Za-z_][A-Za-z0-9_]*["`\]]?)\s+SET\b/gi,
    /\bDELETE\s+FROM\s+(["`\[]?[A-Za-z_][A-Za-z0-9_]*["`\]]?)/gi,
  ];

  for (const sql of extractStringLiterals(source)) {
    if (!/\b(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER)\b/i.test(sql)) continue;

    const cteAliases = new Set(
      [...sql.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s+AS\s*\(\s*(?:SELECT|WITH|VALUES)\b/gi)]
        .map((match) => normalizeIdentifier(match[1])),
    );

    for (const pattern of patterns) {
      for (const match of sql.matchAll(pattern)) {
        const table = normalizeIdentifier(match[1]);
        if (!cteAliases.has(table)) tables.add(table);
      }
    }
  }

  return tables;
}

function union(...sets) {
  return new Set(sets.flatMap((set) => [...set]));
}

const sqliteSources = [
  join(backendDir, "src", "db", "schema.ts"),
  join(backendDir, "src", "db", "migrations.ts"),
  join(backendDir, "src", "db", "migrations.impl.ts"),
  join(backendDir, "src", "services", "vec-store.ts"),
].filter(existsSync);
const sqliteTables = union(...sqliteSources.map((path) => extractCreatedTables(read(path), { code: true })));

const postgresDir = join(backendDir, "src", "db", "postgres");
const postgresSources = walk(postgresDir, (path) => extname(path) === ".sql");
const postgresTables = union(...postgresSources.map((path) => extractCreatedTables(read(path))));

const repositoryDir = join(backendDir, "src", "repositories");
const repositoryFiles = walk(repositoryDir, (path) => extname(path) === ".ts");
const repositoryTables = union(...repositoryFiles.map((path) => extractRepositoryTables(read(path))));

const allowlistPath = join(scriptDir, "pg-schema-parity-allowlist.json");
const allowlist = JSON.parse(read(allowlistPath));
const allowed = new Set([
  ...(allowlist.sqliteOnlyTables ?? []),
  ...(allowlist.deferredTables ?? []),
].map((value) => value.toLowerCase()));

const ignoredSqlWords = new Set([
  "select",
  "values",
  "json_each",
  "pragma_table_info",
]);

function missingFromPostgres(sourceTables) {
  return [...sourceTables]
    .filter((table) => !postgresTables.has(table))
    .filter((table) => !allowed.has(table))
    .filter((table) => !ignoredSqlWords.has(table))
    .sort();
}

const missingSqliteTables = missingFromPostgres(sqliteTables);
const missingRepositoryTables = missingFromPostgres(repositoryTables);
const unusedDeferredTables = [...allowed]
  .filter((table) => !sqliteTables.has(table) && !repositoryTables.has(table))
  .sort();

const report = {
  generatedAt: new Date().toISOString(),
  sources: {
    sqlite: sqliteSources.map((path) => relative(backendDir, path)),
    postgres: postgresSources.map((path) => relative(backendDir, path)),
    repositories: repositoryFiles.length,
  },
  counts: {
    sqliteTables: sqliteTables.size,
    postgresTables: postgresTables.size,
    repositoryTables: repositoryTables.size,
  },
  missingSqliteTables,
  missingRepositoryTables,
  deferredTables: [...allowed].sort(),
  unusedDeferredTables,
};

if (reportPath) writeFileSync(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);

console.log(`[pg-schema-parity] SQLite tables: ${report.counts.sqliteTables}`);
console.log(`[pg-schema-parity] PostgreSQL tables: ${report.counts.postgresTables}`);
console.log(`[pg-schema-parity] Repository-referenced tables: ${report.counts.repositoryTables}`);

if (missingSqliteTables.length > 0) {
  console.error(`[pg-schema-parity] SQLite tables missing from PostgreSQL: ${missingSqliteTables.join(", ")}`);
}
if (missingRepositoryTables.length > 0) {
  console.error(`[pg-schema-parity] Repository tables missing from PostgreSQL: ${missingRepositoryTables.join(", ")}`);
}
if (unusedDeferredTables.length > 0) {
  console.warn(`[pg-schema-parity] stale allowlist entries: ${unusedDeferredTables.join(", ")}`);
}

if (missingSqliteTables.length > 0 || missingRepositoryTables.length > 0) process.exit(1);
console.log("[pg-schema-parity] PASS");
