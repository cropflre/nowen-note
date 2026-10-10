import type { Migration } from "./migrations.impl.js";

export const lightweightSheetsMigration: Migration = {
  version: 112,
  name: "lightweight-sheet-documents",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sheets (
        noteId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        data TEXT NOT NULL DEFAULT '{"version":1,"rows":[],"columns":[],"cells":{}}',
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sheets_user ON sheets(userId, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_sheets_workspace ON sheets(workspaceId, updatedAt DESC);

      INSERT OR IGNORE INTO sheets (noteId, userId, workspaceId, data, createdAt, updatedAt)
      SELECT id, userId, workspaceId,
        '{"version":1,"rows":[],"columns":[],"cells":{}}',
        createdAt, updatedAt
      FROM notes WHERE note_type = 'sheet';
    `);
  },
};
