-- Issue #249: durable post-commit effects for note transfers.
--
-- The completion trigger runs inside the same transaction that makes the target copy
-- visible. Workers use independent leases and stable event keys, so audit, webhook and
-- realtime delivery can be retried after crashes without inventing new identities.

CREATE TABLE IF NOT EXISTS note_transfer_effect_outbox (
  id TEXT PRIMARY KEY,
  "operationId" TEXT NOT NULL REFERENCES note_transfer_operations(id) ON DELETE CASCADE,
  "actorUserId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('audit', 'webhook', 'realtime')),
  "destinationId" TEXT NOT NULL DEFAULT '',
  "destinationUrl" TEXT NOT NULL DEFAULT '',
  "destinationSecret" TEXT NOT NULL DEFAULT '',
  "eventType" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ,
  "lastError" TEXT,
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("operationId", channel, "destinationId")
);

CREATE INDEX IF NOT EXISTS idx_note_transfer_effect_outbox_claim
  ON note_transfer_effect_outbox(status, "availableAt", "leaseExpiresAt", "createdAt");

CREATE INDEX IF NOT EXISTS idx_note_transfer_effect_outbox_operation
  ON note_transfer_effect_outbox("operationId", status, channel);

CREATE OR REPLACE FUNCTION enqueue_note_transfer_completed_effects()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  effect_payload JSONB;
  event_key_prefix TEXT;
BEGIN
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  event_key_prefix := NEW.id || ':note.transfer.completed';
  effect_payload := COALESCE(NEW.result, '{}'::jsonb) || jsonb_build_object(
    'eventId', event_key_prefix,
    'kind', 'note.transfer.completed',
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
    'note.transfer.completed', event_key_prefix || ':audit', effect_payload
  ) ON CONFLICT DO NOTHING;

  INSERT INTO note_transfer_effect_outbox (
    id, "operationId", "actorUserId", channel, "destinationId",
    "eventType", "eventKey", payload
  ) VALUES (
    NEW.id || ':effect:realtime', NEW.id, NEW."userId", 'realtime', '',
    'note.transfer.completed', event_key_prefix || ':realtime', effect_payload
  ) ON CONFLICT DO NOTHING;

  INSERT INTO note_transfer_effect_outbox (
    id, "operationId", "actorUserId", channel, "destinationId",
    "destinationUrl", "destinationSecret", "eventType", "eventKey", payload
  )
  SELECT NEW.id || ':effect:webhook:' || webhook.id,
         NEW.id, NEW."userId", 'webhook', webhook.id,
         webhook.url, webhook.secret, 'note.transfer.completed',
         event_key_prefix || ':webhook:' || webhook.id, effect_payload
    FROM webhooks webhook
   WHERE webhook."userId" = NEW."userId"
     AND webhook."isActive" = true
     AND (
       webhook.events = '*'
       OR webhook.events LIKE '%"*"%'
       OR webhook.events LIKE '%"note.transfer.completed"%'
     )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_note_transfer_completed_effects ON note_transfer_operations;
CREATE TRIGGER trg_note_transfer_completed_effects
AFTER UPDATE OF status ON note_transfer_operations
FOR EACH ROW
EXECUTE FUNCTION enqueue_note_transfer_completed_effects();

-- Backfill effects for operations completed before this migration was installed.
INSERT INTO note_transfer_effect_outbox (
  id, "operationId", "actorUserId", channel, "destinationId",
  "eventType", "eventKey", payload
)
SELECT operation.id || ':effect:audit', operation.id, operation."userId",
       'audit', '', 'note.transfer.completed',
       operation.id || ':note.transfer.completed:audit',
       COALESCE(operation.result, '{}'::jsonb) || jsonb_build_object(
         'eventId', operation.id || ':note.transfer.completed',
         'kind', 'note.transfer.completed',
         'operationId', operation.id,
         'actorUserId', operation."userId",
         'mode', operation.mode,
         'sourceWorkspaceId', operation."sourceWorkspaceId",
         'targetWorkspaceId', operation."targetWorkspaceId",
         'targetNotebookId', operation."targetNotebookId",
         'sourceNoteIds', COALESCE(operation.plan -> 'sourceNoteIds', '[]'::jsonb)
       )
  FROM note_transfer_operations operation
 WHERE operation.status = 'completed'
ON CONFLICT DO NOTHING;

INSERT INTO note_transfer_effect_outbox (
  id, "operationId", "actorUserId", channel, "destinationId",
  "eventType", "eventKey", payload
)
SELECT operation.id || ':effect:realtime', operation.id, operation."userId",
       'realtime', '', 'note.transfer.completed',
       operation.id || ':note.transfer.completed:realtime',
       COALESCE(operation.result, '{}'::jsonb) || jsonb_build_object(
         'eventId', operation.id || ':note.transfer.completed',
         'kind', 'note.transfer.completed',
         'operationId', operation.id,
         'actorUserId', operation."userId",
         'mode', operation.mode,
         'sourceWorkspaceId', operation."sourceWorkspaceId",
         'targetWorkspaceId', operation."targetWorkspaceId",
         'targetNotebookId', operation."targetNotebookId",
         'sourceNoteIds', COALESCE(operation.plan -> 'sourceNoteIds', '[]'::jsonb)
       )
  FROM note_transfer_operations operation
 WHERE operation.status = 'completed'
ON CONFLICT DO NOTHING;

INSERT INTO note_transfer_effect_outbox (
  id, "operationId", "actorUserId", channel, "destinationId",
  "destinationUrl", "destinationSecret", "eventType", "eventKey", payload
)
SELECT operation.id || ':effect:webhook:' || webhook.id,
       operation.id, operation."userId", 'webhook', webhook.id,
       webhook.url, webhook.secret, 'note.transfer.completed',
       operation.id || ':note.transfer.completed:webhook:' || webhook.id,
       COALESCE(operation.result, '{}'::jsonb) || jsonb_build_object(
         'eventId', operation.id || ':note.transfer.completed',
         'kind', 'note.transfer.completed',
         'operationId', operation.id,
         'actorUserId', operation."userId",
         'mode', operation.mode,
         'sourceWorkspaceId', operation."sourceWorkspaceId",
         'targetWorkspaceId', operation."targetWorkspaceId",
         'targetNotebookId', operation."targetNotebookId",
         'sourceNoteIds', COALESCE(operation.plan -> 'sourceNoteIds', '[]'::jsonb)
       )
  FROM note_transfer_operations operation
  JOIN webhooks webhook
    ON webhook."userId" = operation."userId"
   AND webhook."isActive" = true
   AND (
     webhook.events = '*'
     OR webhook.events LIKE '%"*"%'
     OR webhook.events LIKE '%"note.transfer.completed"%'
   )
 WHERE operation.status = 'completed'
ON CONFLICT DO NOTHING;
