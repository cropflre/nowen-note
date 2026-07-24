import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

function columnNames(db: Database.Database): Set<string> {
  return new Set((db.prepare("PRAGMA table_info(note_y_subdocument_manifests)").all() as Array<{ name: string }>)
    .map((column) => column.name));
}

export const yjsSubdocumentGenerationMigration: Migration = {
  version: 58,
  name: "yjs-subdocument-generation",
  up: (db) => {
    const columns = columnNames(db);
    if (!columns.has("generation")) {
      db.exec("ALTER TABLE note_y_subdocument_manifests ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
    }
    if (!columns.has("structureVersion")) {
      db.exec("ALTER TABLE note_y_subdocument_manifests ADD COLUMN structureVersion INTEGER NOT NULL DEFAULT 1");
    }
  },
};
