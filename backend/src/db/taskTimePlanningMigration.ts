import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export function ensureTaskTimePlanningSchema(db: Database.Database): void {
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!taskColumns.some((column) => column.name === "estimatedMinutes")) {
    db.prepare("ALTER TABLE tasks ADD COLUMN estimatedMinutes INTEGER").run();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_time_blocks (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      startAt TEXT NOT NULL,
      endAt TEXT NOT NULL,
      timeZone TEXT NOT NULL DEFAULT 'UTC',
      createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (endAt > startAt),
      FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_time_blocks_user_scope_start
      ON task_time_blocks(userId, workspaceId, startAt, endAt);
    CREATE INDEX IF NOT EXISTS idx_task_time_blocks_task_user
      ON task_time_blocks(taskId, userId, startAt);

    DROP TRIGGER IF EXISTS tasks_inherit_estimate_after_recurrence_insert;
    CREATE TRIGGER tasks_inherit_estimate_after_recurrence_insert
    AFTER INSERT ON tasks
    WHEN NEW.repeatGeneratedFromId IS NOT NULL AND NEW.estimatedMinutes IS NULL
    BEGIN
      UPDATE tasks
      SET estimatedMinutes = (
        SELECT estimatedMinutes FROM tasks WHERE id = NEW.repeatGeneratedFromId
      )
      WHERE id = NEW.id;
    END;
  `);
}

export const taskTimePlanningMigration: Migration = {
  version: 72,
  name: "task-estimates-and-time-blocks",
  up: ensureTaskTimePlanningSchema,
};
