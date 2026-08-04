ALTER TABLE note_transfer_staged_attachments
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "verifiedSize" BIGINT CHECK ("verifiedSize" IS NULL OR "verifiedSize" >= 0),
  ADD COLUMN IF NOT EXISTS "verifiedHash" TEXT,
  ADD COLUMN IF NOT EXISTS "stagedAt" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_note_transfer_staged_attachments_lease
  ON note_transfer_staged_attachments("operationId", status, "leaseExpiresAt", "sourceAttachmentId");
