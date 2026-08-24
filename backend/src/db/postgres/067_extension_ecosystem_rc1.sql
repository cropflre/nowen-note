-- Extension Ecosystem V2 RC1 生命周期与供应链状态。
-- 在扩展平台基础结构之后执行；本脚本可安全重复执行。

ALTER TABLE plugin_registry
  ADD COLUMN IF NOT EXISTS "lifecycleState" TEXT NOT NULL DEFAULT 'disabled'
    CHECK ("lifecycleState" IN (
      'installed', 'preflight', 'probation', 'stable',
      'rollback_pending', 'rolling_back', 'disabled'
    )),
  ADD COLUMN IF NOT EXISTS "previousStableVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "activeOperationId" TEXT,
  ADD COLUMN IF NOT EXISTS "stateUpdatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "nodeRuntimeConfirmedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "nodeRuntimeConfirmedBy" TEXT;

UPDATE plugin_registry
SET
  "lifecycleState" = CASE
    WHEN status = 'quarantined' THEN 'installed'
    WHEN status = 'enabled'
      AND "probationVersion" = version
      AND "probationRemaining" > 0
      AND NULLIF(BTRIM("installedPath"), '') IS NOT NULL THEN 'probation'
    WHEN status = 'enabled'
      AND NULLIF(BTRIM("installedPath"), '') IS NOT NULL THEN 'stable'
    ELSE 'disabled'
  END,
  "previousStableVersion" = CASE
    WHEN status = 'enabled'
      AND "probationVersion" = version
      AND "probationRemaining" > 0 THEN "previousVersion"
    ELSE NULL
  END,
  "stateUpdatedAt" = COALESCE("stateUpdatedAt", "updatedAt", NOW())
WHERE "stateUpdatedAt" IS NULL;

CREATE TABLE IF NOT EXISTS plugin_update_operations (
  id TEXT PRIMARY KEY,
  "pluginId" TEXT NOT NULL REFERENCES plugin_registry(id) ON DELETE CASCADE,
  "fromVersion" TEXT,
  "targetVersion" TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'downloaded', 'verified', 'staged', 'switching',
    'probation', 'stable', 'failed', 'rolled_back'
  )),
  "targetChecksum" TEXT,
  "stagingPath" TEXT,
  "backupPath" TEXT,
  "requestedBy" TEXT,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  "completedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_plugin_update_operations_recovery
  ON plugin_update_operations(stage, "updatedAt");
CREATE INDEX IF NOT EXISTS idx_plugin_update_operations_plugin_time
  ON plugin_update_operations("pluginId", "createdAt" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_update_operations_active_plugin
  ON plugin_update_operations("pluginId")
  WHERE stage IN ('downloaded', 'verified', 'staged', 'switching', 'probation');

CREATE TABLE IF NOT EXISTS plugin_registry_metadata_state (
  "sourceId" TEXT PRIMARY KEY REFERENCES plugin_sources(id) ON DELETE CASCADE,
  "highestSeenSequence" BIGINT NOT NULL CHECK ("highestSeenSequence" >= 0),
  "documentDigest" TEXT NOT NULL,
  "generatedAt" TIMESTAMPTZ NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "verifiedAt" TIMESTAMPTZ NOT NULL,
  "signerKeyId" TEXT NOT NULL,
  "documentJson" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_registry_metadata_expiry
  ON plugin_registry_metadata_state("expiresAt", "verifiedAt");

CREATE TABLE IF NOT EXISTS plugin_registry_root_chain (
  "sourceId" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence >= 0),
  "parentKeyId" TEXT,
  "publicKey" TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'revoked')),
  "validFrom" TIMESTAMPTZ NOT NULL,
  "validUntil" TIMESTAMPTZ,
  "signedByKeyId" TEXT,
  signature TEXT,
  "documentJson" TEXT NOT NULL,
  "verifiedAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  PRIMARY KEY ("sourceId", "keyId"),
  UNIQUE ("sourceId", sequence),
  FOREIGN KEY ("sourceId") REFERENCES plugin_sources(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plugin_registry_root_chain_state
  ON plugin_registry_root_chain("sourceId", state, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_plugin_registry_root_chain_validity
  ON plugin_registry_root_chain("sourceId", "validUntil");

CREATE TABLE IF NOT EXISTS plugin_security_advisories (
  "sourceId" TEXT NOT NULL,
  "advisoryId" TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence >= 0),
  "pluginId" TEXT NOT NULL,
  "affectedVersionRange" TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  action TEXT NOT NULL CHECK (action IN ('disable', 'warn', 'recommend', 'info')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'withdrawn', 'expired')),
  title TEXT NOT NULL,
  "detailsUrl" TEXT,
  "replacesAdvisoryId" TEXT,
  "publishedAt" TIMESTAMPTZ NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "withdrawnAt" TIMESTAMPTZ,
  "signerKeyId" TEXT NOT NULL,
  signature TEXT NOT NULL,
  "documentJson" TEXT NOT NULL,
  "verifiedAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  PRIMARY KEY ("sourceId", "advisoryId"),
  FOREIGN KEY ("sourceId") REFERENCES plugin_sources(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plugin_security_advisories_plugin
  ON plugin_security_advisories("pluginId", state, severity, "expiresAt");
CREATE INDEX IF NOT EXISTS idx_plugin_security_advisories_sequence
  ON plugin_security_advisories("sourceId", sequence DESC);

CREATE TABLE IF NOT EXISTS plugin_advisory_receipts (
  "sourceId" TEXT NOT NULL,
  "advisoryId" TEXT NOT NULL,
  "pluginId" TEXT NOT NULL,
  "pluginVersion" TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('disabled', 'warned', 'recommended', 'informed', 'withdrawn')),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'skipped', 'failed')),
  reason TEXT,
  "errorCode" TEXT,
  "processedAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  PRIMARY KEY ("sourceId", "advisoryId", "pluginId", "pluginVersion", action),
  FOREIGN KEY ("sourceId", "advisoryId")
    REFERENCES plugin_security_advisories("sourceId", "advisoryId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plugin_advisory_receipts_plugin
  ON plugin_advisory_receipts("pluginId", "processedAt" DESC);
CREATE INDEX IF NOT EXISTS idx_plugin_advisory_receipts_outcome
  ON plugin_advisory_receipts(outcome, "updatedAt");

CREATE TABLE IF NOT EXISTS plugin_security_events (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN (
    'sandbox', 'network', 'signature', 'metadata',
    'advisory', 'update', 'runtime', 'policy'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  "eventCode" TEXT NOT NULL,
  "pluginId" TEXT,
  "sourceId" TEXT,
  "operationId" TEXT,
  "executionId" TEXT,
  "correlationId" TEXT,
  "detailsJson" TEXT NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMPTZ NOT NULL,
  "resolvedAt" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_plugin_security_events_time
  ON plugin_security_events("occurredAt" DESC);
CREATE INDEX IF NOT EXISTS idx_plugin_security_events_plugin_time
  ON plugin_security_events("pluginId", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS idx_plugin_security_events_unresolved
  ON plugin_security_events(severity, "occurredAt" DESC)
  WHERE "resolvedAt" IS NULL;
CREATE INDEX IF NOT EXISTS idx_plugin_security_events_operation
  ON plugin_security_events("operationId", "occurredAt" DESC);

CREATE TABLE IF NOT EXISTS plugin_telemetry_consent (
  "ownerUserId" TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  "consentVersion" TEXT NOT NULL,
  "decisionSource" TEXT NOT NULL DEFAULT 'default'
    CHECK ("decisionSource" IN ('default', 'user', 'admin')),
  "decidedAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_telemetry_consent_state
  ON plugin_telemetry_consent(enabled, "updatedAt");

CREATE INDEX IF NOT EXISTS idx_plugin_registry_lifecycle_recovery
  ON plugin_registry("lifecycleState", "stateUpdatedAt");
CREATE INDEX IF NOT EXISTS idx_plugin_registry_active_operation
  ON plugin_registry("activeOperationId")
  WHERE "activeOperationId" IS NOT NULL;
