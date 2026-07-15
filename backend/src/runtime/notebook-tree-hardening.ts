import type Database from "better-sqlite3";
import { getDb } from "../db/schema.js";

const installedDatabases = new WeakSet<object>();

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

/**
 * Install database-level notebook tree guards.
 *
 * Route validation remains useful for friendly HTTP errors, but it is not a sufficient
 * data-safety boundary: imports, older clients and maintenance scripts can still update
 * notebooks directly. These triggers make parent/scope/cycle invariants impossible to
 * violate regardless of the write entry point.
 */
export function installNotebookTreeIntegrityGuards(db: Database.Database): void {
  if (installedDatabases.has(db as object)) return;

  const notebookColumns = columnNames(db, "notebooks");
  const noteColumns = columnNames(db, "notes");
  const requiredNotebookColumns = ["id", "userId", "workspaceId", "parentId", "isDeleted"];
  const requiredNoteColumns = ["notebookId", "userId", "workspaceId"];
  if (
    requiredNotebookColumns.some((name) => !notebookColumns.has(name))
    || requiredNoteColumns.some((name) => !noteColumns.has(name))
  ) {
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS notebook_tree_history (
      id TEXT PRIMARY KEY,
      notebookId TEXT NOT NULL,
      ownerUserId TEXT NOT NULL,
      workspaceId TEXT,
      oldParentId TEXT,
      newParentId TEXT,
      changedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_notebook_tree_history_notebook_time
      ON notebook_tree_history(notebookId, changedAt DESC);

    DROP TRIGGER IF EXISTS notebooks_parent_guard_insert;
    CREATE TRIGGER notebooks_parent_guard_insert
    BEFORE INSERT ON notebooks
    WHEN NEW.parentId IS NOT NULL
    BEGIN
      SELECT CASE
        WHEN trim(NEW.parentId) = ''
          THEN RAISE(ABORT, 'NOTEBOOK_PARENT_EMPTY')
      END;
      SELECT CASE
        WHEN NEW.parentId = NEW.id
          THEN RAISE(ABORT, 'NOTEBOOK_PARENT_SELF')
      END;
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM notebooks p
          WHERE p.id = NEW.parentId AND p.isDeleted = 0
        )
          THEN RAISE(ABORT, 'NOTEBOOK_PARENT_NOT_FOUND')
      END;
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM notebooks p
          WHERE p.id = NEW.parentId
            AND (
              COALESCE(p.workspaceId, '') <> COALESCE(NEW.workspaceId, '')
              OR (NEW.workspaceId IS NULL AND p.userId <> NEW.userId)
            )
        )
          THEN RAISE(ABORT, 'NOTEBOOK_PARENT_SCOPE_MISMATCH')
      END;
    END;

    DROP TRIGGER IF EXISTS notebooks_parent_guard_update;
    CREATE TRIGGER notebooks_parent_guard_update
    BEFORE UPDATE OF parentId, workspaceId, userId ON notebooks
    WHEN NEW.parentId IS NOT NULL
    BEGIN
      SELECT CASE
        WHEN trim(NEW.parentId) = ''
          THEN RAISE(ABORT, 'NOTEBOOK_PARENT_EMPTY')
      END;
      SELECT CASE
        WHEN NEW.parentId = NEW.id
          THEN RAISE(ABORT, 'NOTEBOOK_PARENT_SELF')
      END;
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM notebooks p
          WHERE p.id = NEW.parentId AND p.isDeleted = 0
        )
          THEN RAISE(ABORT, 'NOTEBOOK_PARENT_NOT_FOUND')
      END;
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM notebooks p
          WHERE p.id = NEW.parentId
            AND (
              COALESCE(p.workspaceId, '') <> COALESCE(NEW.workspaceId, '')
              OR (NEW.workspaceId IS NULL AND p.userId <> NEW.userId)
            )
        )
          THEN RAISE(ABORT, 'NOTEBOOK_PARENT_SCOPE_MISMATCH')
      END;

      WITH RECURSIVE lineage(id, parentId, path) AS (
        SELECT id, parentId, '/' || id || '/'
        FROM notebooks
        WHERE id = NEW.parentId
        UNION ALL
        SELECT p.id, p.parentId, lineage.path || p.id || '/'
        FROM notebooks p
        JOIN lineage ON p.id = lineage.parentId
        WHERE lineage.parentId IS NOT NULL
          AND instr(lineage.path, '/' || p.id || '/') = 0
      )
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM lineage WHERE id = NEW.id)
          THEN RAISE(ABORT, 'NOTEBOOK_PARENT_CYCLE')
      END;
    END;

    DROP TRIGGER IF EXISTS notebooks_scope_guard_update;
    CREATE TRIGGER notebooks_scope_guard_update
    BEFORE UPDATE OF workspaceId, userId ON notebooks
    WHEN COALESCE(OLD.workspaceId, '') <> COALESCE(NEW.workspaceId, '')
      OR OLD.userId <> NEW.userId
    BEGIN
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM notebooks child
          WHERE child.parentId = OLD.id
            AND child.isDeleted = 0
            AND (
              COALESCE(child.workspaceId, '') <> COALESCE(NEW.workspaceId, '')
              OR (NEW.workspaceId IS NULL AND child.userId <> NEW.userId)
            )
        )
          THEN RAISE(ABORT, 'NOTEBOOK_CHILD_SCOPE_MISMATCH')
      END;
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM notes note
          WHERE note.notebookId = OLD.id
            AND (
              COALESCE(note.workspaceId, '') <> COALESCE(NEW.workspaceId, '')
              OR (NEW.workspaceId IS NULL AND note.userId <> NEW.userId)
            )
        )
          THEN RAISE(ABORT, 'NOTEBOOK_NOTE_SCOPE_MISMATCH')
      END;
    END;

    DROP TRIGGER IF EXISTS notebooks_parent_history_update;
    CREATE TRIGGER notebooks_parent_history_update
    AFTER UPDATE OF parentId ON notebooks
    WHEN COALESCE(OLD.parentId, '') <> COALESCE(NEW.parentId, '')
    BEGIN
      INSERT INTO notebook_tree_history (
        id, notebookId, ownerUserId, workspaceId, oldParentId, newParentId
      ) VALUES (
        lower(hex(randomblob(16))), NEW.id, NEW.userId, NEW.workspaceId, OLD.parentId, NEW.parentId
      );
    END;
  `);

  installedDatabases.add(db as object);
}

export function ensureNotebookTreeIntegrityGuards(): void {
  installNotebookTreeIntegrityGuards(getDb());
}
