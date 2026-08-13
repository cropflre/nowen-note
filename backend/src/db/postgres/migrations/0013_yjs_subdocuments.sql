CREATE TABLE IF NOT EXISTS note_y_subdocument_manifests (
  "noteId" TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  "rootGuid" TEXT NOT NULL,
  "rootSnapshot" BYTEA NOT NULL,
  "contentHash" TEXT NOT NULL,
  "sectionCount" INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  "structureVersion" INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'healthy',
  "mismatchReason" TEXT,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT note_y_subdocument_manifest_status
    CHECK (status IN ('healthy', 'mismatch'))
);

CREATE TABLE IF NOT EXISTS note_y_subdocuments (
  "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  "sectionId" TEXT NOT NULL,
  guid TEXT NOT NULL,
  "blockStart" INTEGER NOT NULL,
  "blockEnd" INTEGER NOT NULL,
  "snapshotBlob" BYTEA NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("noteId", "sectionId"),
  UNIQUE ("noteId", guid),
  CONSTRAINT note_y_subdocument_block_range
    CHECK ("blockStart" >= 0 AND "blockEnd" >= "blockStart")
);

CREATE INDEX IF NOT EXISTS idx_note_y_subdocuments_order
  ON note_y_subdocuments ("noteId", "blockStart");

CREATE TABLE IF NOT EXISTS note_y_subdocument_updates (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "noteId" TEXT NOT NULL,
  "sectionId" TEXT NOT NULL,
  "userId" TEXT REFERENCES users(id) ON DELETE SET NULL,
  "updateBlob" BYTEA NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("noteId", "sectionId")
    REFERENCES note_y_subdocuments ("noteId", "sectionId")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_y_subdocument_updates_section
  ON note_y_subdocument_updates ("noteId", "sectionId", id);
