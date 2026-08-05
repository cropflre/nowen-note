ALTER TABLE note_transfer_operations
  ADD COLUMN IF NOT EXISTS orchestrationAttempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS orchestrationAvailableAt TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS orchestrationLeaseToken TEXT,
  ADD COLUMN IF NOT EXISTS orchestrationLeaseExpiresAt TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS orchestrationLastError TEXT,
  ADD COLUMN IF NOT EXISTS orchestrationLastAdvancedAt TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chk_note_transfer_orchestration_attempts'
  ) THEN
    ALTER TABLE note_transfer_operations
      ADD CONSTRAINT chk_note_transfer_orchestration_attempts
      CHECK (orchestrationAttempts >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_note_transfer_operations_orchestration_claim
  ON note_transfer_operations (
    orchestrationAvailableAt,
    orchestrationLeaseExpiresAt,
    updatedAt
  )
  WHERE status IN (
    'prepared',
    'staging',
    'target_committed',
    'source_deleting',
    'completed',
    'failed',
    'cancelled'
  );

CREATE INDEX IF NOT EXISTS idx_note_transfer_operations_orchestration_user
  ON note_transfer_operations (userId, idempotencyKey, orchestrationAvailableAt);
