import type { Migration } from "./migrations.impl.js";

function hasColumn(db: any, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
}

export const pluginPlatformV11Migration: Migration = {
  version: 94,
  name: "nowen-extension-platform-v1-1-community-ready",
  up: (db) => {
    if (!hasColumn(db, "plugin_registry", "previousVersion")) {
      db.exec("ALTER TABLE plugin_registry ADD COLUMN previousVersion TEXT");
    }
    if (!hasColumn(db, "plugin_executions", "progressCurrent")) {
      db.exec("ALTER TABLE plugin_executions ADD COLUMN progressCurrent INTEGER");
    }
    if (!hasColumn(db, "plugin_executions", "progressTotal")) {
      db.exec("ALTER TABLE plugin_executions ADD COLUMN progressTotal INTEGER");
    }
    if (!hasColumn(db, "plugin_executions", "progressMessage")) {
      db.exec("ALTER TABLE plugin_executions ADD COLUMN progressMessage TEXT");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_versions (
        pluginId TEXT NOT NULL,
        version TEXT NOT NULL,
        manifestJson TEXT NOT NULL,
        checksum TEXT NOT NULL,
        installedPath TEXT NOT NULL,
        source TEXT NOT NULL,
        trustLevel TEXT NOT NULL,
        status TEXT NOT NULL,
        installedAt TEXT NOT NULL,
        verifiedAt TEXT,
        PRIMARY KEY (pluginId, version),
        FOREIGN KEY (pluginId) REFERENCES plugin_registry(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_versions_installed
        ON plugin_versions(pluginId, installedAt DESC);

      INSERT OR IGNORE INTO plugin_versions (
        pluginId, version, manifestJson, checksum, installedPath,
        source, trustLevel, status, installedAt, verifiedAt
      )
      SELECT id, version, manifestJson, checksum, installedPath,
             source, trustLevel, status, installedAt,
             CASE WHEN status='enabled' THEN updatedAt ELSE NULL END
      FROM plugin_registry;
    `);
  },
};
