import type { Migration } from "./migrations.impl.js";

export const yjsSubdocumentsMigration: Migration = {
  version: 56,
  name: "yjs-subdocuments",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS note_y_subdocument_manifests (
        noteId TEXT PRIMARY KEY,
        rootGuid TEXT NOT NULL,
        rootSnapshot BLOB NOT NULL,
        contentHash TEXT NOT NULL,
        sectionCount INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'healthy',
        mismatchReason TEXT,
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS note_y_subdocuments (
        noteId TEXT NOT NULL,
        sectionId TEXT NOT NULL,
        guid TEXT NOT NULL,
        blockStart INTEGER NOT NULL,
        blockEnd INTEGER NOT NULL,
        snapshotBlob BLOB NOT NULL,
        payloadHash TEXT NOT NULL,
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (noteId, sectionId),
        UNIQUE (noteId, guid),
        FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_note_y_subdocuments_order
        ON note_y_subdocuments(noteId, blockStart);
      CREATE TABLE IF NOT EXISTS note_y_subdocument_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        noteId TEXT NOT NULL,
        sectionId TEXT NOT NULL,
        userId TEXT,
        updateBlob BLOB NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (noteId, sectionId) REFERENCES note_y_subdocuments(noteId, sectionId) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_note_y_subdocument_updates_section
        ON note_y_subdocument_updates(noteId, sectionId, id);
    `);
  },
};
