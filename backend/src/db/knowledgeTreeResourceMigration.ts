import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const KNOWLEDGE_TREE_RESOURCE_SCHEMA_VERSION = 61;

export function ensureKnowledgeTreeResourceViews(db: Database.Database): void {
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
