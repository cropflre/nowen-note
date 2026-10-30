import type { Migration } from "./migrations.impl.js";
import { installSyncPersonalEntitiesTriggers } from "./syncPersonalEntitiesMigration.js";

export const taskLifecycleMigration: Migration = {
  version: 124,
  name: "task-archive-and-note-snapshots",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "archivedAt")) {
      db.exec("ALTER TABLE tasks ADD COLUMN archivedAt TEXT");
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_scope_archive ON tasks(workspaceId,userId,archivedAt);
      CREATE TABLE IF NOT EXISTS task_note_snapshots (
        requestId TEXT PRIMARY KEY, userId TEXT NOT NULL, taskId TEXT NOT NULL,
        noteId TEXT NOT NULL, fingerprint TEXT NOT NULL
      )`);
    installSyncPersonalEntitiesTriggers(db);
  },
};
