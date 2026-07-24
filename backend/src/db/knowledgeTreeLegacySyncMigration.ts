import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const KNOWLEDGE_TREE_LEGACY_SYNC_SCHEMA_VERSION = 63;

/**
 * Separate structural parent changes from harmless legacy state updates. Assigning `parentId`
 * inside a broad UPDATE trigger lets SQLite resolve the RHS against NEW in some trigger contexts,
 * collapsing a folder-under-document relationship back to its physical notebook container.
 */
export function ensureKnowledgeTreeLegacySync(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS knowledge_tree_notebooks_au;
    DROP TRIGGER IF EXISTS knowledge_tree_notebooks_parent_au;
    DROP TRIGGER IF EXISTS knowledge_tree_notebooks_state_au;

    CREATE TRIGGER knowledge_tree_notebooks_parent_au
    AFTER UPDATE OF parentId, workspaceId ON notebooks
    BEGIN
      UPDATE knowledge_tree_nodes
      SET userId = NEW.userId,
          workspaceId = NEW.workspaceId,
          scopeKey = CASE
            WHEN NEW.workspaceId IS NULL THEN 'personal:' || NEW.userId
            ELSE 'workspace:' || NEW.workspaceId
          END,
          parentId = CASE
            WHEN NEW.parentId IS NULL THEN NULL
            ELSE 'notebook:' || NEW.parentId
          END,
          updatedAt = NEW.updatedAt
      WHERE resourceType = 'notebook' AND resourceId = NEW.id;
    END;

    CREATE TRIGGER knowledge_tree_notebooks_state_au
    AFTER UPDATE OF sortOrder, isExpanded, isDeleted, deletedAt, updatedAt ON notebooks
    BEGIN
      UPDATE knowledge_tree_nodes
      SET userId = NEW.userId,
          workspaceId = NEW.workspaceId,
          scopeKey = CASE
            WHEN NEW.workspaceId IS NULL THEN 'personal:' || NEW.userId
            ELSE 'workspace:' || NEW.workspaceId
          END,
          sortOrder = COALESCE(NEW.sortOrder, 0),
          isExpanded = COALESCE(NEW.isExpanded, 1),
          isDeleted = COALESCE(NEW.isDeleted, 0),
          deletedAt = NEW.deletedAt,
          updatedAt = NEW.updatedAt
      WHERE resourceType = 'notebook' AND resourceId = NEW.id;
    END;
  `);
}

export const knowledgeTreeLegacySyncMigration: Migration = {
  version: KNOWLEDGE_TREE_LEGACY_SYNC_SCHEMA_VERSION,
  name: "knowledge-tree-legacy-sync-split",
  up: ensureKnowledgeTreeLegacySync,
};
