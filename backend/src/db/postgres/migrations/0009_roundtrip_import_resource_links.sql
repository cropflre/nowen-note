-- Runtime PostgreSQL migration for stable source-to-target mappings.
-- The main branch also carries a SQLite-version-aligned 0053-* file, but the
-- PostgreSQL runtime runner intentionally accepts only NNNN_name.sql files.

CREATE TABLE IF NOT EXISTS roundtrip_import_links (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT,
  "workspaceScope" TEXT NOT NULL,
  "sourceInstanceId" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL CHECK ("resourceType" IN ('notebook', 'note', 'attachment')),
  "sourceResourceId" TEXT NOT NULL,
  "targetResourceId" TEXT NOT NULL,
  "sourceHash" TEXT,
  "targetHash" TEXT,
  "lastExportBatchId" TEXT,
  "importedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_roundtrip_links_source
  ON roundtrip_import_links(
    "userId",
    "workspaceScope",
    "sourceInstanceId",
    "resourceType",
    "sourceResourceId"
  );
CREATE INDEX IF NOT EXISTS idx_roundtrip_links_target
  ON roundtrip_import_links("resourceType", "targetResourceId");
CREATE INDEX IF NOT EXISTS idx_roundtrip_links_batch
  ON roundtrip_import_links("lastExportBatchId");
