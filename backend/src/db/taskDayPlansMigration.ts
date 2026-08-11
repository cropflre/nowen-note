import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export function ensureTaskDayPlansSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_day_plans (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      scopeKey TEXT NOT NULL,
      workspaceId TEXT,
      planDate TEXT NOT NULL,
      taskIdsJson TEXT NOT NULL DEFAULT '[]',
      focusTaskIdsJson TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_day_plans_user_scope_date
      ON task_day_plans(userId, scopeKey, planDate);
    CREATE INDEX IF NOT EXISTS idx_task_day_plans_user_date
      ON task_day_plans(userId, planDate);
  `);
}

export const taskDayPlansMigration: Migration = {
  version: 70,
  name: "task-day-plans",
  up: ensureTaskDayPlansSchema,
};
