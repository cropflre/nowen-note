import type { Migration } from "./migrations.impl.js";

// fork 专属迁移使用保留版本段（>= 900000），官方顺序号永远不会到达，彻底避免撞号。
// 早期实现曾占用 148/141，旧库 ledger 里的历史行由 forkMigrationCompat.ts 按 name 自动对账改写到当前版本。
export const FORK_MIGRATION_VERSION_BASE = 900_000;

export const excelDocumentsMigration: Migration = {
  version: FORK_MIGRATION_VERSION_BASE + 1, // 900001
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
