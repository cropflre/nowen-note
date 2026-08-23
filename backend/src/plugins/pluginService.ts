import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/schema.js";
import { HostApiBroker } from "./hostApiBroker.js";
import { PluginExecutionManager } from "./executionManager.js";
import { validateActionInput } from "./manifest.js";
import { PluginPackageInstaller } from "./packageInstaller.js";
import { PluginPermissions } from "./permissions.js";
import { PluginRegistry } from "./registry.js";
import { PluginSecrets } from "./secrets.js";
import type { PluginManifestV1, PluginRegistryRecord } from "./types.js";

function manifestOf(record: PluginRegistryRecord): PluginManifestV1 {
  return JSON.parse(record.manifestJson) as PluginManifestV1;
}

export class PluginService {
  readonly registry = new PluginRegistry();
  readonly permissions = new PluginPermissions();
  readonly installer = new PluginPackageInstaller(this.registry, this.permissions);
  readonly secrets = new PluginSecrets();
  readonly broker = new HostApiBroker(this.permissions, this.secrets);
  readonly executions = new PluginExecutionManager(this.broker, this.registry);

  constructor() {
    // 开发目录每次服务重启都要重新确认，不能继承上次的 enabled/granted 状态。
    const db = getDb();
    db.prepare("UPDATE plugin_registry SET status='quarantined',lastError='开发插件重启后需要重新确认',updatedAt=? WHERE source='dev'")
      .run(new Date().toISOString());
    db.prepare("UPDATE plugin_permissions SET granted=0,grantedBy=NULL,grantedAt=NULL WHERE pluginId IN (SELECT id FROM plugin_registry WHERE source='dev')").run();
  }

  list(includeDisabled = true): Array<Record<string, unknown>> {
    return this.registry.list()
      .filter((record) => includeDisabled || record.status === "enabled")
      .map((record) => this.publicRecord(record));
  }

  get(pluginId: string): Record<string, unknown> {
    const record = this.requireRecord(pluginId);
    return this.publicRecord(record);
  }

  listActions(): Array<Record<string, unknown>> {
    return this.registry.list().flatMap((record) => {
      if (record.status !== "enabled") return [];
      const manifest = manifestOf(record);
      return manifest.actions.map((action) => ({
        pluginId: record.id,
        actionId: action.id,
        name: action.name,
        description: action.description || "",
        execution: action.execution || "interactive",
        input: action.input || {},
      }));
    });
  }

  async install(bytes: Buffer, installedBy: string): Promise<Record<string, unknown>> {
    return this.publicRecord(await this.installer.install(bytes, installedBy));
  }

  async loadDevelopmentDirectory(directory: string, installedBy: string): Promise<Record<string, unknown>> {
    if (!this.isDeveloperModeAvailable()) throw new Error("当前部署形态不支持本地开发插件");
    if (!this.isDeveloperModeEnabled()) throw new Error("请先启用插件开发者模式");
    return this.publicRecord(await this.installer.loadDevelopmentDirectory(directory, installedBy));
  }

  setDeveloperMode(enabled: boolean): void {
    if (enabled && !this.isDeveloperModeAvailable()) throw new Error("开发者模式仅限 Desktop Embedded Backend 或开发环境");
    getDb().prepare(`INSERT INTO system_settings(key,value,updatedAt) VALUES ('plugins:developerMode',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`)
      .run(enabled ? "1" : "0", new Date().toISOString());
  }

  isDeveloperModeEnabled(): boolean {
    const row = getDb().prepare("SELECT value FROM system_settings WHERE key='plugins:developerMode'").get() as { value: string } | undefined;
    return row?.value === "1";
  }

  isDeveloperModeAvailable(): boolean {
    return process.env.NODE_ENV !== "production" || Boolean(process.env.ELECTRON_USER_DATA);
  }

  grantPermissions(pluginId: string, grants: string[], grantedBy: string): Record<string, unknown> {
    this.requireRecord(pluginId);
    return { pluginId, permissions: this.permissions.replaceGrants(pluginId, grants, grantedBy) };
  }

  async enable(pluginId: string): Promise<Record<string, unknown>> {
    let record = this.requireRecord(pluginId);
    if (!this.permissions.allDeclaredGranted(pluginId)) throw new Error("必须先确认并授予插件声明的全部权限");
    if (!fs.existsSync(record.installedPath)) throw new Error("插件目录不存在");
    record = this.installer.moveToInstalled(record);
    await this.executions.restart(pluginId);
    this.registry.setStatus(pluginId, "enabled");
    return this.get(pluginId);
  }

  async disable(pluginId: string): Promise<Record<string, unknown>> {
    this.requireRecord(pluginId);
    await this.executions.shutdown(pluginId);
    this.registry.setStatus(pluginId, "disabled");
    return this.get(pluginId);
  }

  async reload(pluginId: string): Promise<Record<string, unknown>> {
    const record = this.requireRecord(pluginId);
    if (record.status !== "enabled") throw new Error("只有已启用插件可以重新加载");
    await this.executions.restart(pluginId);
    return this.get(pluginId);
  }

  async uninstall(pluginId: string): Promise<void> {
    const record = this.requireRecord(pluginId);
    await this.executions.shutdown(pluginId);
    this.installer.removeFiles(record);
    this.registry.remove(pluginId);
  }

  async execute(pluginId: string, actionId: string, userId: string, workspaceId: string | null, input: unknown, executionId?: string) {
    const record = this.requireRecord(pluginId);
    if (record.status !== "enabled") throw Object.assign(new Error(`插件当前状态为 ${record.status}`), { code: "PLUGIN_NOT_ENABLED" });
    const manifest = manifestOf(record);
    const action = manifest.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw Object.assign(new Error("Action 不存在"), { code: "PLUGIN_ACTION_NOT_FOUND" });
    const validated = validateActionInput(action, input);
    const timeoutMs = action.execution === "background" ? 30_000 : 10_000;
    return this.executions.execute({ pluginId, actionId, userId, workspaceId, actionInput: validated, timeoutMs, executionId });
  }

  private publicRecord(record: PluginRegistryRecord): Record<string, unknown> {
    const manifest = manifestOf(record);
    return {
      id: record.id,
      name: record.name,
      description: manifest.description,
      version: record.version,
      apiVersion: record.apiVersion,
      source: record.source,
      trustLevel: record.trustLevel,
      status: record.status,
      checksum: record.checksum,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      lastError: record.lastError,
      author: manifest.author,
      actions: manifest.actions,
      permissions: this.permissions.list(record.id),
    };
  }

  private requireRecord(pluginId: string): PluginRegistryRecord {
    const record = this.registry.get(pluginId);
    if (!record) throw Object.assign(new Error("插件不存在"), { code: "PLUGIN_NOT_FOUND" });
    return record;
  }
}

let singleton: PluginService | null = null;
export function getPluginService(): PluginService {
  if (!singleton) singleton = new PluginService();
  return singleton;
}

export function quarantineRestoredPlugins(): void {
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('plugin_registry','plugin_permissions')").all() as Array<{ name: string }>;
  if (tables.length < 2) return;
  const dataDir = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
  const records = db.prepare("SELECT id,version FROM plugin_registry").all() as Array<{ id: string; version: string }>;
  db.transaction(() => {
    const update = db.prepare("UPDATE plugin_registry SET status='quarantined',source='restore',installedPath=?,lastError='恢复后需要管理员重新确认',updatedAt=? WHERE id=?");
    for (const record of records) {
      const restored = path.join(dataDir, "plugins", "installed", record.id, record.version);
      const quarantined = path.join(dataDir, "plugins", "quarantine", record.id, record.version);
      if (fs.existsSync(restored)) {
        fs.mkdirSync(path.dirname(quarantined), { recursive: true });
        if (fs.existsSync(quarantined)) fs.rmSync(quarantined, { recursive: true, force: true });
        fs.renameSync(restored, quarantined);
      }
      update.run(quarantined, new Date().toISOString(), record.id);
    }
    db.prepare("UPDATE plugin_permissions SET granted=0,grantedBy=NULL,grantedAt=NULL").run();
  })();
}
