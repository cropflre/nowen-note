import type { Migration } from "./migrations.impl.js";

export const searchNotebookExclusionsMigration: Migration = {
  version: 101,
  name: "user-search-notebook-exclusions",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_search_notebook_exclusions (
        userId TEXT NOT NULL,
        notebookId TEXT NOT NULL,
        includeDescendants INTEGER NOT NULL DEFAULT 1 CHECK (includeDescendants IN (0, 1)),
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (userId, notebookId),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_user_search_notebook_exclusions_user
        ON user_search_notebook_exclusions(userId, notebookId);
      CREATE INDEX IF NOT EXISTS idx_user_search_notebook_exclusions_notebook
        ON user_search_notebook_exclusions(notebookId, userId);
    `);
  },
};
