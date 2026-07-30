import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const KNOWLEDGE_TREE_PASSWORD_SCHEMA_VERSION = 65;

export function ensureKnowledgeTreePasswordTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notebook_passwords (
      notebookId TEXT PRIMARY KEY,
      passwordHash TEXT NOT NULL,
      passwordVersion INTEGER NOT NULL DEFAULT 1,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE
    );
  `);
}

export const knowledgeTreePasswordMigration: Migration = {
  version: KNOWLEDGE_TREE_PASSWORD_SCHEMA_VERSION,
  name: "knowledge-tree-folder-passwords",
  up: ensureKnowledgeTreePasswordTable,
};
