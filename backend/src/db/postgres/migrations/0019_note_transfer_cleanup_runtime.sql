-- Issue #249: recoverable cleanup for abandoned note-transfer staging objects.
--
-- Cleanup state is independent from staging state so copy attempts and delete attempts
-- remain separately observable. Completed copy operations mark their objects retained;
-- only cancelled/failed operations may lease cleanup work.

ALTER TABLE note_transfer_staged_attachments
  ADD COLUMN IF NOT EXISTS "cleanupStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE note_transfer_staged_attachments
  ADD COLUMN IF NOT EXISTS "cleanupAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE note_transfer_staged_attachments
  ADD COLUMN IF NOT EXISTS "cleanupLeaseToken" TEXT;
ALTER TABLE note_transfer_staged_attachments
  ADD COLUMN IF NOT EXISTS "cleanupLeaseExpiresAt" TIMESTAMPTZ;
ALTER TABLE note_transfer_staged_attachments
  ADD COLUMN IF NOT EXISTS "cleanupLastError" TEXT;
ALTER TABLE note_transfer_staged_attachments
  ADD COLUMN IF NOT EXISTS "cleanedAt" TIMESTAMPTZ;

ALTER TABLE note_transfer_staged_attachments
  DROP CONSTRAINT IF EXISTS note_transfer_staged_attachments_cleanup_status_check;
ALTER TABLE note_transfer_staged_attachments
  ADD CONSTRAINT note_transfer_staged_attachments_cleanup_status_check
  CHECK ("cleanupStatus" IN ('pending', 'cleaning', 'cleaned', 'failed', 'retained'));

ALTER TABLE note_transfer_staged_attachments
  DROP CONSTRAINT IF EXISTS note_transfer_staged_attachments_cleanup_attempts_check;
ALTER TABLE note_transfer_staged_attachments
  ADD CONSTRAINT note_transfer_staged_attachments_cleanup_attempts_check
  CHECK ("cleanupAttempts" >= 0);

UPDATE note_transfer_staged_attachments
   SET "cleanupStatus" = 'retained'
 WHERE status = 'committed'
   AND "cleanupStatus" <> 'retained';

CREATE INDEX IF NOT EXISTS idx_note_transfer_staged_attachments_cleanup_lease
  ON note_transfer_staged_attachments(
    "cleanupStatus", "cleanupLeaseExpiresAt", "operationId", "sourceAttachmentId"
  );
