CREATE TABLE IF NOT EXISTS sqlite_postgres_migration_runs (
  id TEXT PRIMARY KEY,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "requestHash" TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('apply', 'verify', 'rollback')),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (
    status IN (
      'planned',
      'copying',
      'verifying',
      'completed',
      'failed',
      'cancelled',
      'rolling_back',
      'rolled_back'
    )
  ),
  "sourceFingerprint" TEXT NOT NULL,
  "sourcePathHint" TEXT NOT NULL,
  "sourceSchemaVersion" INTEGER NOT NULL DEFAULT 0,
  "sourceFileSize" BIGINT NOT NULL DEFAULT 0 CHECK ("sourceFileSize" >= 0),
  "sourceModifiedAt" TIMESTAMPTZ NOT NULL,
  "sourceSnapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
  plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  report JSONB NOT NULL DEFAULT '{}'::jsonb,
  "targetWasEmpty" BOOLEAN NOT NULL,
  "allowNonEmptyTarget" BOOLEAN NOT NULL DEFAULT FALSE,
  "currentTable" TEXT,
  "totalTables" INTEGER NOT NULL DEFAULT 0 CHECK ("totalTables" >= 0),
  "completedTables" INTEGER NOT NULL DEFAULT 0 CHECK ("completedTables" >= 0),
  "totalRows" BIGINT NOT NULL DEFAULT 0 CHECK ("totalRows" >= 0),
  "copiedRows" BIGINT NOT NULL DEFAULT 0 CHECK ("copiedRows" >= 0),
  "verifiedRows" BIGINT NOT NULL DEFAULT 0 CHECK ("verifiedRows" >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ,
  "lastError" TEXT,
  "startedAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sqlite_pg_migration_runs_claim
  ON sqlite_postgres_migration_runs ("availableAt", "leaseExpiresAt", "createdAt")
  WHERE status IN ('planned', 'copying', 'verifying', 'rolling_back', 'failed');

CREATE INDEX IF NOT EXISTS idx_sqlite_pg_migration_runs_source
  ON sqlite_postgres_migration_runs ("sourceFingerprint", "createdAt");

CREATE TABLE IF NOT EXISTS sqlite_postgres_migration_table_checkpoints (
  "runId" TEXT NOT NULL REFERENCES sqlite_postgres_migration_runs(id) ON DELETE CASCADE,
  "tableName" TEXT NOT NULL,
  "dependencyOrder" INTEGER NOT NULL CHECK ("dependencyOrder" >= 0),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned', 'copying', 'copied', 'verifying', 'verified', 'skipped', 'failed')
  ),
  "primaryKeyColumns" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "totalRows" BIGINT NOT NULL DEFAULT 0 CHECK ("totalRows" >= 0),
  "copiedRows" BIGINT NOT NULL DEFAULT 0 CHECK ("copiedRows" >= 0),
  "verifiedRows" BIGINT NOT NULL DEFAULT 0 CHECK ("verifiedRows" >= 0),
  "lastCursor" JSONB,
  "sourceChecksum" TEXT,
  "targetChecksum" TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ,
  "lastError" TEXT,
  "startedAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("runId", "tableName")
);

CREATE INDEX IF NOT EXISTS idx_sqlite_pg_migration_tables_claim
  ON sqlite_postgres_migration_table_checkpoints (
    "runId",
    "dependencyOrder",
    "availableAt",
    "leaseExpiresAt"
  )
  WHERE status IN ('planned', 'copying', 'failed');

CREATE TABLE IF NOT EXISTS sqlite_postgres_migration_batch_checkpoints (
  id TEXT PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "tableName" TEXT NOT NULL,
  "batchSequence" INTEGER NOT NULL CHECK ("batchSequence" >= 0),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned', 'writing', 'completed', 'failed')
  ),
  "cursorStart" JSONB,
  "cursorEnd" JSONB,
  "rowCount" BIGINT NOT NULL DEFAULT 0 CHECK ("rowCount" >= 0),
  checksum TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ,
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ,
  FOREIGN KEY ("runId", "tableName")
    REFERENCES sqlite_postgres_migration_table_checkpoints ("runId", "tableName")
    ON DELETE CASCADE,
  UNIQUE ("runId", "tableName", "batchSequence")
);

CREATE INDEX IF NOT EXISTS idx_sqlite_pg_migration_batches_table
  ON sqlite_postgres_migration_batch_checkpoints ("runId", "tableName", "batchSequence");
