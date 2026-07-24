CREATE TABLE IF NOT EXISTS note_blocks_index (
  "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  "blockId" TEXT NOT NULL,
  "blockType" TEXT NOT NULL,
  "parentBlockId" TEXT,
  "blockOrder" INTEGER NOT NULL DEFAULT 0,
  "plainText" TEXT NOT NULL DEFAULT '',
  "contentHash" TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  "startOffset" INTEGER,
  "endOffset" INTEGER,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("noteId", "blockId")
);

CREATE INDEX IF NOT EXISTS idx_note_blocks_block_id
  ON note_blocks_index("blockId");
CREATE INDEX IF NOT EXISTS idx_note_blocks_note_order
  ON note_blocks_index("noteId", "blockOrder");
CREATE INDEX IF NOT EXISTS idx_note_blocks_hash
  ON note_blocks_index("noteId", "blockType", "contentHash");

CREATE TABLE IF NOT EXISTS block_operations (
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "operationId" TEXT NOT NULL,
  "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  "resultJson" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("userId", "operationId")
);

CREATE INDEX IF NOT EXISTS idx_block_operations_note
  ON block_operations("noteId", "createdAt" DESC);
