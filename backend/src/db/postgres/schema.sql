\set ON_ERROR_STOP on

-- Existing PostgreSQL pilot databases may already have tasks without completedAt.
-- Add the column before replaying the idempotent baseline, otherwise the index in
-- the baseline would fail on an existing table.
DO $$
BEGIN
  IF to_regclass('public.tasks') IS NOT NULL THEN
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMPTZ;
  END IF;
END
$$;

\ir schema.base.sql
\ir migrations/0011_note_block_runtime.sql

CREATE TABLE IF NOT EXISTS task_activity_events (
  id TEXT PRIMARY KEY,
  "taskId" TEXT,
  "taskTitle" TEXT NOT NULL,
  "eventType" TEXT NOT NULL CHECK ("eventType" IN ('created', 'completed')),
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT,
  "projectId" TEXT,
  "occurredAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_activity_scope_time
  ON task_activity_events("workspaceId", "userId", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS idx_task_activity_task_type
  ON task_activity_events("taskId", "eventType", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS idx_task_activity_type_time
  ON task_activity_events("eventType", "occurredAt" DESC);
