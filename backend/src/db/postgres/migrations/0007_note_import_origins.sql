CREATE TABLE IF NOT EXISTS note_import_origins (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT,
  "workspaceScope" TEXT NOT NULL,
  "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  "sourceType" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "contentHash" TEXT,
  "batchId" TEXT,
  "importedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ,
  metadata TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_note_import_origins_scope_external
  ON note_import_origins("userId", "workspaceScope", "sourceType", "externalId");

CREATE INDEX IF NOT EXISTS idx_note_import_origins_note
  ON note_import_origins("noteId");

CREATE INDEX IF NOT EXISTS idx_note_import_origins_batch
  ON note_import_origins("batchId");
