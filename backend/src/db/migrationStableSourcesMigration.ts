import type { Migration } from "./migrations.impl.js";

export const migrationStableSourcesMigration: Migration = {
  version: 145,
  name: "migration-stable-source-identities",
  up(db) {
    // Keep already-running development upload sessions compatible with the final v143 schema.
    const columns = new Set((db.prepare("PRAGMA table_info(migration_upload_sessions)").all() as { name: string }[]).map((column) => column.name));
    for (const column of ["finalizeTokenId", "publishedIdentity", "error"]) {
      if (!columns.has(column)) db.exec(`ALTER TABLE migration_upload_sessions ADD COLUMN ${column} TEXT`);
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_migration_stable_source ON migration_items(json_extract(metadataJson,'$.source.platform'),json_extract(metadataJson,'$.source.sourceId'))");
    db.exec("CREATE INDEX IF NOT EXISTS idx_migration_origin_hash ON note_import_origins(userId,workspaceScope,contentHash)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_migration_item_target ON migration_items(targetNoteId,jobId) WHERE status='IMPORTED'");
  },
};
