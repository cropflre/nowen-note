import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const KNOWLEDGE_TREE_RESOURCE_SCHEMA_VERSION = 61;

export function ensureKnowledgeTreeResourceViews(db: Database.Database): void {
  // Keep this DDL local. Importing mindmap-schema here would import db/schema while the feature
  // migration list is still being registered, freezing CURRENT_SCHEMA_VERSION at the old value.
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
  const columns = new Set(
    (db.prepare("PRAGMA table_info(mindmaps)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("starred")) db.exec("ALTER TABLE mindmaps ADD COLUMN starred INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("folderId")) db.exec("ALTER TABLE mindmaps ADD COLUMN folderId TEXT");

  const existing = db.prepare("SELECT type FROM sqlite_master WHERE name = 'files'").get() as
    | { type: string }
    | undefined;
  if (!existing) {
    // The file manager is an aggregate over attachments rather than a standalone business table.
    // A read-only compatibility view lets a tree node reference an attachment without duplicating it.
    db.exec("CREATE VIEW files AS SELECT id, filename FROM attachments");
  }
}

export const knowledgeTreeResourceMigration: Migration = {
  version: KNOWLEDGE_TREE_RESOURCE_SCHEMA_VERSION,
  name: "knowledge-tree-resource-views",
  up: ensureKnowledgeTreeResourceViews,
};
