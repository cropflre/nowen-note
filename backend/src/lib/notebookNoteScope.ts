import type Database from "better-sqlite3";

/**
 * Resolve the notebook IDs used by the note-list query.
 *
 * Three-column folder navigation requests direct children only, while legacy
 * callers can retain the historical recursive subtree behavior. Keeping this
 * decision server-side prevents every client from downloading descendants and
 * filtering them locally.
 */
export function resolveNotebookNoteScopeIds(
  db: Database.Database,
  notebookId: string,
  includeDescendants: boolean,
): string[] {
  if (!includeDescendants) {
    const exists = db.prepare("SELECT id FROM notebooks WHERE id = ?").get(notebookId) as
      | { id: string }
      | undefined;
    return exists ? [exists.id] : [];
  }

  const rows = db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM notebooks WHERE id = ?
      UNION ALL
      SELECT n.id FROM notebooks n
      INNER JOIN descendants d ON n.parentId = d.id
    )
    SELECT id FROM descendants
  `).all(notebookId) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}
