import type { Migration } from "./migrations.impl.js";

export const pluginPlatformMigration: Migration = {
  version: 93,
  name: "nowen-extension-platform-v1",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_registry (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        apiVersion INTEGER NOT NULL,
        runtime TEXT NOT NULL,
        main TEXT NOT NULL,
        source TEXT NOT NULL,
        trustLevel TEXT NOT NULL,
        status TEXT NOT NULL,
        checksum TEXT NOT NULL,
        manifestJson TEXT NOT NULL,
        installedPath TEXT NOT NULL,
        installedBy TEXT,
        installedAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        lastError TEXT
      );

      CREATE TABLE IF NOT EXISTS plugin_permissions (
        pluginId TEXT NOT NULL,
        permission TEXT NOT NULL,
        configJson TEXT NOT NULL DEFAULT '{}',
        granted INTEGER NOT NULL DEFAULT 0,
        grantedBy TEXT,
        grantedAt TEXT,
        PRIMARY KEY (pluginId, permission),
        FOREIGN KEY (pluginId) REFERENCES plugin_registry(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS plugin_executions (
        id TEXT PRIMARY KEY,
        pluginId TEXT NOT NULL,
        actionId TEXT NOT NULL,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        status TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        finishedAt TEXT,
        durationMs INTEGER,
        inputBytes INTEGER NOT NULL DEFAULT 0,
        outputBytes INTEGER NOT NULL DEFAULT 0,
        errorCode TEXT,
        errorMessage TEXT,
        logTail TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (pluginId) REFERENCES plugin_registry(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_executions_plugin_started
        ON plugin_executions(pluginId, startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_plugin_executions_user_started
        ON plugin_executions(userId, startedAt DESC);

      CREATE TABLE IF NOT EXISTS plugin_storage (
        pluginId TEXT NOT NULL,
        scopeType TEXT NOT NULL,
        scopeId TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (pluginId, scopeType, scopeId, key),
        FOREIGN KEY (pluginId) REFERENCES plugin_registry(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS plugin_secrets (
        id TEXT PRIMARY KEY,
        pluginId TEXT NOT NULL,
        ownerUserId TEXT NOT NULL,
        name TEXT NOT NULL,
        encryptedValue TEXT NOT NULL,
        iv TEXT NOT NULL,
        authTag TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(pluginId, ownerUserId, name),
        FOREIGN KEY (pluginId) REFERENCES plugin_registry(id) ON DELETE CASCADE
      );
    `);
  },
};
