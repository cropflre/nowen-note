import type { Migration } from "./migrations.impl.js";

export const migrationUploadSessionsMigration: Migration = {
  version: 143,
  name: "migration-resumable-upload-sessions",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS migration_upload_sessions (
        id TEXT PRIMARY KEY,
        jobId TEXT NOT NULL REFERENCES migration_jobs(id) ON DELETE CASCADE,
        operationId TEXT NOT NULL,
        requestHash TEXT NOT NULL,
        tokenId TEXT,
        finalizeTokenId TEXT,
        filename TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        assetPath TEXT,
        offset INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'OPEN',
        published INTEGER NOT NULL DEFAULT 0,
        publishedIdentity TEXT,
        error TEXT,
        leaseId TEXT,
        leaseExpiresAt TEXT,
        expiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(jobId, operationId)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_migration_upload_session_active
        ON migration_upload_sessions(jobId) WHERE status IN ('OPEN','FINALIZING');
      CREATE INDEX IF NOT EXISTS idx_migration_upload_session_expiry ON migration_upload_sessions(status,expiresAt);
      CREATE TABLE IF NOT EXISTS migration_upload_chunks (
        uploadId TEXT NOT NULL REFERENCES migration_upload_sessions(id) ON DELETE CASCADE,
        offset INTEGER NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY(uploadId,offset)
      );
    `);
  },
};
