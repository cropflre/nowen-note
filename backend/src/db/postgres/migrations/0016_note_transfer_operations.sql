-- Issue #249: durable cross-space note-transfer planning and idempotency.
--
-- This migration only introduces the operation state machine. Target note rows and
-- attachment objects are created by later staged-copy phases; keeping planning
-- separate prevents partially copied resources from becoming visible.
--
-- Resource IDs are intentionally stored as immutable snapshots rather than foreign
-- keys. A completed move must be able to delete its source note, and an abandoned
-- plan must never prevent normal notebook deletion.

CREATE TABLE IF NOT EXISTS note_transfer_operations (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('copy', 'move')),
    "sourceWorkspaceId" TEXT,
    "targetWorkspaceId" TEXT,
    "targetNotebookId" TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'prepared', 'staging', 'committing', 'completed', 'failed', 'cancelled'
    )),
    "includeAttachments" BOOLEAN NOT NULL DEFAULT true,
    "includeTags" BOOLEAN NOT NULL DEFAULT true,
    "sourceNoteCount" INTEGER NOT NULL CHECK ("sourceNoteCount" > 0),
    "sourceVersions" JSONB NOT NULL DEFAULT '{}'::jsonb,
    plan JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "expiresAt" TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    UNIQUE ("userId", "idempotencyKey")
);

CREATE TABLE IF NOT EXISTS note_transfer_operation_items (
    "operationId" TEXT NOT NULL REFERENCES note_transfer_operations(id) ON DELETE CASCADE,
    "sourceNoteId" TEXT NOT NULL,
    "targetNoteId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "itemOrder" INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN (
        'planned', 'staged', 'committed', 'failed', 'cancelled'
    )),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("operationId", "sourceNoteId"),
    UNIQUE ("operationId", "targetNoteId")
);

CREATE INDEX IF NOT EXISTS idx_note_transfer_operations_user_time
    ON note_transfer_operations ("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_note_transfer_operations_status_expiry
    ON note_transfer_operations (status, "expiresAt");
CREATE INDEX IF NOT EXISTS idx_note_transfer_items_source
    ON note_transfer_operation_items ("sourceNoteId", "createdAt" DESC);
