import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const KNOWLEDGE_TREE_SCHEMA_VERSION = 60;

/**
 * P0-C / P1 unified knowledge tree schema.
 *
 * Business entities remain in their existing tables. This schema owns only navigation,
 * ordering, inherited capability overrides and structural history.
 */
export function ensureKnowledgeTreeTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_tree_nodes (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      scopeKey TEXT NOT NULL,
      parentId TEXT,
      nodeType TEXT NOT NULL
        CHECK(nodeType IN ('folder', 'note', 'markdown', 'word', 'mindmap', 'file')),
      resourceType TEXT NOT NULL
        CHECK(resourceType IN ('notebook', 'note', 'mindmap', 'file')),
      resourceId TEXT NOT NULL,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      isExpanded INTEGER NOT NULL DEFAULT 1,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      deletedAt TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parentId) REFERENCES knowledge_tree_nodes(id) ON DELETE SET NULL,
      UNIQUE(scopeKey, resourceType, resourceId)
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_tree_scope_parent
      ON knowledge_tree_nodes(scopeKey, parentId, sortOrder, createdAt);
    CREATE INDEX IF NOT EXISTS idx_knowledge_tree_resource
      ON knowledge_tree_nodes(resourceType, resourceId);
    CREATE INDEX IF NOT EXISTS idx_knowledge_tree_workspace
      ON knowledge_tree_nodes(workspaceId, isDeleted);

    CREATE TABLE IF NOT EXISTS knowledge_tree_acl (
      nodeId TEXT NOT NULL,
      userId TEXT NOT NULL,
      rolePreset TEXT NOT NULL
        CHECK(rolePreset IN ('readonly', 'editor', 'maintainer', 'admin')),
      canView INTEGER NOT NULL DEFAULT 1,
      canComment INTEGER NOT NULL DEFAULT 0,
      canCreate INTEGER NOT NULL DEFAULT 0,
      canEdit INTEGER NOT NULL DEFAULT 0,
      canDelete INTEGER NOT NULL DEFAULT 0,
      canMove INTEGER NOT NULL DEFAULT 0,
      canDownload INTEGER NOT NULL DEFAULT 1,
      canReshare INTEGER NOT NULL DEFAULT 0,
      canManageMembers INTEGER NOT NULL DEFAULT 0,
      grantedBy TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (nodeId, userId),
      FOREIGN KEY (nodeId) REFERENCES knowledge_tree_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (grantedBy) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_tree_acl_user
      ON knowledge_tree_acl(userId, nodeId);

    CREATE TABLE IF NOT EXISTS knowledge_tree_history (
      id TEXT PRIMARY KEY,
      nodeId TEXT NOT NULL,
      action TEXT NOT NULL
        CHECK(action IN ('create', 'move', 'reorder', 'delete_subtree', 'delete_promote', 'restore', 'permission_set', 'permission_clear')),
      actorUserId TEXT NOT NULL,
      fromParentId TEXT,
      toParentId TEXT,
      targetUserId TEXT,
      metadata TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (nodeId) REFERENCES knowledge_tree_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (actorUserId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (targetUserId) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_tree_history_node
      ON knowledge_tree_history(nodeId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_tree_history_actor
      ON knowledge_tree_history(actorUserId, createdAt DESC);

    DROP TRIGGER IF EXISTS knowledge_tree_parent_scope_guard_insert;
    CREATE TRIGGER knowledge_tree_parent_scope_guard_insert
    BEFORE INSERT ON knowledge_tree_nodes
    WHEN NEW.parentId IS NOT NULL
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
    END;

    DROP TRIGGER IF EXISTS knowledge_tree_parent_scope_guard_update;
    CREATE TRIGGER knowledge_tree_parent_scope_guard_update
    BEFORE UPDATE OF parentId, scopeKey ON knowledge_tree_nodes
    WHEN NEW.parentId IS NOT NULL
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

    DROP TRIGGER IF EXISTS knowledge_tree_notebooks_ai;
    CREATE TRIGGER knowledge_tree_notebooks_ai
    AFTER INSERT ON notebooks
    BEGIN
      INSERT OR IGNORE INTO knowledge_tree_nodes (
        id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
        resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
      ) VALUES (
        'notebook:' || NEW.id,
        NEW.userId,
        NEW.workspaceId,
        CASE WHEN NEW.workspaceId IS NULL THEN 'personal:' || NEW.userId ELSE 'workspace:' || NEW.workspaceId END,
        CASE WHEN NEW.parentId IS NULL THEN NULL ELSE 'notebook:' || NEW.parentId END,
        'folder', 'notebook', NEW.id, COALESCE(NEW.sortOrder, 0), COALESCE(NEW.isExpanded, 1),
        COALESCE(NEW.isDeleted, 0), NEW.deletedAt, NEW.createdAt, NEW.updatedAt
      );
    END;

    DROP TRIGGER IF EXISTS knowledge_tree_notebooks_au;
    CREATE TRIGGER knowledge_tree_notebooks_au
    AFTER UPDATE OF parentId, workspaceId, sortOrder, isExpanded, isDeleted, deletedAt, updatedAt ON notebooks
    BEGIN
      UPDATE knowledge_tree_nodes
      SET userId = NEW.userId,
          workspaceId = NEW.workspaceId,
          scopeKey = CASE WHEN NEW.workspaceId IS NULL THEN 'personal:' || NEW.userId ELSE 'workspace:' || NEW.workspaceId END,
          parentId = CASE WHEN NEW.parentId IS NULL THEN NULL ELSE 'notebook:' || NEW.parentId END,
          sortOrder = COALESCE(NEW.sortOrder, 0),
          isExpanded = COALESCE(NEW.isExpanded, 1),
          isDeleted = COALESCE(NEW.isDeleted, 0),
          deletedAt = NEW.deletedAt,
          updatedAt = NEW.updatedAt
      WHERE resourceType = 'notebook' AND resourceId = NEW.id;
    END;

    DROP TRIGGER IF EXISTS knowledge_tree_notebooks_ad;
    CREATE TRIGGER knowledge_tree_notebooks_ad
    AFTER DELETE ON notebooks
    BEGIN
      DELETE FROM knowledge_tree_nodes WHERE resourceType = 'notebook' AND resourceId = OLD.id;
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
        'notebook:' || NEW.notebookId,
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
            WHEN OLD.notebookId IS NOT NEW.notebookId THEN 'notebook:' || NEW.notebookId
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

    DROP TRIGGER IF EXISTS knowledge_tree_notes_ad;
    CREATE TRIGGER knowledge_tree_notes_ad
    AFTER DELETE ON notes
    BEGIN
      DELETE FROM knowledge_tree_nodes WHERE resourceType = 'note' AND resourceId = OLD.id;
    END;
  `);

  db.exec(`
    INSERT OR IGNORE INTO knowledge_tree_nodes (
      id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
      resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
    )
    SELECT
      'notebook:' || nb.id,
      nb.userId,
      nb.workspaceId,
      CASE WHEN nb.workspaceId IS NULL THEN 'personal:' || nb.userId ELSE 'workspace:' || nb.workspaceId END,
      CASE WHEN nb.parentId IS NULL THEN NULL ELSE 'notebook:' || nb.parentId END,
      'folder', 'notebook', nb.id, COALESCE(nb.sortOrder, 0), COALESCE(nb.isExpanded, 1),
      COALESCE(nb.isDeleted, 0), nb.deletedAt, nb.createdAt, nb.updatedAt
    FROM notebooks nb;

    INSERT OR IGNORE INTO knowledge_tree_nodes (
      id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
      resourceId, sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt
    )
    SELECT
      'note:' || n.id,
      n.userId,
      n.workspaceId,
      CASE WHEN n.workspaceId IS NULL THEN 'personal:' || n.userId ELSE 'workspace:' || n.workspaceId END,
      'notebook:' || n.notebookId,
      CASE
        WHEN n.note_type = 'word' THEN 'word'
        WHEN n.contentFormat = 'markdown' THEN 'markdown'
        ELSE 'note'
      END,
      'note', n.id, COALESCE(n.sortOrder, 0), 1,
      COALESCE(n.isTrashed, 0), n.trashedAt, n.createdAt, n.updatedAt
    FROM notes n;
  `);
}

export const knowledgeTreeMigration: Migration = {
  version: KNOWLEDGE_TREE_SCHEMA_VERSION,
  name: "knowledge-tree-capabilities",
  up: ensureKnowledgeTreeTables,
};
