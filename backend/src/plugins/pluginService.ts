import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/schema.js";
import { isSystemAdmin } from "../middleware/acl.js";
import { HostApiBroker } from "./hostApiBroker.js";
import { CommunityRegistry } from "./communityRegistry.js";
import { EcosystemRegistry } from "./ecosystemRegistry.js";
import { compatibilityInputFromRecord, type ExtensionCompatibilityInput } from "./extensionCompatibility.js";
import { ExtensionPolicy } from "./extensionPolicy.js";
import { PluginExecutionManager } from "./executionManager.js";
import { nowenVersionSatisfies, validateActionInput } from "./manifest.js";
import { PluginPackageInstaller } from "./packageInstaller.js";
import { PluginLifecycle } from "./pluginLifecycle.js";
import { PluginPermissions } from "./permissions.js";
import { PluginRegistry } from "./registry.js";
import { PluginSecrets } from "./secrets.js";
import { PluginUpdateCoordinator } from "./pluginUpdateCoordinator.js";
import type { PluginManifest, PluginRegistryRecord } from "./types.js";

function manifestOf(record: PluginRegistryRecord): PluginManifest {
  return JSON.parse(record.manifestJson) as PluginManifest;
}

export class PluginService {
  readonly registry = new PluginRegistry();
  readonly permissions = new PluginPermissions();
  readonly installer = new PluginPackageInstaller(this.registry, this.permissions);
  readonly secrets = new PluginSecrets();
  readonly community = new CommunityRegistry();
  readonly ecosystem = new EcosystemRegistry();
  readonly policy = new ExtensionPolicy();
  readonly broker = new HostApiBroker(this.permissions, this.secrets);
  readonly lifecycle = new PluginLifecycle();
  readonly executions = new PluginExecutionManager(this.broker, this.registry, this.policy, this.lifecycle);
  readonly updates = new PluginUpdateCoordinator(
    this.executions,
    this.registry,
    this.installer,
    this.permissions,
    this.lifecycle,
  );

  constructor() {
    // 开发目录每次服务重启都要重新确认，不能继承上次的 enabled/granted 状态。
    const db = getDb();
    db.prepare("UPDATE plugin_registry SET status='quarantined',lastError='开发插件重启后需要重新确认',updatedAt=? WHERE source='dev'")
      .run(new Date().toISOString());
    db.prepare("UPDATE plugin_permissions SET granted=0,grantedBy=NULL,grantedAt=NULL WHERE pluginId IN (SELECT id FROM plugin_registry WHERE source='dev')").run();
    if (process.env.NODE_ENV !== "test") {
      const timer = setInterval(() => { void this.runAutomaticUpdates().catch(() => undefined); }, 6 * 60 * 60 * 1000);
      timer.unref();
    }
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

  contributions(): Array<Record<string, unknown>> {
    return this.registry.list().flatMap((record) => {
      if (record.status !== "enabled") return [];
      const manifest = manifestOf(record);
      if (manifest.apiVersion !== 2 || !manifest.contributes) return [];
      return [{ pluginId: record.id, publisher: manifest.publisher, ...manifest.contributes }];
    });
  }

  getSettings(pluginId: string, ownerUserId: string): Record<string, unknown> {
    const manifest = manifestOf(this.requireRecord(pluginId));
    if (manifest.apiVersion !== 2) return {};
    const rows = getDb().prepare("SELECT key,valueJson FROM plugin_settings WHERE pluginId=? AND ownerUserId=?").all(pluginId, ownerUserId) as Array<{ key: string; valueJson: string }>;
    const values = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.valueJson)]));
    return Object.fromEntries((manifest.contributes?.settings || []).map((setting) => [setting.key, setting.secret ? this.secrets.list(pluginId, ownerUserId).some((item) => item.name === `setting:${setting.key}`) : values[setting.key] ?? setting.default ?? null]));
  }

  setSettings(pluginId: string, ownerUserId: string, input: Record<string, unknown>): Record<string, unknown> {
    const manifest = manifestOf(this.requireRecord(pluginId));
    const declarations = new Map(manifest.apiVersion === 2 ? (manifest.contributes?.settings || []).map((item) => [item.key, item]) : []);
    const put = getDb().prepare(`INSERT INTO plugin_settings(pluginId,ownerUserId,key,valueJson,updatedAt) VALUES (?,?,?,?,?)
      ON CONFLICT(pluginId,ownerUserId,key) DO UPDATE SET valueJson=excluded.valueJson,updatedAt=excluded.updatedAt`);
    for (const [key, value] of Object.entries(input)) {
      const setting = declarations.get(key); if (!setting) throw new Error(`未声明的插件设置: ${key}`);
      if (setting.secret) { if (typeof value !== "string" || !value) throw new Error(`${key} 必须是非空 secret`); this.secrets.set(pluginId, ownerUserId, `setting:${key}`, value); continue; }
      const actual = Array.isArray(value) ? "array" : typeof value;
      if (actual !== setting.type && !(setting.type === "select" && ["string", "number"].includes(actual))) throw new Error(`${key} 类型无效`);
      if (setting.options && !setting.options.includes(value as never)) throw new Error(`${key} 不在允许选项内`);
      put.run(pluginId, ownerUserId, key, JSON.stringify(value), new Date().toISOString());
    }
    return this.getSettings(pluginId, ownerUserId);
  }

  async installAutomationTemplate(pluginId: string, templateId: string, userId: string): Promise<Record<string, unknown>> {
    const record = this.requireRecord(pluginId); if (record.status !== "enabled") throw new Error("插件未启用");
    const manifest = manifestOf(record); const template = manifest.apiVersion === 2 ? manifest.contributes?.automationTemplates?.find((item) => item.id === templateId) : undefined;
    if (!template) throw new Error("Automation Template 不存在");
    const target = path.resolve(record.installedPath, template.file); const relative = path.relative(record.installedPath, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Automation Template 路径逃逸");
    const raw = JSON.parse(fs.readFileSync(target, "utf8")) as { name?: string; description?: string; definition?: unknown; ignoreSync?: boolean; ignoreBulk?: boolean };
    const { getWorkflowService } = await import("../automation/workflowService.js");
    return getWorkflowService().create(userId, { name: raw.name || template.title, description: raw.description || template.description || "", workspaceId: null, ignoreSync: raw.ignoreSync !== false, ignoreBulk: raw.ignoreBulk !== false, definition: raw.definition });
  }

  async checkUpdates(sourceId: string): Promise<Array<Record<string, unknown>>> {
    const index = await this.ecosystem.index(sourceId); const updates: Array<Record<string, unknown>> = [];
    for (const record of this.registry.list()) {
      const extension = index.extensions.find((item) => item.id === record.id); if (!extension) continue;
      const candidate = [...extension.versions].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
      if (!candidate || candidate.version.localeCompare(record.version, undefined, { numeric: true }) <= 0 || record.pinnedVersion) continue;
      const current = manifestOf(record); const oldPermissions = new Set(current.permissions);
      const added = candidate.permissions.filter((permission) => !oldPermissions.has(permission as any));
      const oldHosts = new Set(current.permissionConfig?.externalFetchHosts || []);
      const addedHosts = (candidate.permissionConfig?.externalFetchHosts || []).filter((host) => !oldHosts.has(host));
      const currentVersion = this.registry.getVersion(record.id, record.version);
      const candidateTrust = extension.trustLevel || "community";
      const currentPublisher = current.apiVersion === 2 ? current.publisher : null;
      const confirmationRequired = added.length > 0
        || addedHosts.length > 0
        || current.apiVersion !== candidate.apiVersion
        || current.runtime !== candidate.runtime
        || currentPublisher !== extension.publisher
        || record.trustLevel !== candidateTrust
        || Boolean(currentVersion?.publisherKeyId && currentVersion.publisherKeyId !== candidate.publisherKeyId);
      getDb().prepare(`INSERT INTO plugin_update_state(pluginId,availableVersion,permissionDiffJson,checkedAt) VALUES (?,?,?,?)
        ON CONFLICT(pluginId) DO UPDATE SET availableVersion=excluded.availableVersion,permissionDiffJson=excluded.permissionDiffJson,checkedAt=excluded.checkedAt,lastError=NULL`)
        .run(record.id, candidate.version, JSON.stringify({ added, addedHosts }), new Date().toISOString());
      updates.push({ pluginId: record.id, currentVersion: record.version, availableVersion: candidate.version, permissionDiff: { added, addedHosts }, confirmationRequired });
    }
    return updates;
  }

  async applyUpdate(sourceId: string, pluginId: string, version: string | undefined, actor: string, confirmed = false): Promise<Record<string, unknown>> {
    const available = await this.checkUpdates(sourceId);
    const update = available.find((item: any) => item.pluginId === pluginId && (!version || item.availableVersion === version)) as any;
    if (!update) throw Object.assign(new Error("没有可用更新，或版本已固定"), { code: "PLUGIN_UPDATE_NOT_AVAILABLE" });
    if (update.confirmationRequired && !confirmed) throw Object.assign(new Error("更新扩大了权限或兼容边界，需要管理员确认"), { code: "PLUGIN_UPDATE_CONFIRMATION_REQUIRED" });
    return this.installFromEcosystem(sourceId, pluginId, update.availableVersion, actor);
  }

  private async runAutomaticUpdates(): Promise<void> {
    for (const source of this.ecosystem.listSources().filter((item) => item.enabled)) {
      const updates = await this.checkUpdates(source.id).catch(() => []);
      for (const update of updates as any[]) {
        const record = this.registry.get(update.pluginId);
        if (record?.updatePolicy === "automatic" && !update.confirmationRequired) await this.applyUpdate(source.id, update.pluginId, update.availableVersion, "system", false).catch(() => undefined);
      }
    }
  }

  setUpdatePolicy(pluginId: string, policy: "manual" | "notify" | "automatic", pinnedVersion?: string | null): Record<string, unknown> {
    this.requireRecord(pluginId);
    getDb().prepare("UPDATE plugin_registry SET updatePolicy=?,pinnedVersion=?,updatedAt=? WHERE id=?").run(policy, pinnedVersion || null, new Date().toISOString(), pluginId);
    return this.get(pluginId);
  }

  async install(bytes: Buffer, installedBy: string, confirmNodeRuntime = false): Promise<Record<string, unknown>> {
    const candidate = await this.installer.inspect(bytes);
    const existing = this.registry.get(candidate.manifest.id);
    const inheritedConfirmation = existing
      ? this.canInheritNodeRuntimeConfirmation(existing, candidate.manifest, "community")
      : false;
    const confirmedBy = this.nodeRuntimeConfirmationActor(candidate.manifest, installedBy, confirmNodeRuntime);
    this.policy.assertAllowed(this.candidateCompatibility(
      candidate.manifest,
      "package",
      "community",
      "unsigned",
      Boolean(confirmedBy || inheritedConfirmation),
    ));
    return this.publicRecord(await this.updates.installUpdate(candidate, installedBy, {
      nodeRuntimeConfirmedBy: confirmedBy,
    }));
  }

  async loadDevelopmentDirectory(
    directory: string,
    installedBy: string,
    confirmNodeRuntime = false,
  ): Promise<Record<string, unknown>> {
    if (!this.isDeveloperModeAvailable()) throw new Error("当前部署形态不支持本地开发插件");
    if (!this.isDeveloperModeEnabled()) throw new Error("请先启用插件开发者模式");
    const validated = await this.installer.inspectDevelopmentDirectory(directory);
    const existing = this.registry.get(validated.manifest.id);
    if (existing) {
      throw Object.assign(new Error("开发插件 ID 已存在，请先卸载后重新加载"), { code: "PLUGIN_DEV_RELOAD_REQUIRES_UNINSTALL" });
    }
    const confirmedBy = this.nodeRuntimeConfirmationActor(validated.manifest, installedBy, confirmNodeRuntime);
    this.policy.assertAllowed(this.candidateCompatibility(
      validated.manifest,
      "dev",
      "developer",
      "unsigned",
      Boolean(confirmedBy),
    ));
    const record = this.installer.loadDevelopmentDirectory(validated, installedBy, confirmedBy);
    return this.publicRecord(record);
  }

  async installFromRegistry(sourceId: string, pluginId: string, version: string | undefined, installedBy: string): Promise<Record<string, unknown>> {
    const artifact = await this.community.download(sourceId, pluginId, version);
    const validated = await this.installer.inspect(artifact.bytes);
    const trust = artifact.plugin.trustLevel || "community";
    this.policy.assertAllowed(this.candidateCompatibility(validated.manifest, "registry", trust, "unsigned", false));
    if (validated.manifest.id !== artifact.plugin.id || validated.manifest.version !== artifact.version.version) {
      throw Object.assign(new Error("Registry 元数据与插件 Manifest 不一致"), { code: "REGISTRY_MANIFEST_MISMATCH" });
    }
    return this.publicRecord(await this.updates.installUpdate(validated, installedBy, {
      source: "registry",
      trustLevel: trust,
      signatureState: "unsigned",
    }));
  }

  async installFromEcosystem(sourceId: string, pluginId: string, version: string | undefined, installedBy: string): Promise<Record<string, unknown>> {
    const artifact = await this.ecosystem.download(sourceId, pluginId, version);
    const validated = await this.installer.inspect(artifact.bytes);
    if (validated.manifest.apiVersion !== 2 || validated.manifest.id !== artifact.extension.id || validated.manifest.publisher !== artifact.extension.publisher || validated.manifest.version !== artifact.version.version) {
      throw Object.assign(new Error("签名元数据与 V2 Manifest 不一致"), { code: "REGISTRY_MANIFEST_MISMATCH" });
    }
    const trust = artifact.extension.trustLevel || "community";
    this.policy.assertAllowed(this.candidateCompatibility(validated.manifest, "registry", trust, "verified", false));
    const existing = this.registry.get(pluginId);
    if (existing && validated.manifest.version.localeCompare(existing.version, undefined, { numeric: true }) < 0) throw Object.assign(new Error("Registry 安装拒绝降级；请使用已验证版本回滚"), { code: "PLUGIN_DOWNGRADE_DENIED" });
    return this.publicRecord(await this.updates.installUpdate(validated, installedBy, {
      source: "registry", trustLevel: trust, publisherKeyId: artifact.version.publisherKeyId,
      signature: artifact.version.signature, signatureState: "verified", artifactUrl: artifact.version.artifactUrl,
    }));
  }

  connections(pluginId: string, userId: string): Array<Record<string, unknown>> {
    const manifest = manifestOf(this.requireRecord(pluginId));
    const configured = new Set(this.secrets.list(pluginId, userId).map((item) => item.name));
    return (manifest.connections || []).map((connection) => ({ ...connection, configured: configured.has(connection.id) }));
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
    if (record.activeOperationId && record.lifecycleState !== "probation") {
      throw Object.assign(new Error("插件正在更新，暂时不能启用"), { code: "PLUGIN_UPDATE_IN_PROGRESS" });
    }
    const manifest = manifestOf(record);
    this.assertDependencies(record.id, manifest);
    this.policy.assertAllowed(compatibilityInputFromRecord(record));
    if (!this.permissions.allDeclaredGranted(pluginId)) throw new Error("必须先确认并授予插件声明的全部权限");
    if (!fs.existsSync(record.installedPath)) throw new Error("插件目录不存在");
    record = this.installer.moveToInstalled(record);
    await this.executions.restart(pluginId);
    try {
      if (record.lifecycleState === "probation") {
        await this.executions.preflight(pluginId);
        this.registry.setStatus(pluginId, "enabled");
        return this.get(pluginId);
      }
      if (record.lifecycleState === "installed") this.lifecycle.beginInstalledPreflight(pluginId);
      await this.executions.preflight(pluginId);
      const afterPreflight = this.registry.get(pluginId)!;
      if (afterPreflight.lifecycleState === "preflight") {
        this.lifecycle.activateInstalled(pluginId);
      } else {
        this.registry.setStatus(pluginId, "enabled");
        this.registry.markCurrentVersion(pluginId, "stable", true);
      }
      return this.get(pluginId);
    } catch (error) {
      const coded = error as Error & { code?: string };
      const failed = this.registry.get(pluginId);
      if (failed?.lifecycleState === "preflight" || failed?.lifecycleState === "probation") {
        this.executions.suspendForUpdate(pluginId);
        try {
          this.lifecycle.rollback(pluginId, coded.message, coded.code || "PLUGIN_PREFLIGHT_FAILED");
          await this.executions.restart(pluginId);
        } finally {
          this.executions.resumeAfterUpdate(pluginId);
        }
      } else {
        this.registry.setStatus(pluginId, "error", coded.message);
        if (failed?.lifecycleState !== "stable") this.registry.markCurrentVersion(pluginId, "error", false);
      }
      throw Object.assign(coded, { code: coded.code || "PLUGIN_PREFLIGHT_FAILED" });
    }
  }

  private assertDependencies(pluginId: string, manifest: PluginManifest): void {
    if (manifest.apiVersion !== 2 || !manifest.extensionDependencies) return;
    const graph = new Map<string, string[]>();
    for (const item of this.registry.list()) { const candidate = manifestOf(item); graph.set(item.id, candidate.apiVersion === 2 ? Object.keys(candidate.extensionDependencies || {}) : []); }
    graph.set(pluginId, Object.keys(manifest.extensionDependencies));
    const visit = (id: string, stack: Set<string>, seen: Set<string>) => { if (stack.has(id)) throw Object.assign(new Error("Extension dependency 存在循环"), { code: "PLUGIN_DEPENDENCY_CYCLE" }); if (seen.has(id)) return; stack.add(id); for (const next of graph.get(id) || []) visit(next, stack, seen); stack.delete(id); seen.add(id); };
    visit(pluginId, new Set(), new Set());
    for (const [dependencyId, range] of Object.entries(manifest.extensionDependencies)) {
      const dependency = this.registry.get(dependencyId);
      if (!dependency || dependency.status !== "enabled" || !nowenVersionSatisfies(range, dependency.version)) throw Object.assign(new Error(`Extension dependency 不可用: ${dependencyId}@${range}`), { code: "PLUGIN_DEPENDENCY_MISSING" });
    }
  }

  async disable(pluginId: string): Promise<Record<string, unknown>> {
    const record = this.requireRecord(pluginId);
    if (record.activeOperationId && record.lifecycleState !== "probation") {
      throw Object.assign(new Error("插件正在更新，暂时不能禁用"), { code: "PLUGIN_UPDATE_IN_PROGRESS" });
    }
    this.registry.setStatus(pluginId, "disabled");
    await this.executions.shutdown(pluginId);
    return this.get(pluginId);
  }

  async reload(pluginId: string): Promise<Record<string, unknown>> {
    const record = this.requireRecord(pluginId);
    if (record.status !== "enabled") throw new Error("只有已启用插件可以重新加载");
    if (record.activeOperationId) throw Object.assign(new Error("插件正在更新，暂时不能重新加载"), { code: "PLUGIN_UPDATE_IN_PROGRESS" });
    await this.executions.restart(pluginId);
    await this.executions.preflight(pluginId);
    return this.get(pluginId);
  }

  async uninstall(pluginId: string): Promise<void> {
    const record = this.requireRecord(pluginId);
    await this.executions.shutdown(pluginId);
    this.installer.removeFiles(record);
    this.registry.remove(pluginId);
  }

  listVersions(pluginId: string): Array<Record<string, unknown>> {
    this.requireRecord(pluginId);
    return this.registry.listVersions(pluginId).map((version) => ({
      version: version.version,
      checksum: version.checksum,
      source: version.source,
      trustLevel: version.trustLevel,
      status: version.status,
      installedAt: version.installedAt,
      verifiedAt: version.verifiedAt,
    }));
  }

  async rollback(pluginId: string, requestedVersion?: string): Promise<Record<string, unknown>> {
    const current = this.requireRecord(pluginId);
    const targetVersion = requestedVersion || current.previousVersion;
    if (!targetVersion || targetVersion === current.version) throw Object.assign(new Error("没有可回滚版本"), { code: "PLUGIN_VERSION_NOT_FOUND" });
    return this.publicRecord(await this.updates.activateExistingVersion(pluginId, targetVersion, "manual-rollback"));
  }

  async execute(
    pluginId: string,
    actionId: string,
    userId: string,
    workspaceId: string | null,
    input: unknown,
    executionId?: string,
    executionContext?: { source?: "user" | "plugin" | "workflow" | "sync" | "system"; sourceId?: string; correlationId?: string; causationId?: string; depth?: number; idempotencyKey?: string },
  ) {
    const record = this.requireRecord(pluginId);
    if (record.status !== "enabled") throw Object.assign(new Error(`插件当前状态为 ${record.status}`), { code: "PLUGIN_NOT_ENABLED" });
    const manifest = manifestOf(record);
    const action = manifest.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw Object.assign(new Error("Action 不存在"), { code: "PLUGIN_ACTION_NOT_FOUND" });
    const validated = validateActionInput(action, input);
    const timeoutMs = action.execution === "background" ? 30_000 : 10_000;
    return this.executions.execute({ pluginId, actionId, userId, workspaceId, actionInput: validated, timeoutMs, executionId, executionContext });
  }

  private publicRecord(record: PluginRegistryRecord): Record<string, unknown> {
    const manifest = manifestOf(record);
    const compatibility = this.policy.resolve(compatibilityInputFromRecord(record));
    const previous = record.previousVersion ? this.registry.getVersion(record.id, record.previousVersion) : undefined;
    const previousManifest = previous ? JSON.parse(previous.manifestJson) as PluginManifest : undefined;
    const previousPermissions = new Set(previousManifest?.permissions || []);
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
      previousVersion: record.previousVersion,
      previousStableVersion: record.previousStableVersion || null,
      lifecycleState: record.lifecycleState,
      activeOperationId: record.activeOperationId || null,
      stateUpdatedAt: record.stateUpdatedAt,
      versions: this.listVersions(record.id),
      permissionDiff: previousManifest ? {
        added: manifest.permissions.filter((permission) => !previousPermissions.has(permission)),
        removed: previousManifest.permissions.filter((permission) => !manifest.permissions.includes(permission)),
      } : { added: [], removed: [] },
      author: manifest.apiVersion === 1 ? manifest.author : { name: manifest.publisher },
      publisher: manifest.apiVersion === 2 ? manifest.publisher : null,
      category: manifest.apiVersion === 1 ? manifest.category : manifest.categories[0],
      categories: manifest.apiVersion === 2 ? manifest.categories : manifest.category ? [manifest.category] : [],
      keywords: manifest.keywords || [],
      repository: manifest.repository,
      homepage: manifest.homepage,
      license: manifest.license,
      icon: manifest.icon,
      screenshots: manifest.screenshots || [],
      signatureState: record.signatureState || "unsigned",
      advisoryState: record.advisoryState || "unknown",
      nodeRuntimeConfirmedAt: record.nodeRuntimeConfirmedAt || null,
      nodeRuntimeConfirmedBy: record.nodeRuntimeConfirmedBy || null,
      compatibility,
      updatePolicy: record.updatePolicy || "manual",
      pinnedVersion: record.pinnedVersion || null,
      probationRemaining: record.probationRemaining || 0,
      autoRollbackReason: record.autoRollbackReason || null,
      contributes: manifest.apiVersion === 2 ? manifest.contributes || {} : {},
      platforms: manifest.apiVersion === 2 ? manifest.platforms || manifest.runtimePlatform || [] : [],
      connections: manifest.connections || [],
      actions: manifest.actions,
      permissions: this.permissions.list(record.id),
    };
  }

  private requireRecord(pluginId: string): PluginRegistryRecord {
    const record = this.registry.get(pluginId);
    if (!record) throw Object.assign(new Error("插件不存在"), { code: "PLUGIN_NOT_FOUND" });
    return record;
  }

  private candidateCompatibility(
    manifest: PluginManifest,
    source: ExtensionCompatibilityInput["source"],
    trustLevel: ExtensionCompatibilityInput["trustLevel"],
    signatureState: string,
    nodeRuntimeConfirmed: boolean,
  ): ExtensionCompatibilityInput {
    return {
      manifest,
      source,
      trustLevel,
      signatureState,
      advisoryState: "unknown",
      nodeRuntimeConfirmed,
    };
  }

  private nodeRuntimeConfirmationActor(
    manifest: PluginManifest,
    actor: string,
    requested: boolean,
  ): string | null {
    if (!requested || manifest.apiVersion !== 2 || manifest.runtime !== "node-action") return null;
    if (!isSystemAdmin(actor)) {
      throw Object.assign(new Error("仅当前认证管理员可确认 Node Runtime"), { code: "RESOURCE_FORBIDDEN" });
    }
    return actor;
  }

  private canInheritNodeRuntimeConfirmation(
    current: PluginRegistryRecord,
    manifest: PluginManifest,
    trustLevel: ExtensionCompatibilityInput["trustLevel"],
  ): boolean {
    if (!current.nodeRuntimeConfirmedAt || !current.nodeRuntimeConfirmedBy) return false;
    const previous = manifestOf(current);
    return previous.apiVersion === manifest.apiVersion
      && previous.runtime === manifest.runtime
      && (previous.apiVersion === 2 ? previous.publisher : null) === (manifest.apiVersion === 2 ? manifest.publisher : null)
      && current.trustLevel === trustLevel;
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
  const registryColumns = new Set((db.prepare("PRAGMA table_info(plugin_registry)").all() as Array<{ name: string }>).map((column) => column.name));
  const rc1Assignments = [
    registryColumns.has("nodeRuntimeConfirmedAt") ? "nodeRuntimeConfirmedAt=NULL" : null,
    registryColumns.has("nodeRuntimeConfirmedBy") ? "nodeRuntimeConfirmedBy=NULL" : null,
    registryColumns.has("lifecycleState") ? "lifecycleState='installed'" : null,
    registryColumns.has("previousStableVersion") ? "previousStableVersion=NULL" : null,
    registryColumns.has("activeOperationId") ? "activeOperationId=NULL" : null,
    registryColumns.has("stateUpdatedAt") ? "stateUpdatedAt=?" : null,
  ].filter((assignment): assignment is string => Boolean(assignment));
  db.transaction(() => {
    const update = db.prepare(`UPDATE plugin_registry SET status='quarantined',source='restore',signatureState='needs-revalidation',advisoryState='unknown',${rc1Assignments.length ? `${rc1Assignments.join(",")},` : ""}installedPath=?,lastError='恢复后需要重新校验签名、安全公告与权限',updatedAt=? WHERE id=?`);
    for (const record of records) {
      const restored = path.join(dataDir, "plugins", "installed", record.id, record.version);
      const quarantined = path.join(dataDir, "plugins", "quarantine", record.id, record.version);
      if (fs.existsSync(restored)) {
        fs.mkdirSync(path.dirname(quarantined), { recursive: true });
        if (fs.existsSync(quarantined)) fs.rmSync(quarantined, { recursive: true, force: true });
        fs.renameSync(restored, quarantined);
      }
      const timestamp = new Date().toISOString();
      update.run(...(registryColumns.has("stateUpdatedAt") ? [timestamp] : []), quarantined, timestamp, record.id);
    }
    db.prepare("UPDATE plugin_permissions SET granted=0,grantedBy=NULL,grantedAt=NULL").run();
    const hasVersions = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='plugin_versions'").get();
    if (hasVersions) db.prepare("UPDATE plugin_versions SET status='quarantined',verifiedAt=NULL").run();
  })();
}
