import type { Migration } from "./migrations.impl.js";

/**
 * TASK-METADATA-01
 *
 * v70 belongs to My Day. Task labels and saved views start at v71 so the
 * features retain independent schema ownership.
 */
export const taskMetadataMigration: Migration = {
  version: 71,
  name: "task-labels-and-saved-views",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_labels (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        scopeKey TEXT NOT NULL,
        name TEXT NOT NULL,
        normalizedName TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#6366f1',
        sortOrder INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_labels_scope_name
        ON task_labels(scopeKey, normalizedName);
      CREATE INDEX IF NOT EXISTS idx_task_labels_workspace_sort
        ON task_labels(workspaceId, sortOrder, createdAt);
      CREATE INDEX IF NOT EXISTS idx_task_labels_user_sort
        ON task_labels(userId, sortOrder, createdAt);

      CREATE TABLE IF NOT EXISTS task_label_links (
        taskId TEXT NOT NULL,
        labelId TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (taskId, labelId),
        FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (labelId) REFERENCES task_labels(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_task_label_links_label
        ON task_label_links(labelId, taskId);

      CREATE TABLE IF NOT EXISTS task_saved_views (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        scopeKey TEXT NOT NULL,
        name TEXT NOT NULL,
        normalizedName TEXT NOT NULL,
        filtersJson TEXT NOT NULL DEFAULT '{}',
        sortOrder INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_saved_views_user_scope_name
        ON task_saved_views(userId, scopeKey, normalizedName);
      CREATE INDEX IF NOT EXISTS idx_task_saved_views_user_scope_sort
        ON task_saved_views(userId, scopeKey, sortOrder, createdAt);
    `);
  },
};
