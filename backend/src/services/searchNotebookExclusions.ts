import type Database from "better-sqlite3";

import { getDb } from "../db/schema";

export interface SearchNotebookExclusionRow {
  userId: string;
  notebookId: string;
  includeDescendants: number;
  createdAt: string;
  updatedAt: string;
}

export interface SearchNotebookExclusionListItem extends SearchNotebookExclusionRow {
  name: string;
  icon: string | null;
  parentId: string | null;
}

const initializedDatabases = new WeakSet<Database.Database>();

/**
 * Keep a runtime guard in addition to the formal migration. Search is a startup-critical path and
 * tests/older local databases can enter this module before the migration bootstrap has completed.
 */
export function ensureSearchNotebookExclusionsTable(
  db: Database.Database = getDb(),
): void {
  if (initializedDatabases.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_search_notebook_exclusions (
      userId TEXT NOT NULL,
      notebookId TEXT NOT NULL,
      includeDescendants INTEGER NOT NULL DEFAULT 1 CHECK (includeDescendants IN (0, 1)),
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (userId, notebookId),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_search_notebook_exclusions_user
      ON user_search_notebook_exclusions(userId, notebookId);
    CREATE INDEX IF NOT EXISTS idx_user_search_notebook_exclusions_notebook
      ON user_search_notebook_exclusions(notebookId, userId);
  `);
  initializedDatabases.add(db);
}

export function listDirectSearchNotebookExclusions(
  userId: string,
  db: Database.Database = getDb(),
): SearchNotebookExclusionListItem[] {
  ensureSearchNotebookExclusionsTable(db);
  return db.prepare(`
    SELECT e.userId, e.notebookId, e.includeDescendants, e.createdAt, e.updatedAt,
           nb.name, nb.icon, nb.parentId
    FROM user_search_notebook_exclusions e
    JOIN notebooks nb ON nb.id = e.notebookId
    WHERE e.userId = ? AND nb.isDeleted = 0
    ORDER BY lower(nb.name), e.createdAt, e.notebookId
  `).all(userId) as SearchNotebookExclusionListItem[];
}

/**
 * Resolve all notebook resources hidden from this user's global search in one recursive query.
 * Search rows are scoped by notes.notebookId, so the exclusion hierarchy deliberately follows the
 * same notebook parent model. This keeps FTS, metadata, literal fallback and UI status consistent.
 */
export function getEffectiveExcludedNotebookIds(
  userId: string,
  db: Database.Database = getDb(),
): Set<string> {
  ensureSearchNotebookExclusionsTable(db);
  const rows = db.prepare(`
    WITH RECURSIVE excluded(id, expand) AS (
      SELECT e.notebookId, e.includeDescendants
      FROM user_search_notebook_exclusions e
      JOIN notebooks root ON root.id = e.notebookId
      WHERE e.userId = ? AND root.isDeleted = 0

      UNION

      SELECT child.id, excluded.expand
      FROM notebooks child
      JOIN excluded ON child.parentId = excluded.id
      WHERE excluded.expand = 1 AND child.isDeleted = 0
    )
    SELECT DISTINCT id FROM excluded
  `).all(userId) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

export function setSearchNotebookExcluded(input: {
  userId: string;
  notebookId: string;
  includeDescendants?: boolean;
  db?: Database.Database;
}): SearchNotebookExclusionRow {
  const db = input.db || getDb();
  ensureSearchNotebookExclusionsTable(db);
  const includeDescendants = input.includeDescendants === false ? 0 : 1;
  db.prepare(`
    INSERT INTO user_search_notebook_exclusions (
      userId, notebookId, includeDescendants, updatedAt
    ) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(userId, notebookId) DO UPDATE SET
      includeDescendants = excluded.includeDescendants,
      updatedAt = datetime('now')
  `).run(input.userId, input.notebookId, includeDescendants);

  return db.prepare(`
    SELECT userId, notebookId, includeDescendants, createdAt, updatedAt
    FROM user_search_notebook_exclusions
    WHERE userId = ? AND notebookId = ?
  `).get(input.userId, input.notebookId) as SearchNotebookExclusionRow;
}

export function clearSearchNotebookExcluded(input: {
  userId: string;
  notebookId: string;
  db?: Database.Database;
}): boolean {
  const db = input.db || getDb();
  ensureSearchNotebookExclusionsTable(db);
  return db.prepare(`
    DELETE FROM user_search_notebook_exclusions
    WHERE userId = ? AND notebookId = ?
  `).run(input.userId, input.notebookId).changes > 0;
}
