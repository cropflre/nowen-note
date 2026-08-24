import crypto from "node:crypto";
import fs from "node:fs";
import { getDb } from "../db/schema.js";
import type { ValidatedPluginPackage } from "./packageValidator.js";
import { PluginPackageInstaller } from "./packageInstaller.js";
import { PluginLifecycle } from "./pluginLifecycle.js";
import { PluginPermissions } from "./permissions.js";
import { PluginRegistry } from "./registry.js";
import type { PluginExecutionManager } from "./executionManager.js";
import type { PluginRegistryRecord, PluginSource, PluginTrustLevel } from "./types.js";

export interface PluginUpdateProvenance {
  source?: PluginSource;
  trustLevel?: PluginTrustLevel;
  publisherKeyId?: string;
  signature?: string;
  signatureState?: string;
  artifactUrl?: string;
  nodeRuntimeConfirmedBy?: string | null;
}

function timestamp(): string {
  return new Date().toISOString();
}

export class PluginUpdateCoordinator {
  constructor(
    private readonly executions: PluginExecutionManager,
    private readonly registry = new PluginRegistry(),
    private readonly installer = new PluginPackageInstaller(this.registry),
    private readonly permissions = new PluginPermissions(),
    private readonly lifecycle = new PluginLifecycle(),
  ) {}

  async installUpdate(
    validated: ValidatedPluginPackage,
    requestedBy: string,
    provenance: PluginUpdateProvenance = {},
  ): Promise<PluginRegistryRecord> {
    const current = this.registry.get(validated.manifest.id);
    if (!current) return this.installer.installValidated(validated, requestedBy, provenance);
    if (current.version === validated.manifest.version && current.checksum === validated.checksum) return current;

    const operationId = crypto.randomUUID();
    const createdAt = timestamp();
    try {
      getDb().prepare(`INSERT INTO plugin_update_operations
        (id,pluginId,fromVersion,targetVersion,stage,targetChecksum,requestedBy,createdAt,updatedAt)
        VALUES (?,?,?,?,'downloaded',?,?,?,?)`)
        .run(operationId, current.id, current.version, validated.manifest.version, validated.checksum, requestedBy, createdAt, createdAt);
    } catch (error) {
      const coded = error as Error & { code?: string };
      if (coded.message.includes("UNIQUE constraint failed")) {
        throw Object.assign(new Error("该插件已有未完成的更新操作"), { code: "PLUGIN_UPDATE_IN_PROGRESS" });
      }
      throw error;
    }

    let stagingPath: string | null = null;
    try {
      this.setStage(operationId, "verified");
      stagingPath = await this.installer.stageValidated(validated, operationId);
      const installedPath = this.installer.commitStaged(stagingPath, validated.manifest, validated.checksum);
      stagingPath = null;
      getDb().transaction(() => {
        this.registry.registerVersion({
          manifest: validated.manifest,
          checksum: validated.checksum,
          installedPath,
          source: provenance.source || "package",
          trustLevel: provenance.trustLevel || "community",
          status: "installed",
          publisherKeyId: provenance.publisherKeyId,
          signature: provenance.signature,
          signatureState: provenance.signatureState,
          artifactUrl: provenance.artifactUrl,
        });
        getDb().prepare("UPDATE plugin_update_operations SET stage='staged',stagingPath=NULL,updatedAt=? WHERE id=?")
          .run(timestamp(), operationId);
      })();

      this.executions.suspendForUpdate(current.id);
      try {
        await this.executions.shutdown(current.id);
        this.lifecycle.beginPreflight(current.id, operationId);
        const candidate = this.registry.recordForVersion(current.id, validated.manifest.version, {
          nodeRuntimeConfirmedBy: provenance.nodeRuntimeConfirmedBy,
        });
        await this.executions.preflightCandidate(candidate);
        this.permissions.initialize(validated.manifest, { preserveExistingGrants: true });
        const activated = this.lifecycle.activateCandidate(current.id, operationId, 5, {
          confirmedAt: candidate.nodeRuntimeConfirmedAt,
          confirmedBy: candidate.nodeRuntimeConfirmedBy,
        });
        if (current.status !== "enabled") {
          this.lifecycle.stabilizeWithoutProbation(current.id);
          return this.registry.get(current.id)!;
        }
        return activated;
      } finally {
        this.executions.resumeAfterUpdate(current.id);
      }
    } catch (error) {
      if (stagingPath && fs.existsSync(stagingPath)) this.installer.removeStaging(stagingPath);
      const coded = error as Error & { code?: string };
      const record = this.registry.get(current.id);
      if (record?.activeOperationId === operationId) {
        this.lifecycle.rollback(current.id, coded.message, coded.code || "PLUGIN_UPDATE_FAILED");
      } else {
        this.lifecycle.markOperationFailed(operationId, coded.code || "PLUGIN_UPDATE_FAILED", coded.message);
      }
      throw error;
    }
  }

  async activateExistingVersion(pluginId: string, targetVersion: string, requestedBy: string): Promise<PluginRegistryRecord> {
    const current = this.registry.get(pluginId);
    const target = this.registry.getVersion(pluginId, targetVersion);
    if (!current || !target || current.version === target.version) {
      throw Object.assign(new Error("没有可回滚版本"), { code: "PLUGIN_VERSION_NOT_FOUND" });
    }
    if (!fs.existsSync(target.installedPath)) {
      throw Object.assign(new Error("回滚版本文件不存在"), { code: "PLUGIN_VERSION_FILES_MISSING" });
    }
    const operationId = crypto.randomUUID();
    const createdAt = timestamp();
    try {
      getDb().transaction(() => {
        getDb().prepare(`INSERT INTO plugin_update_operations
          (id,pluginId,fromVersion,targetVersion,stage,targetChecksum,requestedBy,createdAt,updatedAt)
          VALUES (?,?,?,?,'staged',?,?,?,?)`)
          .run(operationId, pluginId, current.version, targetVersion, target.checksum, requestedBy, createdAt, createdAt);
        getDb().prepare("UPDATE plugin_versions SET status='installed' WHERE pluginId=? AND version=?")
          .run(pluginId, targetVersion);
      })();
    } catch (error) {
      const coded = error as Error;
      if (coded.message.includes("UNIQUE constraint failed")) {
        throw Object.assign(new Error("该插件已有未完成的更新操作"), { code: "PLUGIN_UPDATE_IN_PROGRESS" });
      }
      throw error;
    }
    try {
      this.executions.suspendForUpdate(pluginId);
      try {
        await this.executions.shutdown(pluginId);
        this.lifecycle.beginPreflight(pluginId, operationId);
        const candidate = this.registry.recordForVersion(pluginId, targetVersion);
        await this.executions.preflightCandidate(candidate);
        this.permissions.initialize(JSON.parse(target.manifestJson), { preserveExistingGrants: true });
        const activated = this.lifecycle.activateCandidate(pluginId, operationId, 5, {
          confirmedAt: candidate.nodeRuntimeConfirmedAt,
          confirmedBy: candidate.nodeRuntimeConfirmedBy,
        });
        if (current.status !== "enabled") {
          this.lifecycle.stabilizeWithoutProbation(pluginId);
          return this.registry.get(pluginId)!;
        }
        return activated;
      } finally {
        this.executions.resumeAfterUpdate(pluginId);
      }
    } catch (error) {
      const coded = error as Error & { code?: string };
      const record = this.registry.get(pluginId);
      if (record?.activeOperationId === operationId) {
        this.lifecycle.rollback(pluginId, coded.message, coded.code || "PLUGIN_ROLLBACK_FAILED");
      } else {
        this.lifecycle.markOperationFailed(operationId, coded.code || "PLUGIN_ROLLBACK_FAILED", coded.message);
      }
      throw error;
    }
  }

  private setStage(operationId: string, stage: "verified"): void {
    getDb().prepare("UPDATE plugin_update_operations SET stage=?,updatedAt=? WHERE id=?")
      .run(stage, timestamp(), operationId);
  }
}
