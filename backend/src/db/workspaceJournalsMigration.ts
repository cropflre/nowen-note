import type { Migration } from "./migrations.impl.js";

export const workspaceJournalsMigration: Migration = {
  version: 78,
  name: "workspace-shared-journals",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_journals (
        workspaceId TEXT NOT NULL,
        journalDate TEXT NOT NULL,
        noteId TEXT NOT NULL UNIQUE,
        createdBy TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (workspaceId, journalDate),
        FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
        FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_journals_note
        ON workspace_journals(noteId);
      CREATE INDEX IF NOT EXISTS idx_workspace_journals_date
        ON workspace_journals(workspaceId, journalDate DESC);
    `);
  },
};
