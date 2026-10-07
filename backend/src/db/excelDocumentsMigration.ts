import type { Migration } from "./migrations.impl.js";

export const excelDocumentsMigration: Migration = {
  version: 123,
  name: "excel-univer-documents",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS excel_documents (
        noteId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        data TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_excel_documents_user ON excel_documents(userId, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_excel_documents_workspace ON excel_documents(workspaceId, updatedAt DESC);

      INSERT OR IGNORE INTO excel_documents (noteId, userId, workspaceId, data, createdAt, updatedAt)
      SELECT id, userId, workspaceId, '{}', createdAt, updatedAt
      FROM notes WHERE note_type = 'excel';
    `);
  },
};
