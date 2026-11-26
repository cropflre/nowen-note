import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { excelDocumentsMigration } from "../src/db/excelDocumentsMigration";
import { reconcileForkMigrationLedger } from "../src/db/forkMigrationCompat";
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
