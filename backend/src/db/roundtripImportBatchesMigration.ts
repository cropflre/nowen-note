import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl";

export function ensureRoundTripImportBatchesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roundtrip_import_batches (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      workspaceScope TEXT NOT NULL,
      importMode TEXT NOT NULL,
      packageKind TEXT,
      sourceInstanceId TEXT,
      sourceExportBatchId TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'undone')),
      previewJson TEXT NOT NULL DEFAULT '{}',
      resultJson TEXT NOT NULL DEFAULT '{}',
      undoStateJson TEXT NOT NULL DEFAULT '{}',
      undoAvailable INTEGER NOT NULL DEFAULT 0,
      undoUnavailableReason TEXT,
      undoExpiresAt TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      completedAt TEXT,
      undoneAt TEXT,
      undoError TEXT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_roundtrip_import_batches_user_time
      ON roundtrip_import_batches(userId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_roundtrip_import_batches_scope_time
      ON roundtrip_import_batches(workspaceScope, userId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_roundtrip_import_batches_source
      ON roundtrip_import_batches(userId, workspaceScope, sourceInstanceId, createdAt DESC);
  `);
}

export const roundTripImportBatchesMigration: Migration = {
  version: 54,
  name: "roundtrip-import-batches",
  up: ensureRoundTripImportBatchesSchema,
};
