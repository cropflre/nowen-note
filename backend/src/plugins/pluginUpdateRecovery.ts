import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/schema.js";
import { getPluginRoot } from "./packageInstaller.js";
import { PluginLifecycle } from "./pluginLifecycle.js";
import type { PluginLifecycleState, PluginUpdateStage } from "./types.js";

interface RecoveryOperation {
  id: string;
  pluginId: string;
  targetVersion: string;
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
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

/** 在任何插件执行服务创建前调用，收敛崩溃时留下的 staging 与切换状态。 */
export function recoverPluginUpdates(): { recovered: number; disabled: number } {
  const db = getDb();
  const table = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='plugin_update_operations'").get();
  if (!table) return { recovered: 0, disabled: 0 };

  const operations = db.prepare(`SELECT id,pluginId,targetVersion,stage,stagingPath
    FROM plugin_update_operations
    WHERE stage IN ('downloaded','verified','staged','switching','probation')
    ORDER BY createdAt`).all() as RecoveryOperation[];
  const lifecycle = new PluginLifecycle();
  let recovered = 0;
  let disabled = 0;

  for (const operation of operations) {
    if (operation.stagingPath) removeStaging(operation.stagingPath);
    removeStaging(path.join(getPluginRoot(), "staging", operation.id));
    const plugin = db.prepare("SELECT version,installedPath,status,lifecycleState,activeOperationId FROM plugin_registry WHERE id=?")
      .get(operation.pluginId) as RecoveryPlugin | undefined;
    if (!plugin) {
      lifecycle.markOperationFailed(operation.id, "PLUGIN_UPDATE_RECOVERY_ORPHANED", "更新对应插件不存在");
      recovered += 1;
      continue;
    }

    if (operation.stage === "probation"
      && plugin.activeOperationId === operation.id
      && plugin.lifecycleState === "probation"
      && plugin.version === operation.targetVersion
      && fs.existsSync(plugin.installedPath)) {
      // 已完成原子切换，仅恢复试运行计数，不把健康候选误回滚。
      if (plugin.status !== "enabled") {
        lifecycle.stabilizeWithoutProbation(operation.pluginId);
        recovered += 1;
      }
      continue;
    }

    if (operation.stage === "switching"
      && plugin.activeOperationId === operation.id
      && plugin.lifecycleState === "probation"
      && plugin.version === operation.targetVersion
      && fs.existsSync(plugin.installedPath)) {
      db.prepare("UPDATE plugin_update_operations SET stage='probation',updatedAt=? WHERE id=?")
        .run(new Date().toISOString(), operation.id);
      if (plugin.status !== "enabled") lifecycle.stabilizeWithoutProbation(operation.pluginId);
      recovered += 1;
      continue;
    }

    try {
      lifecycle.recoverStable(operation.pluginId, operation.id);
      const restored = db.prepare("SELECT lifecycleState FROM plugin_registry WHERE id=?").get(operation.pluginId) as { lifecycleState: PluginLifecycleState };
      if (restored.lifecycleState === "disabled") disabled += 1;
      recovered += 1;
    } catch (error) {
      const coded = error as Error & { code?: string };
      lifecycle.markOperationFailed(operation.id, coded.code || "PLUGIN_UPDATE_RECOVERY_FAILED", coded.message);
      disabled += 1;
    }
  }
  return { recovered, disabled };
}
