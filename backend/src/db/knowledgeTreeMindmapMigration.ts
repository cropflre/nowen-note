import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const KNOWLEDGE_TREE_MINDMAP_SCHEMA_VERSION = 104;

/** Keep existing mindmaps visible in the unified tree without changing their data or legacy folders. */
export function ensureKnowledgeTreeMindmaps(db: Database.Database): void {
  db.exec(`
    INSERT OR IGNORE INTO knowledge_tree_nodes (
      id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
      resourceId, sortOrder, isExpanded, isDeleted, createdAt, updatedAt
    )
    SELECT 'mindmap:' || m.id, m.userId, m.workspaceId,
      CASE WHEN m.workspaceId IS NULL THEN 'personal:' || m.userId ELSE 'workspace:' || m.workspaceId END,
      NULL, 'mindmap', 'mindmap', m.id, 0, 1, 0, m.createdAt, m.updatedAt
    FROM mindmaps m;

    DROP TRIGGER IF EXISTS knowledge_tree_mindmaps_ai;
    CREATE TRIGGER knowledge_tree_mindmaps_ai AFTER INSERT ON mindmaps BEGIN
      INSERT OR IGNORE INTO knowledge_tree_nodes (
        id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
        resourceId, sortOrder, isExpanded, isDeleted, createdAt, updatedAt
      ) VALUES (
        'mindmap:' || NEW.id, NEW.userId, NEW.workspaceId,
        CASE WHEN NEW.workspaceId IS NULL THEN 'personal:' || NEW.userId ELSE 'workspace:' || NEW.workspaceId END,
        NULL, 'mindmap', 'mindmap', NEW.id, 0, 1, 0, NEW.createdAt, NEW.updatedAt
      );
    END;

    DROP TRIGGER IF EXISTS knowledge_tree_mindmaps_au;
    CREATE TRIGGER knowledge_tree_mindmaps_au AFTER UPDATE OF title, data, updatedAt ON mindmaps BEGIN
      UPDATE knowledge_tree_nodes SET updatedAt = NEW.updatedAt
      WHERE resourceType = 'mindmap' AND resourceId = NEW.id;
    END;

    DROP TRIGGER IF EXISTS knowledge_tree_mindmaps_ad;
    CREATE TRIGGER knowledge_tree_mindmaps_ad AFTER DELETE ON mindmaps BEGIN
      DELETE FROM knowledge_tree_nodes WHERE resourceType = 'mindmap' AND resourceId = OLD.id;
    END;
  `);
}

export const knowledgeTreeMindmapMigration: Migration = {
  version: KNOWLEDGE_TREE_MINDMAP_SCHEMA_VERSION,
  name: "knowledge-tree-mindmaps",
  up: ensureKnowledgeTreeMindmaps,
};
