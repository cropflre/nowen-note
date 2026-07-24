import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export const blockAuthorityMigration: Migration = {
  version: 55,
  name: "block-authority-store",
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS note_block_documents (
        noteId TEXT PRIMARY KEY,
        contentFormat TEXT NOT NULL,
        noteVersion INTEGER NOT NULL DEFAULT 1,
        blockVersion INTEGER NOT NULL DEFAULT 1,
        structureVersion INTEGER NOT NULL DEFAULT 1,
        snapshotHash TEXT NOT NULL,
        materializedHash TEXT NOT NULL,
        snapshotContent TEXT NOT NULL,
        rootOrderJson TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'healthy',
        mismatchReason TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS note_block_records (
        noteId TEXT NOT NULL,
        blockId TEXT NOT NULL,
        parentBlockId TEXT,
        blockType TEXT NOT NULL,
        blockOrder INTEGER NOT NULL,
        path TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        payload TEXT NOT NULL,
        payloadHash TEXT NOT NULL,
        plainText TEXT NOT NULL DEFAULT '',
        contentHash TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (noteId, blockId),
        FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_note_block_records_order ON note_block_records(noteId, blockOrder);
      CREATE INDEX IF NOT EXISTS idx_note_block_records_parent ON note_block_records(noteId, parentBlockId);
      CREATE TABLE IF NOT EXISTS note_block_operations (
        id TEXT PRIMARY KEY,
        noteId TEXT NOT NULL,
        operationId TEXT,
        operationType TEXT NOT NULL,
        noteVersion INTEGER NOT NULL,
        blockVersion INTEGER NOT NULL,
        structureVersion INTEGER NOT NULL,
        operationJson TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_note_block_operations_note ON note_block_operations(noteId, createdAt DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_note_block_operations_idempotency
        ON note_block_operations(noteId, operationId) WHERE operationId IS NOT NULL;
      CREATE TABLE IF NOT EXISTS note_block_attachment_refs (
        noteId TEXT NOT NULL,
        blockId TEXT NOT NULL,
        attachmentId TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (noteId, blockId, attachmentId),
        FOREIGN KEY (noteId, blockId) REFERENCES note_block_records(noteId, blockId) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_note_block_attachment_refs_attachment
        ON note_block_attachment_refs(attachmentId, noteId);
    `);
  },
};
