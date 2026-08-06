CREATE TABLE IF NOT EXISTS postgres_migration_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_postgres_migration_state_updated
  ON postgres_migration_state("updatedAt" DESC);
