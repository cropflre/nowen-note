import type { Migration } from "./migrations.impl.js";

/** Additive job ledger. Content and temporary uploads remain outside the database. */
export const migrationHubMigration: Migration = {
  version: 141,
  name: "ai-migration-hub",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS migration_jobs (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        operationId TEXT NOT NULL,
        requestHash TEXT NOT NULL,
        tokenId TEXT,
        workspaceId TEXT,
        targetNotebookId TEXT,
        name TEXT NOT NULL,
        sourceJson TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'CREATED',
        previewDigest TEXT,
        previewExpiresAt TEXT,
        approvedBySession TEXT,
        rootNotebookId TEXT,
        warningsJson TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        stagedBytes INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(userId, operationId)
      );
      CREATE INDEX IF NOT EXISTS idx_migration_jobs_owner ON migration_jobs(userId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_migration_jobs_status ON migration_jobs(status, updatedAt);
      CREATE TABLE IF NOT EXISTS migration_items (
        id TEXT PRIMARY KEY,
        jobId TEXT NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
        sourceKey TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        payloadHash TEXT NOT NULL,
        metadataJson TEXT NOT NULL,
        contentPath TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'STAGED',
        action TEXT NOT NULL DEFAULT 'create',
        targetNoteId TEXT,
        error TEXT,
        warningsJson TEXT NOT NULL DEFAULT '[]',
        UNIQUE(jobId, sourceKey)
      );
      CREATE INDEX IF NOT EXISTS idx_migration_items_job ON migration_items(jobId, status, id);
      CREATE TABLE IF NOT EXISTS migration_assets (
        jobId TEXT NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY(jobId, path)
      );
      CREATE TABLE IF NOT EXISTS migration_resources (
        jobId TEXT NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        pathKey TEXT,
        fingerprint TEXT,
        PRIMARY KEY(jobId, resourceType, resourceId),
        UNIQUE(jobId, resourceType, pathKey)
      );
      CREATE TABLE IF NOT EXISTS migration_uploads (
        id TEXT PRIMARY KEY,
        jobId TEXT NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING'
      );
      CREATE TABLE IF NOT EXISTS migration_objects (
        path TEXT PRIMARY KEY,
        jobId TEXT NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
        itemId TEXT NOT NULL REFERENCES migration_items(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'STAGED'
      );
    `);
  },
};

// Hot-reloaded development instances may already have applied the first v141 draft.
export const migrationHubRecoveryLedgerMigration: Migration = {
  version: 142,
  name: "ai-migration-recovery-ledger",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(migration_jobs)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "stagedBytes")) db.exec("ALTER TABLE migration_jobs ADD COLUMN stagedBytes INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE migration_jobs SET stagedBytes = COALESCE((SELECT SUM(json_extract(metadataJson,'$.contentBytes') + length(CAST(metadataJson AS BLOB))) FROM migration_items WHERE jobId=migration_jobs.id),0) WHERE stagedBytes=0;
      CREATE TABLE IF NOT EXISTS migration_objects (
        path TEXT PRIMARY KEY,
        jobId TEXT NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
        itemId TEXT NOT NULL REFERENCES migration_items(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'STAGED'
      );
    `);
  },
};
