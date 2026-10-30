import type { Migration } from "./migrations.impl.js";
import { installSyncPersonalEntitiesTriggers } from "./syncPersonalEntitiesMigration.js";

export const taskRecurrenceDeletionMigration: Migration = {
  version: 126,
  name: "task-recurrence-deletion-intents",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_recurrence_state (
        groupId TEXT NOT NULL, scopeKey TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('stop','series')),
        updatedAt TEXT NOT NULL,
        PRIMARY KEY(groupId,scopeKey)
      );
      CREATE TABLE IF NOT EXISTS task_deletion_tombstones (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL, workspaceId TEXT,
        repeatGroupId TEXT, deletedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_repeat_scope ON tasks(repeatGroupId,workspaceId,userId);
    `);
    installSyncPersonalEntitiesTriggers(db);
  },
};
