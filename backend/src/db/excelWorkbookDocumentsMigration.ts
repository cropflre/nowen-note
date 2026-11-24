import type { Migration } from "./migrations.impl.js";

/**
 * Excel 工作簿（Univer）快照的权威存储。思路来源：cropflre/nowen-note PR #802。
 *
 * 与轻量表格 `sheets` 一样按 noteId 挂在 notes 上；`revision` 是乐观锁版本，
 * 每次成功写入递增，避免同一毫秒内两次写入共用 updatedAt 而漏判冲突。
 */
export const excelWorkbookDocumentsMigration: Migration = {
  version: 148,
  name: "excel-workbook-documents",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS excel_documents (
        noteId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        data TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
        FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_excel_documents_user ON excel_documents(userId, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_excel_documents_workspace ON excel_documents(workspaceId, updatedAt DESC);
    `);
  },
};
