import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const KNOWLEDGE_TREE_SCOPE_TRIGGER_REPAIR_SCHEMA_VERSION = 85;

/**
 * 运行期写入可能先落库笔记，再补 workspaceId。树触发器必须只在父节点与当前
 * scope 一致时建立 parentId，不能让临时 scope 组合被结构守卫误判为跨域父子关系。
 */
export function ensureKnowledgeTreeScopeAwareTriggers(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS knowledge_tree_notebooks_parent_au;
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
            WHEN EXISTS (
              SELECT 1 FROM notebooks parent
              WHERE parent.id = NEW.parentId
                AND COALESCE(parent.workspaceId, '') = COALESCE(NEW.workspaceId, '')
                AND (NEW.workspaceId IS NOT NULL OR parent.userId = NEW.userId)
                AND parent.isDeleted = 0
            ) THEN 'notebook:' || NEW.parentId
            ELSE NULL
          END,
          updatedAt = NEW.updatedAt
      WHERE resourceType = 'notebook' AND resourceId = NEW.id;
    END;

    DROP TRIGGER IF EXISTS knowledge_tree_notes_ai;
    CREATE TRIGGER knowledge_tree_notes_ai
    AFTER INSERT ON notes
    BEGIN
      INSERT OR IGNORE INTO knowledge_tree_nodes (
        id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
        resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
      ) VALUES (
        'note:' || NEW.id,
        NEW.userId,
        NEW.workspaceId,
        CASE WHEN NEW.workspaceId IS NULL THEN 'personal:' || NEW.userId ELSE 'workspace:' || NEW.workspaceId END,
        CASE
          WHEN NEW.notebookId IS NULL THEN NULL
          WHEN EXISTS (
            SELECT 1 FROM notebooks parent
            WHERE parent.id = NEW.notebookId
              AND COALESCE(parent.workspaceId, '') = COALESCE(NEW.workspaceId, '')
              AND (NEW.workspaceId IS NOT NULL OR parent.userId = NEW.userId)
              AND parent.isDeleted = 0
          ) THEN 'notebook:' || NEW.notebookId
          ELSE NULL
        END,
        CASE
          WHEN NEW.note_type = 'word' THEN 'word'
          WHEN NEW.contentFormat = 'markdown' THEN 'markdown'
          ELSE 'note'
        END,
        'note', NEW.id, COALESCE(NEW.sortOrder, 0), 1,
        COALESCE(NEW.isTrashed, 0), NEW.trashedAt, NEW.createdAt, NEW.updatedAt
      );
    END;

    DROP TRIGGER IF EXISTS knowledge_tree_notes_au;
    CREATE TRIGGER knowledge_tree_notes_au
    AFTER UPDATE OF notebookId, workspaceId, contentFormat, note_type, sortOrder, isTrashed, trashedAt, updatedAt ON notes
    BEGIN
      UPDATE knowledge_tree_nodes
      SET userId = NEW.userId,
          workspaceId = NEW.workspaceId,
          scopeKey = CASE WHEN NEW.workspaceId IS NULL THEN 'personal:' || NEW.userId ELSE 'workspace:' || NEW.workspaceId END,
          parentId = CASE
            WHEN OLD.notebookId IS NOT NEW.notebookId OR OLD.workspaceId IS NOT NEW.workspaceId THEN
              CASE
                WHEN NEW.notebookId IS NULL THEN NULL
                WHEN EXISTS (
                  SELECT 1 FROM notebooks parent
                  WHERE parent.id = NEW.notebookId
                    AND COALESCE(parent.workspaceId, '') = COALESCE(NEW.workspaceId, '')
                    AND (NEW.workspaceId IS NOT NULL OR parent.userId = NEW.userId)
                    AND parent.isDeleted = 0
                ) THEN 'notebook:' || NEW.notebookId
                ELSE NULL
              END
            ELSE parentId
          END,
          nodeType = CASE
            WHEN NEW.note_type = 'word' THEN 'word'
            WHEN NEW.contentFormat = 'markdown' THEN 'markdown'
            ELSE 'note'
          END,
          sortOrder = COALESCE(NEW.sortOrder, 0),
          isDeleted = COALESCE(NEW.isTrashed, 0),
          deletedAt = NEW.trashedAt,
          updatedAt = NEW.updatedAt
      WHERE resourceType = 'note' AND resourceId = NEW.id;
    END;
  `);
}

export const knowledgeTreeScopeTriggerRepairMigration: Migration = {
  version: KNOWLEDGE_TREE_SCOPE_TRIGGER_REPAIR_SCHEMA_VERSION,
  name: "knowledge-tree-scope-aware-triggers",
  up: ensureKnowledgeTreeScopeAwareTriggers,
};
