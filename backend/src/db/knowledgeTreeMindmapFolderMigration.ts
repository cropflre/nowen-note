import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const KNOWLEDGE_TREE_MINDMAP_FOLDER_SCHEMA_VERSION = 105;
export const MINDMAP_LEGACY_NOTEBOOK_PREFIX = "__nowen_mindmap_folder__:";

type LegacyFolder = {
  id: string;
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
};

function sameScope(a: LegacyFolder, b: LegacyFolder): boolean {
  return a.workspaceId === b.workspaceId && (a.workspaceId !== null || a.userId === b.userId);
}

/** Project legacy folders as ordinary notebook nodes; retain the original rows for old clients. */
export function ensureKnowledgeTreeMindmapFolders(db: Database.Database): void {
  const existingNotebookIds = new Set((db.prepare(
    "SELECT id FROM notebooks WHERE id GLOB ?",
  ).all(`${MINDMAP_LEGACY_NOTEBOOK_PREFIX}*`) as Array<{ id: string }>).map((row) => row.id));
  db.exec(`
    INSERT OR IGNORE INTO notebooks (
      id, userId, workspaceId, parentId, name, icon, sortOrder, createdAt, updatedAt
    )
    SELECT '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || folder.id,
      folder.userId, folder.workspaceId, NULL, folder.name, '🧠',
      folder.sortOrder, folder.createdAt, folder.updatedAt
    FROM mindmap_folders folder
    WHERE EXISTS (SELECT 1 FROM users WHERE id = folder.userId);
  `);

  const folders = db.prepare("SELECT id, userId, workspaceId, parentId FROM mindmap_folders")
    .all() as LegacyFolder[];
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const setParent = db.prepare("UPDATE notebooks SET parentId = ? WHERE id = ?");
  for (const folder of folders) {
    if (existingNotebookIds.has(`${MINDMAP_LEGACY_NOTEBOOK_PREFIX}${folder.id}`)) continue;
    if (!folder.parentId) continue;
    const parent = byId.get(folder.parentId);
    if (!parent || !sameScope(folder, parent)) continue;
    const seen = new Set([folder.id]);
    let ancestor: LegacyFolder | undefined = parent;
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
    }
    if (ancestor) continue; // Leave malformed historical cycles at root without dropping data.
    setParent.run(`${MINDMAP_LEGACY_NOTEBOOK_PREFIX}${parent.id}`, `${MINDMAP_LEGACY_NOTEBOOK_PREFIX}${folder.id}`);
  }

  // v104 created root nodes. Only assign unmoved maps; a tree move is user intent even if an
  // older client left folderId behind. The legacy row remains untouched either way.
  db.exec(`
    UPDATE knowledge_tree_nodes AS node
    SET parentId = (
      SELECT folderNode.id
      FROM mindmaps map
      JOIN knowledge_tree_nodes folderNode
        ON folderNode.resourceType = 'notebook'
       AND folderNode.resourceId = '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || map.folderId
       AND folderNode.scopeKey = node.scopeKey
       AND folderNode.isDeleted = 0
      WHERE map.id = node.resourceId
    )
    WHERE node.resourceType = 'mindmap' AND node.parentId IS NULL AND node.isDeleted = 0
      AND EXISTS (
        SELECT 1 FROM mindmaps map JOIN knowledge_tree_nodes folderNode
          ON folderNode.resourceType = 'notebook'
         AND folderNode.resourceId = '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || map.folderId
         AND folderNode.scopeKey = node.scopeKey AND folderNode.isDeleted = 0
        WHERE map.id = node.resourceId
      )
      AND NOT EXISTS (
        SELECT 1 FROM knowledge_tree_history history
        WHERE history.nodeId = node.id AND history.action = 'move'
      );

    DROP TRIGGER IF EXISTS knowledge_tree_mindmap_folders_ai;
    CREATE TRIGGER knowledge_tree_mindmap_folders_ai AFTER INSERT ON mindmap_folders BEGIN
      INSERT OR IGNORE INTO notebooks (id, userId, workspaceId, parentId, name, icon, sortOrder, createdAt, updatedAt)
      VALUES (
        '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || NEW.id, NEW.userId, NEW.workspaceId,
        (SELECT '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || parent.id FROM mindmap_folders parent
         WHERE parent.id = NEW.parentId AND parent.workspaceId IS NEW.workspaceId
           AND (NEW.workspaceId IS NOT NULL OR parent.userId = NEW.userId)),
        NEW.name, '🧠', NEW.sortOrder, NEW.createdAt, NEW.updatedAt
      );
    END;

    DROP TRIGGER IF EXISTS knowledge_tree_mindmap_folders_name_au;
    CREATE TRIGGER knowledge_tree_mindmap_folders_name_au AFTER UPDATE OF name, sortOrder ON mindmap_folders BEGIN
      UPDATE notebooks SET name = NEW.name, sortOrder = NEW.sortOrder, updatedAt = NEW.updatedAt
      WHERE id = '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || NEW.id;
    END;

    DROP TRIGGER IF EXISTS knowledge_tree_mindmap_folders_parent_au;
    CREATE TRIGGER knowledge_tree_mindmap_folders_parent_au AFTER UPDATE OF parentId ON mindmap_folders
    WHEN OLD.parentId IS NOT NEW.parentId BEGIN
      UPDATE notebooks SET parentId = (
        SELECT '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || parent.id FROM mindmap_folders parent
        WHERE parent.id = NEW.parentId AND parent.workspaceId IS NEW.workspaceId
          AND (NEW.workspaceId IS NOT NULL OR parent.userId = NEW.userId)
      ), updatedAt = NEW.updatedAt
      WHERE id = '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || NEW.id;
    END;

    DROP TRIGGER IF EXISTS knowledge_tree_mindmap_folders_ad;
    CREATE TRIGGER knowledge_tree_mindmap_folders_ad AFTER DELETE ON mindmap_folders BEGIN
      DELETE FROM notebooks
      WHERE id = '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || OLD.id
        AND NOT EXISTS (SELECT 1 FROM knowledge_tree_nodes child
          WHERE child.parentId = 'notebook:${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || OLD.id)
        AND NOT EXISTS (SELECT 1 FROM notes note
          WHERE note.notebookId = '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || OLD.id)
        AND NOT EXISTS (SELECT 1 FROM notebooks child
          WHERE child.parentId = '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || OLD.id);
    END;

    DROP TRIGGER IF EXISTS knowledge_tree_mindmaps_ai;
    CREATE TRIGGER knowledge_tree_mindmaps_ai AFTER INSERT ON mindmaps BEGIN
      INSERT OR IGNORE INTO knowledge_tree_nodes (
        id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
        resourceId, sortOrder, isExpanded, isDeleted, createdAt, updatedAt
      ) VALUES (
        'mindmap:' || NEW.id, NEW.userId, NEW.workspaceId,
        CASE WHEN NEW.workspaceId IS NULL THEN 'personal:' || NEW.userId ELSE 'workspace:' || NEW.workspaceId END,
        (SELECT folderNode.id FROM knowledge_tree_nodes folderNode
         WHERE folderNode.resourceType = 'notebook'
           AND folderNode.resourceId = '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || NEW.folderId
           AND folderNode.scopeKey = CASE WHEN NEW.workspaceId IS NULL THEN 'personal:' || NEW.userId ELSE 'workspace:' || NEW.workspaceId END
           AND folderNode.isDeleted = 0),
        'mindmap', 'mindmap', NEW.id, 0, 1, 0, NEW.createdAt, NEW.updatedAt
      );
    END;

    DROP TRIGGER IF EXISTS knowledge_tree_mindmaps_folder_au;
    CREATE TRIGGER knowledge_tree_mindmaps_folder_au AFTER UPDATE OF folderId ON mindmaps
    WHEN OLD.folderId IS NOT NEW.folderId BEGIN
      UPDATE knowledge_tree_nodes SET parentId = (
        SELECT folderNode.id FROM knowledge_tree_nodes folderNode
        WHERE folderNode.resourceType = 'notebook'
          AND folderNode.resourceId = '${MINDMAP_LEGACY_NOTEBOOK_PREFIX}' || NEW.folderId
          AND folderNode.scopeKey = knowledge_tree_nodes.scopeKey AND folderNode.isDeleted = 0
      ), updatedAt = NEW.updatedAt
      WHERE resourceType = 'mindmap' AND resourceId = NEW.id AND isDeleted = 0;
    END;
  `);
}

export const knowledgeTreeMindmapFolderMigration: Migration = {
  version: KNOWLEDGE_TREE_MINDMAP_FOLDER_SCHEMA_VERSION,
  name: "knowledge-tree-legacy-mindmap-folders",
  up: ensureKnowledgeTreeMindmapFolders,
};
