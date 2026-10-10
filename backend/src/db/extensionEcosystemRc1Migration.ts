import type { Migration } from "./migrations.impl.js";

function hasColumn(db: any, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (item) => item.name === column,
  );
}

function addColumnIfMissing(db: any, column: string, definition: string): boolean {
  if (hasColumn(db, "plugin_registry", column)) return false;
  db.exec(`ALTER TABLE plugin_registry ADD COLUMN ${column} ${definition}`);
  return true;
}

function backfillLifecycleState(db: any): void {
  const records = db.prepare(`
    SELECT id, version, status, installedPath, updatedAt,
           previousVersion, probationVersion, probationRemaining
    FROM plugin_registry
  `).all() as Array<{
    id: string;
    version: string;
    status: string;
    installedPath: string;
    updatedAt: string;
    previousVersion: string | null;
    probationVersion: string | null;
    probationRemaining: number;
  }>;
  const update = db.prepare(`
    UPDATE plugin_registry
    SET lifecycleState = ?, previousStableVersion = ?, stateUpdatedAt = ?
    WHERE id = ?
  `);
  const now = new Date().toISOString();

  for (const record of records) {
    const hasInstalledPath = record.installedPath.trim().length > 0;
    const lifecycleState = record.status === "quarantined"
      ? "installed"
      : record.status === "enabled"
        && record.probationVersion === record.version
        && record.probationRemaining > 0
        && hasInstalledPath
        ? "probation"
        : record.status === "enabled" && hasInstalledPath
          ? "stable"
          : "disabled";
    const previousStableVersion = lifecycleState === "probation"
      ? record.previousVersion
      : null;
    update.run(
      lifecycleState,
      previousStableVersion,
      record.updatedAt || now,
      record.id,
    );
  }
}

export const extensionEcosystemRc1Migration: Migration = {
  version: 97,
  name: "nowen-extension-platform-v2-rc1-lifecycle",
  up: (db) => {
    const lifecycleStateAdded = addColumnIfMissing(
      db,
      "lifecycleState",
      "TEXT NOT NULL DEFAULT 'disabled' CHECK (lifecycleState IN ('installed', 'preflight', 'probation', 'stable', 'rollback_pending', 'rolling_back', 'disabled'))",
    );
    addColumnIfMissing(db, "previousStableVersion", "TEXT");
    addColumnIfMissing(db, "activeOperationId", "TEXT");
    addColumnIfMissing(db, "stateUpdatedAt", "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing(db, "nodeRuntimeConfirmedAt", "TEXT");
    addColumnIfMissing(db, "nodeRuntimeConfirmedBy", "TEXT");

    if (lifecycleStateAdded) backfillLifecycleState(db);
    db.prepare(`
      UPDATE plugin_registry
      SET stateUpdatedAt = COALESCE(NULLIF(stateUpdatedAt, ''), NULLIF(updatedAt, ''), ?)
      WHERE stateUpdatedAt IS NULL OR stateUpdatedAt = ''
    `).run(new Date().toISOString());

    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_update_operations (
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
      CREATE INDEX IF NOT EXISTS idx_plugin_update_operations_recovery
        ON plugin_update_operations(stage, updatedAt);
      CREATE INDEX IF NOT EXISTS idx_plugin_update_operations_plugin_time
        ON plugin_update_operations(pluginId, createdAt DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_update_operations_active_plugin
        ON plugin_update_operations(pluginId)
        WHERE stage IN (
          'downloaded', 'verified', 'staged', 'preflight', 'switching',
          'probation', 'rollback_pending', 'rolling_back'
        );

      CREATE TABLE IF NOT EXISTS plugin_registry_metadata_state (
        sourceId TEXT PRIMARY KEY,
        highestSeenSequence INTEGER NOT NULL CHECK (highestSeenSequence >= 0),
        documentDigest TEXT NOT NULL,
        generatedAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        verifiedAt TEXT NOT NULL,
        signerKeyId TEXT NOT NULL,
        documentJson TEXT NOT NULL,
        FOREIGN KEY (sourceId) REFERENCES plugin_sources(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_registry_metadata_expiry
        ON plugin_registry_metadata_state(expiresAt, verifiedAt);

      CREATE TABLE IF NOT EXISTS plugin_registry_root_chain (
        sourceId TEXT NOT NULL,
        keyId TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        parentKeyId TEXT,
        publicKey TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'revoked')),
        validFrom TEXT NOT NULL,
        validUntil TEXT,
        signedByKeyId TEXT,
        signature TEXT,
        documentJson TEXT NOT NULL,
        verifiedAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (sourceId, keyId),
        UNIQUE (sourceId, sequence),
        FOREIGN KEY (sourceId) REFERENCES plugin_sources(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_registry_root_chain_state
        ON plugin_registry_root_chain(sourceId, state, sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_plugin_registry_root_chain_validity
        ON plugin_registry_root_chain(sourceId, validUntil);

      CREATE TABLE IF NOT EXISTS plugin_security_advisories (
        sourceId TEXT NOT NULL,
        advisoryId TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        pluginId TEXT NOT NULL,
        affectedVersionRange TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
        action TEXT NOT NULL CHECK (action IN ('disable', 'warn', 'recommend', 'info')),
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'withdrawn', 'expired')),
        title TEXT NOT NULL,
        detailsUrl TEXT,
        replacesAdvisoryId TEXT,
        publishedAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        withdrawnAt TEXT,
        signerKeyId TEXT NOT NULL,
        signature TEXT NOT NULL,
        documentJson TEXT NOT NULL,
        verifiedAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (sourceId, advisoryId),
        FOREIGN KEY (sourceId) REFERENCES plugin_sources(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_security_advisories_plugin
        ON plugin_security_advisories(pluginId, state, severity, expiresAt);
      CREATE INDEX IF NOT EXISTS idx_plugin_security_advisories_sequence
        ON plugin_security_advisories(sourceId, sequence DESC);

      CREATE TABLE IF NOT EXISTS plugin_advisory_receipts (
        sourceId TEXT NOT NULL,
        advisoryId TEXT NOT NULL,
        pluginId TEXT NOT NULL,
        pluginVersion TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('disabled', 'warned', 'recommended', 'informed', 'withdrawn')),
        outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'skipped', 'failed')),
        reason TEXT,
        errorCode TEXT,
        processedAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (sourceId, advisoryId, pluginId, pluginVersion, action),
        FOREIGN KEY (sourceId, advisoryId)
          REFERENCES plugin_security_advisories(sourceId, advisoryId) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_advisory_receipts_plugin
        ON plugin_advisory_receipts(pluginId, processedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_plugin_advisory_receipts_outcome
        ON plugin_advisory_receipts(outcome, updatedAt);

      CREATE TABLE IF NOT EXISTS plugin_security_events (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN (
          'sandbox', 'network', 'signature', 'metadata',
          'advisory', 'update', 'runtime', 'policy'
        )),
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
        eventCode TEXT NOT NULL,
        pluginId TEXT,
        sourceId TEXT,
        operationId TEXT,
        executionId TEXT,
        correlationId TEXT,
        detailsJson TEXT NOT NULL DEFAULT '{}',
        occurredAt TEXT NOT NULL,
        resolvedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_security_events_time
        ON plugin_security_events(occurredAt DESC);
      CREATE INDEX IF NOT EXISTS idx_plugin_security_events_plugin_time
        ON plugin_security_events(pluginId, occurredAt DESC);
      CREATE INDEX IF NOT EXISTS idx_plugin_security_events_unresolved
        ON plugin_security_events(severity, occurredAt DESC)
        WHERE resolvedAt IS NULL;
      CREATE INDEX IF NOT EXISTS idx_plugin_security_events_operation
        ON plugin_security_events(operationId, occurredAt DESC);

      CREATE TABLE IF NOT EXISTS plugin_telemetry_consent (
        ownerUserId TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        consentVersion TEXT NOT NULL,
        decisionSource TEXT NOT NULL DEFAULT 'default'
          CHECK (decisionSource IN ('default', 'user', 'admin')),
        decidedAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (ownerUserId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_telemetry_consent_state
        ON plugin_telemetry_consent(enabled, updatedAt);

      CREATE INDEX IF NOT EXISTS idx_plugin_registry_lifecycle_recovery
        ON plugin_registry(lifecycleState, stateUpdatedAt);
      CREATE INDEX IF NOT EXISTS idx_plugin_registry_active_operation
        ON plugin_registry(activeOperationId)
        WHERE activeOperationId IS NOT NULL;

      CREATE TRIGGER IF NOT EXISTS plugin_registry_rc1_state_after_insert
      AFTER INSERT ON plugin_registry
      WHEN NEW.stateUpdatedAt = ''
      BEGIN
        UPDATE plugin_registry
        SET stateUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS plugin_registry_rc1_state_after_lifecycle_update
      AFTER UPDATE OF lifecycleState ON plugin_registry
      WHEN NEW.lifecycleState <> OLD.lifecycleState
        AND NEW.stateUpdatedAt = OLD.stateUpdatedAt
      BEGIN
        UPDATE plugin_registry
        SET stateUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = NEW.id;
      END;
    `);
  },
};
