import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export function ensureRoundTripImportLinksSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roundtrip_import_links (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      workspaceScope TEXT NOT NULL,
      sourceInstanceId TEXT NOT NULL,
      resourceType TEXT NOT NULL CHECK (resourceType IN ('notebook', 'note', 'attachment')),
      sourceResourceId TEXT NOT NULL,
      targetResourceId TEXT NOT NULL,
      sourceHash TEXT,
      targetHash TEXT,
      lastExportBatchId TEXT,
      importedAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_roundtrip_links_source
      ON roundtrip_import_links(
        userId,
        workspaceScope,
        sourceInstanceId,
        resourceType,
        sourceResourceId
      );
    CREATE INDEX IF NOT EXISTS idx_roundtrip_links_target
      ON roundtrip_import_links(resourceType, targetResourceId);
    CREATE INDEX IF NOT EXISTS idx_roundtrip_links_batch
      ON roundtrip_import_links(lastExportBatchId);
  `);
}

export const roundTripImportLinksMigration: Migration = {
  version: 53,
  name: "roundtrip-import-resource-links",
  up: ensureRoundTripImportLinksSchema,
};
