-- Runtime PostgreSQL migration for reversible round-trip import batches.
-- Kept separately from the main branch's SQLite-version-aligned 0054-* file
-- because the runtime migration loader accepts only NNNN_name.sql filenames.

CREATE TABLE IF NOT EXISTS roundtrip_import_batches (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT,
  "workspaceScope" TEXT NOT NULL,
  "importMode" TEXT NOT NULL,
  "packageKind" TEXT,
  "sourceInstanceId" TEXT,
  "sourceExportBatchId" TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'undone')),
  "previewJson" TEXT NOT NULL DEFAULT '{}',
  "resultJson" TEXT NOT NULL DEFAULT '{}',
  "undoStateJson" TEXT NOT NULL DEFAULT '{}',
  "undoAvailable" BOOLEAN NOT NULL DEFAULT false,
  "undoUnavailableReason" TEXT,
  "undoExpiresAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ,
  "undoneAt" TIMESTAMPTZ,
  "undoError" TEXT
);

CREATE INDEX IF NOT EXISTS idx_roundtrip_import_batches_user_time
  ON roundtrip_import_batches("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_roundtrip_import_batches_scope_time
  ON roundtrip_import_batches("workspaceScope", "userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_roundtrip_import_batches_source
  ON roundtrip_import_batches("userId", "workspaceScope", "sourceInstanceId", "createdAt" DESC);
