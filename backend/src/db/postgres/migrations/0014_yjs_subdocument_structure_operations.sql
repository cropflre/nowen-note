CREATE TABLE IF NOT EXISTS note_y_subdocument_structure_operations (
  "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  "operationId" TEXT NOT NULL,
  "userId" TEXT REFERENCES users(id) ON DELETE SET NULL,
  "baseGeneration" INTEGER NOT NULL,
  "resultGeneration" INTEGER NOT NULL,
  "resultStructureVersion" INTEGER NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "contentHash" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("noteId", "operationId"),
  CONSTRAINT note_y_subdocument_structure_generation_order
    CHECK ("resultGeneration" > "baseGeneration"),
  CONSTRAINT note_y_subdocument_structure_versions_positive
    CHECK (
      "baseGeneration" >= 1
      AND "resultGeneration" >= 2
      AND "resultStructureVersion" >= 2
      AND "resultVersion" >= 1
    )
);

CREATE INDEX IF NOT EXISTS idx_note_y_subdocument_structure_operations_created
  ON note_y_subdocument_structure_operations ("noteId", "createdAt" DESC);
