CREATE TABLE IF NOT EXISTS note_transfer_staged_attachments (
  "operationId" TEXT NOT NULL REFERENCES note_transfer_operations(id) ON DELETE CASCADE,
  "sourceAttachmentId" TEXT NOT NULL,
  "sourceNoteId" TEXT NOT NULL,
  "targetAttachmentId" TEXT NOT NULL,
  "targetNoteId" TEXT NOT NULL,
  "sourcePath" TEXT NOT NULL,
  "stagedPath" TEXT NOT NULL,
  filename TEXT NOT NULL,
  "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
  size BIGINT NOT NULL CHECK (size >= 0),
  hash TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'copying', 'staged', 'committed', 'failed', 'cleaned')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("operationId", "sourceAttachmentId"),
  UNIQUE ("operationId", "targetAttachmentId"),
  UNIQUE ("operationId", "stagedPath")
);

CREATE INDEX IF NOT EXISTS idx_note_transfer_staged_attachments_operation_status
  ON note_transfer_staged_attachments("operationId", status, "sourceAttachmentId");

CREATE INDEX IF NOT EXISTS idx_note_transfer_staged_attachments_source_note
  ON note_transfer_staged_attachments("sourceNoteId", "operationId");
