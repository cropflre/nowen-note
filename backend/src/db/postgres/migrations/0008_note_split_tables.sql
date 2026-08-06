CREATE TABLE IF NOT EXISTS note_split_operations (
  id TEXT PRIMARY KEY,
  "sourceNoteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  "actorUserId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "originalVersion" INTEGER NOT NULL,
  "directoryVersion" INTEGER NOT NULL,
  "originalTitle" TEXT NOT NULL,
  "originalContent" TEXT NOT NULL,
  "originalContentText" TEXT NOT NULL,
  "originalContentFormat" TEXT NOT NULL,
  "headingLevel" INTEGER NOT NULL CHECK ("headingLevel" IN (1, 2)),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'undone')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "undoneAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS note_split_items (
  "operationId" TEXT NOT NULL REFERENCES note_split_operations(id) ON DELETE CASCADE,
  "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  "sortOrder" INTEGER NOT NULL,
  "createdVersion" INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  PRIMARY KEY ("operationId", "noteId")
);

CREATE TABLE IF NOT EXISTS note_split_attachment_copies (
  "operationId" TEXT NOT NULL REFERENCES note_split_operations(id) ON DELETE CASCADE,
  "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  "sourceAttachmentId" TEXT NOT NULL,
  "attachmentId" TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('moved', 'copy')),
  PRIMARY KEY ("operationId", "attachmentId")
);

CREATE INDEX IF NOT EXISTS idx_note_split_operations_source
  ON note_split_operations("sourceNoteId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_note_split_items_operation
  ON note_split_items("operationId", "sortOrder" ASC);

CREATE INDEX IF NOT EXISTS idx_note_split_attachment_operation
  ON note_split_attachment_copies("operationId", "noteId");
