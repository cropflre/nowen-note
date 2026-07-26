import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const KNOWLEDGE_TREE_PARENT_PRESERVATION_SCHEMA_VERSION = 62;

/**
 * Legacy notebook updates (sort/expand/soft-delete) must not collapse a richer tree parent
 * from a document node back to the nearest physical notebook container. Only a real legacy
 * parentId change is allowed to replace the unified-tree parent.
 */
export function ensureKnowledgeTreeParentPreservation(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS knowledge_tree_notebooks_au;
    CREATE TRIGGER knowledge_tree_notebooks_au
    AFTER UPDATE OF parentId, workspaceId, sortOrder, isExpanded, isDeleted, deletedAt, updatedAt ON notebooks
    BEGIN
      UPDATE knowledge_tree_nodes
      SET userId = NEW.userId,
          workspaceId = NEW.workspaceId,
          scopeKey = CASE WHEN NEW.workspaceId IS NULL THEN 'personal:' || NEW.userId ELSE 'workspace:' || NEW.workspaceId END,
          parentId = CASE
            WHEN OLD.parentId IS NOT NEW.parentId
              THEN CASE WHEN NEW.parentId IS NULL THEN NULL ELSE 'notebook:' || NEW.parentId END
            ELSE parentId
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

export const knowledgeTreeParentPreservationMigration: Migration = {
  version: KNOWLEDGE_TREE_PARENT_PRESERVATION_SCHEMA_VERSION,
  name: "knowledge-tree-parent-preservation",
  up: ensureKnowledgeTreeParentPreservation,
};
