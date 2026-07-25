import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const KNOWLEDGE_TREE_STRUCTURAL_GUARD_SCHEMA_VERSION = 64;

/**
 * Runtime sync updates write scopeKey/isDeleted timestamps even when the structure is unchanged.
 * Parent validation must run only when parentId or scopeKey actually changes; otherwise deleting or
 * restoring a subtree can reject a harmless state update because its parent is temporarily deleted.
 */
export function ensureKnowledgeTreeStructuralGuard(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS knowledge_tree_parent_scope_guard_update;
    CREATE TRIGGER knowledge_tree_parent_scope_guard_update
    BEFORE UPDATE OF parentId, scopeKey ON knowledge_tree_nodes
    WHEN NEW.parentId IS NOT NULL
      AND (
        OLD.parentId IS NOT NEW.parentId
        OR OLD.scopeKey IS NOT NEW.scopeKey
      )
    BEGIN
      SELECT RAISE(ABORT, 'KNOWLEDGE_TREE_PARENT_SCOPE_MISMATCH')
      WHERE NOT EXISTS (
        SELECT 1 FROM knowledge_tree_nodes parent
        WHERE parent.id = NEW.parentId
          AND parent.scopeKey = NEW.scopeKey
          AND parent.isDeleted = 0
      );
      SELECT RAISE(ABORT, 'KNOWLEDGE_TREE_SELF_PARENT')
      WHERE NEW.parentId = NEW.id;
      SELECT CASE WHEN EXISTS (
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM knowledge_tree_nodes WHERE parentId = NEW.id AND isDeleted = 0
          UNION ALL
          SELECT child.id
          FROM knowledge_tree_nodes child
          JOIN descendants parent ON child.parentId = parent.id
          WHERE child.isDeleted = 0
        )
        SELECT 1 FROM descendants WHERE id = NEW.parentId
      ) THEN RAISE(ABORT, 'KNOWLEDGE_TREE_CYCLE') END;
    END;
  `);
}

export const knowledgeTreeStructuralGuardMigration: Migration = {
  version: KNOWLEDGE_TREE_STRUCTURAL_GUARD_SCHEMA_VERSION,
  name: "knowledge-tree-structural-update-guard",
  up: ensureKnowledgeTreeStructuralGuard,
};
