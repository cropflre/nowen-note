import type Database from "better-sqlite3";

import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";
import { resolveKnowledgeNodeAccess } from "../services/knowledgeCapabilities.js";
import { listKnowledgeTree } from "../services/knowledgeTreeListing.js";
import { listSharedKnowledgeTree } from "../services/sharedKnowledgeTreeListing.js";

type NoteNodeRow = { id: string; resourceId: string };

function visibleNoteIds(rows: NoteNodeRow[], userId: string, db: Database.Database): string[] {
  return rows
    .filter((row) => resolveKnowledgeNodeAccess(row.id, userId, db).capabilities.canView)
    .map((row) => row.resourceId);
}

/** Resolve note resources by their unified knowledge-tree parent, not by notes.notebookId. */
export function resolveKnowledgeTreeNoteScopeIds(
  db: Database.Database,
  userId: string,
  workspaceId: string | null,
  parentId: string | null,
  includeDescendants: boolean,
): string[] | null {
  ensureKnowledgeTreeTables(db);

  if (parentId === null) {
    const visibleNodes = [
      ...listKnowledgeTree({ userId, workspaceId, db }),
      ...listSharedKnowledgeTree({ userId, workspaceId, db }),
    ];
    return Array.from(new Map(visibleNodes.map((node) => [node.id, node])).values())
      .filter((node) => (
        node.resourceType === "note"
        && (includeDescendants || node.parentId === null)
      ))
      .map((node) => node.resourceId);
  }

  const parent = db.prepare(`
    SELECT id
      FROM knowledge_tree_nodes
     WHERE id = ? AND isDeleted = 0
  `).get(parentId) as { id: string } | undefined;
  if (!parent || !resolveKnowledgeNodeAccess(parent.id, userId, db).capabilities.canView) return null;

  const rows = includeDescendants
    ? db.prepare(`
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM knowledge_tree_nodes WHERE id = ? AND isDeleted = 0
          UNION ALL
          SELECT child.id
            FROM knowledge_tree_nodes child
            JOIN descendants parent_node ON child.parentId = parent_node.id
           WHERE child.isDeleted = 0
        )
        SELECT node.id, node.resourceId
          FROM knowledge_tree_nodes node
          JOIN descendants subtree ON subtree.id = node.id
         WHERE node.resourceType = 'note' AND node.isDeleted = 0
      `).all(parentId) as NoteNodeRow[]
    : db.prepare(`
        SELECT id, resourceId
          FROM knowledge_tree_nodes
         WHERE parentId = ? AND resourceType = 'note' AND isDeleted = 0
      `).all(parentId) as NoteNodeRow[];

  return visibleNoteIds(rows, userId, db);
}
