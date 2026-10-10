import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/schema.js";
import { getPluginRoot, PluginPackageInstaller } from "./packageInstaller.js";
import { PluginLifecycle } from "./pluginLifecycle.js";
import type { PluginLifecycleState, PluginUpdateStage } from "./types.js";

interface RecoveryOperation {
  id: string;
  pluginId: string;
  targetVersion: string;
  targetChecksum: string | null;
  stage: PluginUpdateStage;
  stagingPath: string | null;
}

interface RecoveryPlugin {
  version: string;
  installedPath: string;
  status: string;
  lifecycleState: PluginLifecycleState;
  activeOperationId: string | null;
}

function removeStaging(target: string): void {
  const root = path.resolve(getPluginRoot(), "staging");
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

/** 在任何插件执行服务创建前调用，收敛崩溃时留下的 staging 与切换状态。 */
export function recoverPluginUpdates(): { recovered: number; disabled: number } {
  const db = getDb();
  const table = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='plugin_update_operations'").get();
  if (!table) return { recovered: 0, disabled: 0 };

  const operations = db.prepare(`SELECT id,pluginId,targetVersion,targetChecksum,stage,stagingPath
    FROM plugin_update_operations
    WHERE stage IN (
      'downloaded','verified','staged','preflight','switching',
      'probation','rollback_pending','rolling_back'
    )
    ORDER BY createdAt`).all() as RecoveryOperation[];
  const lifecycle = new PluginLifecycle();
  const installer = new PluginPackageInstaller();
  let recovered = 0;
  let disabled = 0;

  for (const operation of operations) {
    try {
      const plugin = db.prepare("SELECT version,installedPath,status,lifecycleState,activeOperationId FROM plugin_registry WHERE id=?")
        .get(operation.pluginId) as RecoveryPlugin | undefined;
      if (!plugin) {
        lifecycle.markOperationFailed(operation.id, "PLUGIN_UPDATE_RECOVERY_ORPHANED", "更新对应插件不存在");
        recovered += 1;
        continue;
      }

      lifecycle.recoverStable(operation.pluginId, operation.id);
      const restored = db.prepare("SELECT lifecycleState FROM plugin_registry WHERE id=?").get(operation.pluginId) as { lifecycleState: PluginLifecycleState };
      if (restored.lifecycleState === "disabled") disabled += 1;
      recovered += 1;
    } catch (error) {
      const coded = error as Error & { code?: string };
      lifecycle.disableAfterRecoveryFailure(
        operation.pluginId,
        operation.id,
        coded.code || "PLUGIN_UPDATE_RECOVERY_FAILED",
        coded.message,
      );
      disabled += 1;
    } finally {
      try { if (operation.stagingPath) removeStaging(operation.stagingPath); } catch { /* 恢复失败不跳过状态收敛 */ }
      try { removeStaging(path.join(getPluginRoot(), "staging", operation.id)); } catch { /* 尽力清理 */ }
      if (operation.targetChecksum) {
        try {
          installer.removeUnregisteredVersionCoordinate(operation.pluginId, operation.targetVersion, operation.targetChecksum);
        } catch { /* 已注册版本绝不删除，孤立目录仅尽力清理 */ }
      }
    }
  }
  return { recovered, disabled };
}
