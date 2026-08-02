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

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "estimatedMinutes" INTEGER;

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

CREATE TABLE IF NOT EXISTS task_day_plans (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "scopeKey" TEXT NOT NULL,
  "workspaceId" TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  "planDate" DATE NOT NULL,
  "taskIdsJson" TEXT NOT NULL DEFAULT '[]',
  "focusTaskIdsJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_day_plans_user_scope_date
  ON task_day_plans("userId", "scopeKey", "planDate");
CREATE INDEX IF NOT EXISTS idx_task_day_plans_user_date
  ON task_day_plans("userId", "planDate");

CREATE TABLE IF NOT EXISTS task_labels (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  "scopeKey" TEXT NOT NULL,
  name TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_labels_scope_name
  ON task_labels("scopeKey", "normalizedName");
CREATE INDEX IF NOT EXISTS idx_task_labels_workspace_sort
  ON task_labels("workspaceId", "sortOrder", "createdAt");
CREATE INDEX IF NOT EXISTS idx_task_labels_user_sort
  ON task_labels("userId", "sortOrder", "createdAt");

CREATE TABLE IF NOT EXISTS task_label_links (
  "taskId" TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  "labelId" TEXT NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("taskId", "labelId")
);

CREATE INDEX IF NOT EXISTS idx_task_label_links_label
  ON task_label_links("labelId", "taskId");

CREATE TABLE IF NOT EXISTS task_saved_views (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  "scopeKey" TEXT NOT NULL,
  name TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "filtersJson" TEXT NOT NULL DEFAULT '{}',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_saved_views_user_scope_name
  ON task_saved_views("userId", "scopeKey", "normalizedName");
CREATE INDEX IF NOT EXISTS idx_task_saved_views_user_scope_sort
  ON task_saved_views("userId", "scopeKey", "sortOrder", "createdAt");

CREATE TABLE IF NOT EXISTS task_time_blocks (
  id TEXT PRIMARY KEY,
  "taskId" TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  "startAt" TIMESTAMPTZ NOT NULL,
  "endAt" TIMESTAMPTZ NOT NULL,
  "timeZone" TEXT NOT NULL DEFAULT 'UTC',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ("endAt" > "startAt")
);

CREATE INDEX IF NOT EXISTS idx_task_time_blocks_user_scope_start
  ON task_time_blocks("userId", "workspaceId", "startAt", "endAt");
CREATE INDEX IF NOT EXISTS idx_task_time_blocks_task_user
  ON task_time_blocks("taskId", "userId", "startAt");

CREATE OR REPLACE FUNCTION inherit_recurring_task_estimate()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."repeatGeneratedFromId" IS NOT NULL AND NEW."estimatedMinutes" IS NULL THEN
    SELECT "estimatedMinutes"
      INTO NEW."estimatedMinutes"
      FROM tasks
      WHERE id = NEW."repeatGeneratedFromId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_inherit_estimate_before_recurrence_insert ON tasks;
CREATE TRIGGER tasks_inherit_estimate_before_recurrence_insert
BEFORE INSERT ON tasks
FOR EACH ROW
EXECUTE FUNCTION inherit_recurring_task_estimate();

CREATE TABLE IF NOT EXISTS task_inbox_items (
  "taskId" TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  "capturedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "sourceType" TEXT NOT NULL DEFAULT 'manual'
    CHECK ("sourceType" IN ('manual', 'global', 'selection', 'note', 'diary', 'share', 'other')),
  "sourceId" TEXT,
  "sourceTitle" TEXT,
  excerpt TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("taskId", "userId")
);

CREATE INDEX IF NOT EXISTS idx_task_inbox_user_scope_captured
  ON task_inbox_items("userId", "workspaceId", "capturedAt" DESC);
CREATE INDEX IF NOT EXISTS idx_task_inbox_task
  ON task_inbox_items("taskId", "capturedAt" DESC);
CREATE INDEX IF NOT EXISTS idx_task_inbox_source
  ON task_inbox_items("userId", "sourceType", "sourceId");

CREATE OR REPLACE FUNCTION clear_task_inbox_after_completion()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."isCompleted" = 0 AND NEW."isCompleted" = 1 THEN
    DELETE FROM task_inbox_items WHERE "taskId" = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_inbox_remove_after_task_complete ON tasks;
CREATE TRIGGER task_inbox_remove_after_task_complete
AFTER UPDATE OF "isCompleted" ON tasks
FOR EACH ROW
EXECUTE FUNCTION clear_task_inbox_after_completion();
