import type { Migration } from "./migrations.impl.js";

export const migrationDecisionsMigration: Migration = {
  version: 144,
  name: "migration-preview-item-decisions",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(migration_items)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "decision")) {
      db.exec("ALTER TABLE migration_items ADD COLUMN decision TEXT NOT NULL DEFAULT 'auto' CHECK(decision IN ('auto','skip','keep-existing','create-copy'))");
    }
  },
};
