import type Database from "better-sqlite3";
import { ensureMindmapSchema } from "../lib/mindmap-schema.js";
import type { Migration } from "./migrations.impl.js";

export const KNOWLEDGE_TREE_RESOURCE_SCHEMA_VERSION = 61;

export function ensureKnowledgeTreeResourceViews(db: Database.Database): void {
  // mindmaps is an optional module table on older databases. The unified tree query left-joins it,
  // so create the normal module schema before any tree listing can run.
  ensureMindmapSchema(db);

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
