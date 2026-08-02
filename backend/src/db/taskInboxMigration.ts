import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const TASK_INBOX_SOURCE_TYPES = [
  "manual",
  "global",
  "selection",
  "note",
  "diary",
  "share",
  "other",
] as const;

export function ensureTaskInboxSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_inbox_items (
      taskId TEXT NOT NULL,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      capturedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      sourceType TEXT NOT NULL DEFAULT 'manual'
        CHECK (sourceType IN ('manual', 'global', 'selection', 'note', 'diary', 'share', 'other')),
      sourceId TEXT,
      sourceTitle TEXT,
      excerpt TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (taskId, userId),
      FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_inbox_user_scope_captured
      ON task_inbox_items(userId, workspaceId, capturedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_task_inbox_task
      ON task_inbox_items(taskId, capturedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_task_inbox_source
      ON task_inbox_items(userId, sourceType, sourceId);

    DROP TRIGGER IF EXISTS task_inbox_remove_after_task_complete;
    CREATE TRIGGER task_inbox_remove_after_task_complete
    AFTER UPDATE OF isCompleted ON tasks
    WHEN OLD.isCompleted = 0 AND NEW.isCompleted = 1
    BEGIN
      DELETE FROM task_inbox_items WHERE taskId = NEW.id;
    END;
  `);
}

export const taskInboxMigration: Migration = {
  version: 73,
  name: "personal-task-inbox-and-capture-source",
  up: ensureTaskInboxSchema,
};
