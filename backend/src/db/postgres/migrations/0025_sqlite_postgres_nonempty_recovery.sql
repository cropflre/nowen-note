DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname
    INTO constraint_name
    FROM pg_constraint
   WHERE conrelid = 'sqlite_postgres_migration_row_changes'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%changeKind%'
   LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE sqlite_postgres_migration_row_changes DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;
END $$;

ALTER TABLE sqlite_postgres_migration_row_changes
  ADD CONSTRAINT sqlite_postgres_migration_row_changes_kind_check
  CHECK ("changeKind" IN ('inserted', 'updated', 'unchanged'));

ALTER TABLE sqlite_postgres_migration_row_changes
  ADD COLUMN IF NOT EXISTS "migratedRow" JSONB;

CREATE INDEX IF NOT EXISTS idx_sqlite_pg_migration_row_changes_kind
  ON sqlite_postgres_migration_row_changes ("runId", "changeKind", "tableName");
