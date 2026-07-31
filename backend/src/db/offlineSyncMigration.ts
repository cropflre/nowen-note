import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

/**
 * v60: durable change feed for complete client-side offline workspaces.
 *
 * The feed is intentionally trigger-backed instead of route-backed. Notes can be
 * changed by REST, import jobs, WebSocket/Yjs flushes, maintenance scripts and
 * future repositories; database triggers guarantee every committed mutation is
 * visible to clients without duplicating logging calls across those paths.
 */
export const offlineSyncMigration: Migration = {
  version: 60,
  name: "offline-workspace-sync-feed",
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS offline_sync_changes (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        entityType TEXT NOT NULL CHECK (entityType IN ('note', 'attachment')),
        entityId TEXT NOT NULL,
        noteId TEXT,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        notebookId TEXT,
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
        version INTEGER,
        changedAt TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_offline_sync_changes_sequence
        ON offline_sync_changes(sequence);
      CREATE INDEX IF NOT EXISTS idx_offline_sync_changes_workspace_sequence
        ON offline_sync_changes(workspaceId, sequence);
      CREATE INDEX IF NOT EXISTS idx_offline_sync_changes_notebook_sequence
        ON offline_sync_changes(notebookId, sequence);
      CREATE INDEX IF NOT EXISTS idx_offline_sync_changes_note_sequence
        ON offline_sync_changes(noteId, sequence);
      CREATE INDEX IF NOT EXISTS idx_offline_sync_changes_time
        ON offline_sync_changes(changedAt);

      CREATE TABLE IF NOT EXISTS offline_sync_clients (
        clientId TEXT NOT NULL,
        userId TEXT NOT NULL,
        scopeKey TEXT NOT NULL,
        lastSequence INTEGER NOT NULL DEFAULT 0,
        lastSeenAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (clientId, userId, scopeKey),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_offline_sync_clients_seen
        ON offline_sync_clients(lastSeenAt);
      CREATE INDEX IF NOT EXISTS idx_offline_sync_clients_sequence
        ON offline_sync_clients(lastSequence);

      DROP TRIGGER IF EXISTS offline_sync_notes_insert;
      CREATE TRIGGER offline_sync_notes_insert
      AFTER INSERT ON notes
      BEGIN
        INSERT INTO offline_sync_changes (
          entityType, entityId, noteId, userId, workspaceId, notebookId, operation, version
        ) VALUES (
          'note', NEW.id, NEW.id, NEW.userId, NEW.workspaceId, NEW.notebookId, 'upsert', NEW.version
        );
      END;

      DROP TRIGGER IF EXISTS offline_sync_notes_update;
      CREATE TRIGGER offline_sync_notes_update
      AFTER UPDATE ON notes
      BEGIN
        INSERT INTO offline_sync_changes (
          entityType, entityId, noteId, userId, workspaceId, notebookId, operation, version
        ) VALUES (
          'note', NEW.id, NEW.id, NEW.userId, NEW.workspaceId, NEW.notebookId, 'upsert', NEW.version
        );
      END;

      -- Moving a note between users, notebooks or workspaces must also emit a
      -- tombstone in the old scope. Otherwise an offline client subscribed only
      -- to the old scope would retain an inaccessible stale copy forever.
      DROP TRIGGER IF EXISTS offline_sync_notes_scope_move;
      CREATE TRIGGER offline_sync_notes_scope_move
      AFTER UPDATE OF userId, workspaceId, notebookId ON notes
      WHEN OLD.userId != NEW.userId
        OR COALESCE(OLD.workspaceId, '') != COALESCE(NEW.workspaceId, '')
        OR OLD.notebookId != NEW.notebookId
      BEGIN
        INSERT INTO offline_sync_changes (
          entityType, entityId, noteId, userId, workspaceId, notebookId, operation, version
        ) VALUES (
          'note', OLD.id, OLD.id, OLD.userId, OLD.workspaceId, OLD.notebookId, 'delete', OLD.version
        );
      END;

      DROP TRIGGER IF EXISTS offline_sync_notes_delete;
      CREATE TRIGGER offline_sync_notes_delete
      BEFORE DELETE ON notes
      BEGIN
        INSERT INTO offline_sync_changes (
          entityType, entityId, noteId, userId, workspaceId, notebookId, operation, version
        ) VALUES (
          'note', OLD.id, OLD.id, OLD.userId, OLD.workspaceId, OLD.notebookId, 'delete', OLD.version
        );
      END;

      DROP TRIGGER IF EXISTS offline_sync_attachments_insert;
      CREATE TRIGGER offline_sync_attachments_insert
      AFTER INSERT ON attachments
      BEGIN
        INSERT INTO offline_sync_changes (
          entityType, entityId, noteId, userId, workspaceId, notebookId, operation, version
        )
        SELECT
          'attachment', NEW.id, NEW.noteId, NEW.userId,
          n.workspaceId, n.notebookId, 'upsert', n.version
        FROM notes n
        WHERE n.id = NEW.noteId;
      END;

      DROP TRIGGER IF EXISTS offline_sync_attachments_update;
      CREATE TRIGGER offline_sync_attachments_update
      AFTER UPDATE ON attachments
      BEGIN
        INSERT INTO offline_sync_changes (
          entityType, entityId, noteId, userId, workspaceId, notebookId, operation, version
        )
        SELECT
          'attachment', NEW.id, NEW.noteId, NEW.userId,
          n.workspaceId, n.notebookId, 'upsert', n.version
        FROM notes n
        WHERE n.id = NEW.noteId;
      END;

      DROP TRIGGER IF EXISTS offline_sync_attachments_delete;
      CREATE TRIGGER offline_sync_attachments_delete
      BEFORE DELETE ON attachments
      BEGIN
        INSERT INTO offline_sync_changes (
          entityType, entityId, noteId, userId, workspaceId, notebookId, operation, version
        )
        SELECT
          'attachment', OLD.id, OLD.noteId, OLD.userId,
          n.workspaceId, n.notebookId, 'delete', n.version
        FROM notes n
        WHERE n.id = OLD.noteId;
      END;

      -- Favorite state is user-specific. Logging it with the acting user keeps
      -- that user's client fresh while the bundle builder recalculates the value
      -- independently for every reader.
      DROP TRIGGER IF EXISTS offline_sync_favorites_insert;
      CREATE TRIGGER offline_sync_favorites_insert
      AFTER INSERT ON favorites
      BEGIN
        INSERT INTO offline_sync_changes (
          entityType, entityId, noteId, userId, workspaceId, notebookId, operation, version
        )
        SELECT
          'note', NEW.noteId, NEW.noteId, NEW.userId,
          n.workspaceId, n.notebookId, 'upsert', n.version
        FROM notes n
        WHERE n.id = NEW.noteId;
      END;

      DROP TRIGGER IF EXISTS offline_sync_favorites_delete;
      CREATE TRIGGER offline_sync_favorites_delete
      AFTER DELETE ON favorites
      BEGIN
        INSERT INTO offline_sync_changes (
          entityType, entityId, noteId, userId, workspaceId, notebookId, operation, version
        )
        SELECT
          'note', OLD.noteId, OLD.noteId, OLD.userId,
          n.workspaceId, n.notebookId, 'upsert', n.version
        FROM notes n
        WHERE n.id = OLD.noteId;
      END;

      DROP TRIGGER IF EXISTS offline_sync_note_tags_insert;
      CREATE TRIGGER offline_sync_note_tags_insert
      AFTER INSERT ON note_tags
      BEGIN
        INSERT INTO offline_sync_changes (
          entityType, entityId, noteId, userId, workspaceId, notebookId, operation, version
        )
        SELECT
          'note', NEW.noteId, NEW.noteId, n.userId,
          n.workspaceId, n.notebookId, 'upsert', n.version
        FROM notes n
        WHERE n.id = NEW.noteId;
      END;

      DROP TRIGGER IF EXISTS offline_sync_note_tags_delete;
      CREATE TRIGGER offline_sync_note_tags_delete
      AFTER DELETE ON note_tags
      BEGIN
        INSERT INTO offline_sync_changes (
          entityType, entityId, noteId, userId, workspaceId, notebookId, operation, version
        )
        SELECT
          'note', OLD.noteId, OLD.noteId, n.userId,
          n.workspaceId, n.notebookId, 'upsert', n.version
        FROM notes n
        WHERE n.id = OLD.noteId;
      END;
    `);
  },
};
