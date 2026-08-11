import type Database from "better-sqlite3";

interface WorkspaceNotebookRow {
  id: string;
  parentId: string | null;
}

/**
 * Move the workspace's note hierarchy into the owner's personal space.
 *
 * Notebook scope guards require every child and contained note to match the
 * notebook's scope. Detach the hierarchy inside the surrounding transaction,
 * move notes and notebooks, then restore the original parent relationships.
 */
export function transferWorkspaceNotesToOwner(
  db: Database.Database,
  workspaceId: string,
  ownerId: string,
): void {
  const notebooks = db.prepare(`
    SELECT id, parentId
    FROM notebooks
    WHERE workspaceId = ?
  `).all(workspaceId) as WorkspaceNotebookRow[];

  db.prepare(`
    UPDATE notebooks
    SET parentId = NULL
    WHERE workspaceId = ? AND parentId IS NOT NULL
  `).run(workspaceId);

  db.prepare(`
    UPDATE notes
    SET workspaceId = NULL, userId = ?
    WHERE workspaceId = ?
  `).run(ownerId, workspaceId);

  db.prepare(`
    UPDATE notebooks
    SET workspaceId = NULL, userId = ?
    WHERE workspaceId = ?
  `).run(ownerId, workspaceId);

  const restoreParent = db.prepare("UPDATE notebooks SET parentId = ? WHERE id = ?");
  for (const notebook of notebooks) {
    if (notebook.parentId) restoreParent.run(notebook.parentId, notebook.id);
  }
}
