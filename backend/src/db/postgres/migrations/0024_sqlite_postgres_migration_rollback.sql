CREATE TABLE IF NOT EXISTS sqlite_postgres_migration_row_changes (
  "runId" TEXT NOT NULL REFERENCES sqlite_postgres_migration_runs(id) ON DELETE CASCADE,
  "tableName" TEXT NOT NULL,
  "primaryKey" JSONB NOT NULL,
  "primaryKeyHash" TEXT NOT NULL,
  "batchSequence" INTEGER NOT NULL CHECK ("batchSequence" >= 0),
  "changeKind" TEXT NOT NULL CHECK ("changeKind" IN ('inserted', 'updated')),
  "originalRow" JSONB,
  "migratedChecksum" TEXT NOT NULL,
  "rollbackStatus" TEXT NOT NULL DEFAULT 'planned'
    CHECK ("rollbackStatus" IN ('planned', 'rolled_back', 'failed')),
  "rollbackAttempts" INTEGER NOT NULL DEFAULT 0 CHECK ("rollbackAttempts" >= 0),
  "lastError" TEXT,
  "rolledBackAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("runId", "tableName", "primaryKeyHash"),
  FOREIGN KEY ("runId", "tableName")
    REFERENCES sqlite_postgres_migration_table_checkpoints ("runId", "tableName")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sqlite_pg_migration_row_changes_rollback
  ON sqlite_postgres_migration_row_changes (
    "runId",
    "rollbackStatus",
    "tableName",
    "batchSequence" DESC,
    "primaryKeyHash"
  );

ALTER TABLE sqlite_postgres_migration_runs
  ADD COLUMN IF NOT EXISTS "rollbackReport" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE sqlite_postgres_migration_runs
  ADD COLUMN IF NOT EXISTS "rollbackStartedAt" TIMESTAMPTZ;

ALTER TABLE sqlite_postgres_migration_runs
  ADD COLUMN IF NOT EXISTS "rolledBackAt" TIMESTAMPTZ;
