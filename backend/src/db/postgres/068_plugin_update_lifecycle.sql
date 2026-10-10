-- 为已应用 RC1 schema 的 PostgreSQL 数据库补齐候选生命周期阶段。
BEGIN;

ALTER TABLE plugin_update_operations
  DROP CONSTRAINT IF EXISTS plugin_update_operations_stage_check;
ALTER TABLE plugin_update_operations
  ADD CONSTRAINT plugin_update_operations_stage_check CHECK (stage IN (
    'downloaded', 'verified', 'staged', 'preflight', 'switching',
    'probation', 'rollback_pending', 'rolling_back',
    'stable', 'failed', 'rolled_back'
  ));

DROP INDEX IF EXISTS idx_plugin_update_operations_active_plugin;
CREATE UNIQUE INDEX idx_plugin_update_operations_active_plugin
  ON plugin_update_operations("pluginId")
  WHERE stage IN (
    'downloaded', 'verified', 'staged', 'preflight', 'switching',
    'probation', 'rollback_pending', 'rolling_back'
  );

UPDATE plugin_versions
SET status = 'stable'
WHERE status = 'enabled' AND "verifiedAt" IS NOT NULL;

COMMIT;
