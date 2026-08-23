import type { Migration } from "./migrations.impl.js";

function hasColumn(db: any, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
}

export const extensionEcosystemMigration: Migration = {
  version: 96,
  name: "nowen-extension-platform-v2-ecosystem",
  up: (db) => {
    for (const [column, definition] of [
      ["publisher", "TEXT"], ["signatureState", "TEXT NOT NULL DEFAULT 'unsigned'"], ["advisoryState", "TEXT NOT NULL DEFAULT 'unknown'"],
      ["updatePolicy", "TEXT NOT NULL DEFAULT 'manual'"], ["pinnedVersion", "TEXT"], ["probationVersion", "TEXT"],
      ["probationRemaining", "INTEGER NOT NULL DEFAULT 0"], ["autoRollbackReason", "TEXT"],
    ] as const) if (!hasColumn(db, "plugin_registry", column)) db.exec(`ALTER TABLE plugin_registry ADD COLUMN ${column} ${definition}`);
    for (const [column, definition] of [
      ["publisherKeyId", "TEXT"], ["signature", "TEXT"], ["signatureState", "TEXT NOT NULL DEFAULT 'unsigned'"], ["artifactUrl", "TEXT"],
    ] as const) if (!hasColumn(db, "plugin_versions", column)) db.exec(`ALTER TABLE plugin_versions ADD COLUMN ${column} ${definition}`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        indexUrl TEXT NOT NULL,
        official INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        registryKeyId TEXT,
        registryPublicKey TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plugin_update_state (
        pluginId TEXT PRIMARY KEY,
        channel TEXT NOT NULL DEFAULT 'stable',
        availableVersion TEXT,
        permissionDiffJson TEXT,
        checkedAt TEXT,
        lastUpdateAt TEXT,
        lastError TEXT,
        FOREIGN KEY (pluginId) REFERENCES plugin_registry(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS plugin_trust_records (
        sourceId TEXT NOT NULL,
        publisher TEXT NOT NULL,
        keyId TEXT NOT NULL,
        publicKey TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        validFrom TEXT,
        validUntil TEXT,
        revokedAt TEXT,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (sourceId, keyId)
      );

      CREATE TABLE IF NOT EXISTS plugin_security_state (
        pluginId TEXT NOT NULL,
        version TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'unknown',
        severity TEXT,
        advisoryId TEXT,
        title TEXT,
        detailsUrl TEXT,
        action TEXT,
        checkedAt TEXT NOT NULL,
        PRIMARY KEY (pluginId, version)
      );

      CREATE TABLE IF NOT EXISTS plugin_policy (
        id TEXT PRIMARY KEY CHECK(id='default'),
        policyJson TEXT NOT NULL,
        updatedBy TEXT,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plugin_settings (
        pluginId TEXT NOT NULL,
        ownerUserId TEXT NOT NULL,
        key TEXT NOT NULL,
        valueJson TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (pluginId, ownerUserId, key),
        FOREIGN KEY (pluginId) REFERENCES plugin_registry(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS marketplace_cache (
        sourceId TEXT NOT NULL,
        extensionId TEXT NOT NULL,
        metadataJson TEXT NOT NULL,
        fetchedAt TEXT NOT NULL,
        PRIMARY KEY (sourceId, extensionId)
      );

      CREATE TABLE IF NOT EXISTS extension_reviews (
        id TEXT PRIMARY KEY,
        extensionId TEXT NOT NULL,
        version TEXT NOT NULL,
        userId TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        comment TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(extensionId,userId,version)
      );

      CREATE TABLE IF NOT EXISTS extension_reports (
        id TEXT PRIMARY KEY,
        extensionId TEXT NOT NULL,
        version TEXT,
        userId TEXT NOT NULL,
        reason TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS extension_telemetry_queue (
        id TEXT PRIMARY KEY,
        eventType TEXT NOT NULL,
        extensionId TEXT NOT NULL,
        version TEXT,
        platform TEXT,
        errorCode TEXT,
        createdAt TEXT NOT NULL
      );
    `);
    db.prepare("INSERT OR IGNORE INTO plugin_policy(id,policyJson,updatedAt) VALUES ('default',?,?)")
      .run(JSON.stringify({ allowOfficial: true, allowVerified: true, allowCommunity: true, allowNodeRuntime: true, allowedPublishers: [], allowedExtensions: [], blockedExtensions: [] }), new Date().toISOString());
  },
};
