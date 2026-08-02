import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import {
  MIGRATIONS,
  getPendingMigrations,
  runMigrations,
} from "../src/db/migrations";

function createHistoricalBlockDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      contentFormat TEXT NOT NULL DEFAULT 'markdown',
      version INTEGER NOT NULL DEFAULT 1
    );

    -- Simulate the pre-v48 link schema. targetBlockId already existed in v38,
    -- while sourceBlockId and all generic block tables are intentionally absent.
    CREATE TABLE note_links (
      id TEXT PRIMARY KEY,
      sourceNoteId TEXT NOT NULL,
      targetNoteId TEXT NOT NULL,
      targetBlockId TEXT
    );

    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      appliedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function tableNames(db: Database.Database): Set<string> {
  const rows = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

test("detects a missing historical migration even when MAX(version) is newer", () => {
  const db = createHistoricalBlockDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
    );
    for (const migration of MIGRATIONS) {
      if (migration.version === 48 || migration.version === 63) continue;
      insert.run(migration.version, migration.name);
    }

    const latest = db.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number };
    assert.equal(latest.version, 62);
    assert.deepEqual(
      getPendingMigrations(db).map((migration) => migration.version),
      [48, 63],
    );
  } finally {
    db.close();
  }
});

test("repairs skipped block tables and records both migrations", () => {
  const db = createHistoricalBlockDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
    );
    for (const migration of MIGRATIONS) {
      if (migration.version === 48 || migration.version === 63) continue;
      insert.run(migration.version, migration.name);
    }

    assert.equal(runMigrations(db), 2);

    const tables = tableNames(db);
    for (const table of [
      "note_blocks_index",
      "block_operations",
      "note_block_documents",
      "note_block_records",
      "note_block_operations",
      "note_block_attachment_refs",
      "note_y_subdocument_manifests",
      "note_y_subdocuments",
      "note_y_subdocument_updates",
    ]) {
      assert.equal(tables.has(table), true, `missing repaired table: ${table}`);
    }

    const linkColumns = db.prepare("PRAGMA table_info(note_links)").all() as Array<{ name: string }>;
    assert.equal(linkColumns.some((column) => column.name === "sourceBlockId"), true);

    const manifestColumns = db.prepare(
      "PRAGMA table_info(note_y_subdocument_manifests)",
    ).all() as Array<{ name: string }>;
    assert.equal(manifestColumns.some((column) => column.name === "generation"), true);
    assert.equal(manifestColumns.some((column) => column.name === "structureVersion"), true);

    const applied = db.prepare(`
      SELECT version FROM schema_migrations WHERE version IN (48, 63) ORDER BY version
    `).all() as Array<{ version: number }>;
    assert.deepEqual(applied.map((row) => row.version), [48, 63]);
    assert.deepEqual(getPendingMigrations(db), []);
  } finally {
    db.close();
  }
});
