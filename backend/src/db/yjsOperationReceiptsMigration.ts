import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export function ensureYjsOperationReceiptsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS yjs_operation_receipts (
      noteId TEXT NOT NULL,
      operationId TEXT NOT NULL,
      updateId INTEGER NOT NULL,
      userId TEXT,
      updateHash TEXT NOT NULL,
      persistedAt TEXT NOT NULL,
      PRIMARY KEY (noteId, operationId),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_yjs_operation_receipts_persisted
      ON yjs_operation_receipts(persistedAt);
  `);
}

export const yjsOperationReceiptsMigration: Migration = {
  version: 71,
  name: "yjs-operation-receipts",
  up: ensureYjsOperationReceiptsSchema,
};
