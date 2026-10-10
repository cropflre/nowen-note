/**
 * @deprecated Compatibility facade for callers compiled against the pre-V1 loader.
 *
 * V1 never imports plugin code in the backend process. File scanning, apiToken/apiBaseUrl
 * injection and in-memory registration were deliberately removed. New code must use
 * PluginService and pluginId + actionId.
 */
import { getPluginService } from "./pluginService.js";

export interface SkillContext {
  userId: string;
  workspaceId?: string | null;
  log?: (message: string) => void;
}

export interface SkillResult {
  success: boolean;
  data?: unknown;
  text?: string;
  error?: string;
}

export class PluginLoader {
  getPluginsDir(): string {
    return "managed-by-extension-platform-v1";
  }

  async loadAll(): Promise<void> {
    // Unknown directories and restored code are intentionally never auto-loaded.
  }

  async loadPlugin(): Promise<never> {
    throw new Error("旧式目录插件已停用，请打包为 .nowen-plugin 后由管理员安装");
  }

  async unloadPlugin(name: string): Promise<boolean> {
    const plugin = getPluginService().list(true).find((item) => item.id === name || item.name === name);
    if (!plugin) return false;
    await getPluginService().disable(String(plugin.id));
    return true;
  }

  registerPlugin(): never {
    throw new Error("V1 不允许在主进程注册内存插件");
  }

  listPlugins(): Record<string, unknown>[] {
    return getPluginService().list(true);
  }

  getPlugin(name: string): Record<string, unknown> | undefined {
    return this.listPlugins().find((item) => item.id === name || item.name === name);
  }

  findByAction(actionId: string): Record<string, unknown>[] {
    const ids = new Set(getPluginService().listActions().filter((item) => item.actionId === actionId).map((item) => item.pluginId));
    return this.listPlugins().filter((item) => ids.has(item.id));
  }

  async executePlugin(name: string, params: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const plugin = getPluginService().list(false).find((item) => item.id === name || item.name === name);
    const action = (plugin?.actions as Array<{ id: string }> | undefined)?.[0];
    if (!plugin || !action) return { success: false, error: `插件 ${name} 不存在或没有 Action` };
    try {
      const execution = await getPluginService().execute(String(plugin.id), action.id, context.userId, context.workspaceId || null, params);
      return execution.result as SkillResult;
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  getPluginLogs(name: string): unknown[] {
    const plugin = getPluginService().list(true).find((item) => item.id === name || item.name === name);
    return plugin ? getPluginService().executions.list(String(plugin.id), undefined, 100) : [];
  }
}

let facade: PluginLoader | null = null;
export function getPluginLoader(): PluginLoader {
  if (!facade) facade = new PluginLoader();
  return facade;
}
