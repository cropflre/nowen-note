import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { excelDocumentsMigration } from "../src/db/excelDocumentsMigration";
import { ensureForkExcelDocumentSchema, reconcileForkMigrationLedger } from "../src/db/forkMigrationCompat";
import { getPendingMigrations, MIGRATIONS } from "../src/db/migrations";

const OFFICIAL_V141 = MIGRATIONS.find((migration) => migration.name === "ai-migration-hub");
if (!OFFICIAL_V141) throw new Error("official ai-migration-hub migration is not registered");

function createLedgerDatabase(rows: Array<{ version: number; name: string }> = []): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      appliedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const insert = db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
  for (const row of rows) insert.run(row.version, row.name);
  return db;
}

function ledgerRows(db: Database.Database, name: string): number[] {
  return (db.prepare("SELECT version FROM schema_migrations WHERE name = ?").all(name) as Array<{ version: number }>)
    .map((row) => row.version);
}

test("旧库把 fork 迁移占号记在官方版本上时，对账会释放该版本并恢复官方迁移", () => {
  const db = createLedgerDatabase([{ version: 141, name: "excel-univer-documents" }]);
  try {
    const pendingVersions = new Set(getPendingMigrations(db).map((migration) => migration.version));

    // 历史占号行被改写到保留段，不再占用官方 141。
    assert.deepEqual(ledgerRows(db, "excel-univer-documents"), [excelDocumentsMigration.version]);
    // 官方 v141 不再被误判为已应用。
    assert.ok(pendingVersions.has(OFFICIAL_V141.version));
    // fork 迁移已登记为当前版本，不会重复执行。
    assert.ok(!pendingVersions.has(excelDocumentsMigration.version));
  } finally {
    db.close();
  }
});

test("同名多行历史记录会被合并成唯一当前版本", () => {
  const db = createLedgerDatabase([
    { version: 141, name: "excel-univer-documents" },
    { version: 148, name: "excel-univer-documents" },
  ]);
  try {
    reconcileForkMigrationLedger(db);
    assert.deepEqual(ledgerRows(db, "excel-univer-documents"), [excelDocumentsMigration.version]);
  } finally {
    db.close();
  }
});

test("全新库不预登记 fork 迁移，仍由正常迁移流程执行", () => {
  const db = createLedgerDatabase();
  try {
    const pendingVersions = new Set(getPendingMigrations(db).map((migration) => migration.version));
    assert.ok(pendingVersions.has(excelDocumentsMigration.version));
    assert.deepEqual(ledgerRows(db, "excel-univer-documents"), []);
  } finally {
    db.close();
  }
});

test("已是当前版本且唯一时不重复写库", () => {
  const db = createLedgerDatabase([{ version: excelDocumentsMigration.version, name: "excel-univer-documents" }]);
  try {
    reconcileForkMigrationLedger(db);
    reconcileForkMigrationLedger(db);
    assert.deepEqual(ledgerRows(db, "excel-univer-documents"), [excelDocumentsMigration.version]);
  } finally {
    db.close();
  }
});

function createLegacyExcelDatabase(): Database.Database {
  const db = new Database(":memory:");
  // 模拟 fork v900001 时期创建的旧表：没有官方 v148 引入的 revision 列。
  db.exec(`
    CREATE TABLE excel_documents (
      noteId TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
    );
  `);
  return db;
}

function hasRevisionColumn(db: Database.Database): boolean {
  const columns = db.prepare("PRAGMA table_info(excel_documents)").all() as Array<{ name: string }>;
  return columns.some((column) => column.name === "revision");
}

test("旧库 excel_documents 缺 revision 列时自动补齐", () => {
  const db = createLegacyExcelDatabase();
  try {
    assert.equal(hasRevisionColumn(db), false);
    ensureForkExcelDocumentSchema(db);
    assert.equal(hasRevisionColumn(db), true);
    const column = (db.prepare("PRAGMA table_info(excel_documents)").all() as Array<{ name: string; dflt_value: string | null }>)
      .find((item) => item.name === "revision");
    assert.equal(column?.dflt_value, "1");
  } finally {
    db.close();
  }
});

test("已有 revision 列时保持幂等，不重复添加", () => {
  const db = createLegacyExcelDatabase();
  try {
    ensureForkExcelDocumentSchema(db);
    assert.doesNotThrow(() => ensureForkExcelDocumentSchema(db));
    assert.equal(hasRevisionColumn(db), true);
  } finally {
    db.close();
  }
});
