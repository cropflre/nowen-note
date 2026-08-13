import { getDb } from "../db/schema";

export type MindmapSchemaDatabase = ReturnType<typeof getDb>;

/**
 * SQLite compatibility boundary for the legacy mindmap schema fallback.
 * PostgreSQL schema parity and migrations are handled by #250.
 */
export const mindmapSchemaRepository = {
  ensure(db: MindmapSchemaDatabase = getDb()): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mindmaps (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        title TEXT NOT NULL DEFAULT '无标题导图',
        data TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mindmaps_user ON mindmaps(userId);
      CREATE INDEX IF NOT EXISTS idx_mindmaps_updated ON mindmaps(updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_mindmaps_workspace ON mindmaps(workspaceId);
    `);

    const columns = db.prepare("PRAGMA table_info(mindmaps)").all() as { name: string }[];
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("starred")) {
      db.exec("ALTER TABLE mindmaps ADD COLUMN starred INTEGER NOT NULL DEFAULT 0");
    }
    if (!columnNames.has("folderId")) {
      db.exec("ALTER TABLE mindmaps ADD COLUMN folderId TEXT");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS mindmap_folders (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        parentId TEXT,
        name TEXT NOT NULL DEFAULT '未命名文件夹',
        sortOrder INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mindmap_folders_user ON mindmap_folders(userId);
      CREATE INDEX IF NOT EXISTS idx_mindmap_folders_parent ON mindmap_folders(parentId);
      CREATE INDEX IF NOT EXISTS idx_mindmap_folders_workspace ON mindmap_folders(workspaceId);
    `);
  },
};
