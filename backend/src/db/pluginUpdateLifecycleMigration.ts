import type { Migration } from "./migrations.impl.js";

/** 为已应用 v97 的 SQLite 数据库补齐候选 preflight 与回滚阶段。 */
export const pluginUpdateLifecycleMigration: Migration = {
  version: 98,
  name: "plugin-update-candidate-lifecycle",
  up: (db) => {
    db.exec(`
      CREATE TABLE plugin_update_operations_v98 (
        id TEXT PRIMARY KEY,
        pluginId TEXT NOT NULL,
        fromVersion TEXT,
        targetVersion TEXT NOT NULL,
        stage TEXT NOT NULL CHECK (stage IN (
          'downloaded', 'verified', 'staged', 'preflight', 'switching',
          'probation', 'rollback_pending', 'rolling_back',
          'stable', 'failed', 'rolled_back'
        )),
        targetChecksum TEXT,
        stagingPath TEXT,
        backupPath TEXT,
        requestedBy TEXT,
        errorCode TEXT,
        errorMessage TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        completedAt TEXT,
        FOREIGN KEY (pluginId) REFERENCES plugin_registry(id) ON DELETE CASCADE
      );

      INSERT INTO plugin_update_operations_v98 (
        id, pluginId, fromVersion, targetVersion, stage, targetChecksum,
        stagingPath, backupPath, requestedBy, errorCode, errorMessage,
        createdAt, updatedAt, completedAt
      )
      SELECT
        id, pluginId, fromVersion, targetVersion, stage, targetChecksum,
        stagingPath, backupPath, requestedBy, errorCode, errorMessage,
        createdAt, updatedAt, completedAt
      FROM plugin_update_operations;

      DROP TABLE plugin_update_operations;
      ALTER TABLE plugin_update_operations_v98 RENAME TO plugin_update_operations;

      CREATE INDEX idx_plugin_update_operations_recovery
        ON plugin_update_operations(stage, updatedAt);
      CREATE INDEX idx_plugin_update_operations_plugin_time
        ON plugin_update_operations(pluginId, createdAt DESC);
      CREATE UNIQUE INDEX idx_plugin_update_operations_active_plugin
        ON plugin_update_operations(pluginId)
        WHERE stage IN (
          'downloaded', 'verified', 'staged', 'preflight', 'switching',
          'probation', 'rollback_pending', 'rolling_back'
        );

      UPDATE plugin_versions
      SET status = 'stable'
      WHERE status = 'enabled' AND verifiedAt IS NOT NULL;
    `);
  },
};
