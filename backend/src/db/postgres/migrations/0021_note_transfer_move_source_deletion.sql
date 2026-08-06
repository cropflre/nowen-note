-- Issue #249: durable source deletion and recovery for cross-space moves.
--
-- A move first materializes and publishes its target copy. Source rows are only
-- claimed after all target-commit effects complete. Database deletion and the
-- transition to physical cleanup share one transaction; attachment paths are
-- snapshotted before deletion so a crash cannot orphan source files forever.

ALTER TABLE note_transfer_operations
  DROP CONSTRAINT IF EXISTS note_transfer_operations_status_check;
ALTER TABLE note_transfer_operations
  ADD CONSTRAINT note_transfer_operations_status_check CHECK (status IN (
    'prepared', 'staging', 'committing', 'target_committed',
    'source_deleting', 'completed', 'failed', 'cancelled'
  ));

CREATE TABLE IF NOT EXISTS note_transfer_move_source_deletions (
  "operationId" TEXT NOT NULL REFERENCES note_transfer_operations(id) ON DELETE CASCADE,
  "sourceNoteId" TEXT NOT NULL,
  "sourceVersion" INTEGER NOT NULL,
  "sourceWorkspaceId" TEXT,
  "sourceNotebookId" TEXT NOT NULL,
  "sourceAttachmentCandidates" JSONB NOT NULL DEFAULT '[]'::jsonb,
  stage TEXT NOT NULL DEFAULT 'database' CHECK (stage IN ('database', 'cleanup')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ,
  "lastError" TEXT,
  "cleanupWarnings" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "databaseDeletedAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("operationId", "sourceNoteId")
);

CREATE INDEX IF NOT EXISTS idx_note_transfer_move_source_claim
  ON note_transfer_move_source_deletions(
    status, stage, "availableAt", "leaseExpiresAt", "createdAt"
  );
CREATE INDEX IF NOT EXISTS idx_note_transfer_move_source_operation
  ON note_transfer_move_source_deletions("operationId", status, stage);

-- Copy operations keep the original completion event. Move operations publish a
-- target-committed event before source deletion, avoiding a misleading completed
-- notification while the source still exists.
CREATE OR REPLACE FUNCTION enqueue_note_transfer_completed_effects()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  effect_payload JSONB;
  effect_event_type TEXT;
  event_key_prefix TEXT;
BEGIN
  IF NEW.mode = 'copy' THEN
    IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN
      RETURN NEW;
    END IF;
    effect_event_type := 'note.transfer.completed';
  ELSIF NEW.mode = 'move' THEN
    IF NEW.status <> 'target_committed' OR OLD.status = 'target_committed' THEN
      RETURN NEW;
    END IF;
    effect_event_type := 'note.transfer.target_committed';
  ELSE
    RETURN NEW;
  END IF;

  event_key_prefix := NEW.id || ':' || effect_event_type;
  effect_payload := COALESCE(NEW.result, '{}'::jsonb) || jsonb_build_object(
    'eventId', event_key_prefix,
    'kind', effect_event_type,
    'operationId', NEW.id,
    'actorUserId', NEW."userId",
    'mode', NEW.mode,
    'sourceWorkspaceId', NEW."sourceWorkspaceId",
    'targetWorkspaceId', NEW."targetWorkspaceId",
    'targetNotebookId', NEW."targetNotebookId",
    'sourceNoteIds', COALESCE(NEW.plan -> 'sourceNoteIds', '[]'::jsonb)
  );

  INSERT INTO note_transfer_effect_outbox (
    id, "operationId", "actorUserId", channel, "destinationId",
    "eventType", "eventKey", payload
  ) VALUES (
    NEW.id || ':effect:audit', NEW.id, NEW."userId", 'audit', '',
    effect_event_type, event_key_prefix || ':audit', effect_payload
  ) ON CONFLICT DO NOTHING;

  INSERT INTO note_transfer_effect_outbox (
    id, "operationId", "actorUserId", channel, "destinationId",
    "eventType", "eventKey", payload
  ) VALUES (
    NEW.id || ':effect:realtime', NEW.id, NEW."userId", 'realtime', '',
    effect_event_type, event_key_prefix || ':realtime', effect_payload
  ) ON CONFLICT DO NOTHING;

  INSERT INTO note_transfer_effect_outbox (
    id, "operationId", "actorUserId", channel, "destinationId",
    "destinationUrl", "destinationSecret", "eventType", "eventKey", payload
  )
  SELECT NEW.id || ':effect:webhook:' || webhook.id,
         NEW.id, NEW."userId", 'webhook', webhook.id,
         webhook.url, webhook.secret, effect_event_type,
         event_key_prefix || ':webhook:' || webhook.id, effect_payload
    FROM webhooks webhook
   WHERE webhook."userId" = NEW."userId"
     AND webhook."isActive" = true
     AND (
       webhook.events = '*'
       OR webhook.events LIKE '%"*"%'
       OR webhook.events LIKE ('%"' || effect_event_type || '"%')
     )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;
