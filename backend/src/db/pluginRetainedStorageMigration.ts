import type { Migration } from "./migrations.impl.js";

export const pluginRetainedStorageMigration: Migration = {
  version: 132,
  name: "plugin-retained-storage",
  up(db) {
    // Deliberately survives registry deletion; scope and publisher must match on reinstall.
    db.exec(`CREATE TABLE IF NOT EXISTS plugin_retained_storage (
      pluginId TEXT NOT NULL, publisher TEXT NOT NULL, scopeType TEXT NOT NULL,
      scopeId TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updatedAt TEXT NOT NULL,
      PRIMARY KEY(pluginId,scopeType,scopeId,key)
    )`);
  },
};
