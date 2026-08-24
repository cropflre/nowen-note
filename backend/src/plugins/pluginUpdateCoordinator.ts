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
    let installedPath: string | null = null;
    let suspended = false;
    try {
      this.lifecycle.transitionOperation(operationId, "verified");
      stagingPath = await this.installer.stageValidated(validated, operationId);
      getDb().prepare("UPDATE plugin_update_operations SET stagingPath=?,updatedAt=? WHERE id=? AND stage='verified'")
        .run(stagingPath, timestamp(), operationId);
      const committedPath = this.installer.commitStaged(stagingPath, validated.manifest, validated.checksum);
      installedPath = committedPath;
      stagingPath = null;
      getDb().transaction(() => {
        this.registry.registerVersion({
          manifest: validated.manifest,
          checksum: validated.checksum,
          installedPath: committedPath,
          source: provenance.source || "package",
          trustLevel: provenance.trustLevel || "community",
          status: "installed",
          publisherKeyId: provenance.publisherKeyId,
          signature: provenance.signature,
          signatureState: provenance.signatureState,
          artifactUrl: provenance.artifactUrl,
        });
        this.lifecycle.transitionOperation(operationId, "staged");
        getDb().prepare("UPDATE plugin_update_operations SET stagingPath=NULL WHERE id=?").run(operationId);
      })();

      this.executions.suspendForUpdate(current.id);
      suspended = true;
      await this.executions.shutdown(current.id);
      this.lifecycle.beginPreflight(current.id, operationId);
      const candidate = this.registry.recordForVersion(current.id, validated.manifest.version, {
        nodeRuntimeConfirmedBy: provenance.nodeRuntimeConfirmedBy,
      });
      await this.executions.preflightCandidate(candidate);
      this.permissions.initialize(validated.manifest, { preserveExistingGrants: true });
      return this.lifecycle.activateCandidate(current.id, operationId, 5, {
        confirmedAt: candidate.nodeRuntimeConfirmedAt,
        confirmedBy: candidate.nodeRuntimeConfirmedBy,
      });
    } catch (error) {
      if (stagingPath && fs.existsSync(stagingPath)) this.installer.removeStaging(stagingPath);
      const coded = error as Error & { code?: string };
      const record = this.registry.get(current.id);
      if (record?.activeOperationId === operationId) {
        this.lifecycle.rollback(current.id, coded.message, coded.code || "PLUGIN_UPDATE_FAILED");
        await this.executions.restart(current.id);
      } else {
        this.lifecycle.markOperationFailed(operationId, coded.code || "PLUGIN_UPDATE_FAILED", coded.message);
      }
      if (installedPath) this.installer.removeUnregisteredVersion(validated.manifest, validated.checksum);
      throw error;
    } finally {
      if (suspended) this.executions.resumeAfterUpdate(current.id);
    }
  }

  async activateExistingVersion(pluginId: string, targetVersion: string, requestedBy: string): Promise<PluginRegistryRecord> {
    const current = this.registry.get(pluginId);
    const target = this.registry.getVersion(pluginId, targetVersion);
    if (!current || !target || current.version === target.version) {
      throw Object.assign(new Error("没有可回滚版本"), { code: "PLUGIN_VERSION_NOT_FOUND" });
    }
    if (target.status !== "stable" || !target.verifiedAt) {
      throw Object.assign(new Error("只能切换到已验证的 stable 历史版本"), { code: "PLUGIN_VERSION_NOT_VERIFIED_STABLE" });
    }
    if (!fs.existsSync(target.installedPath)) {
      throw Object.assign(new Error("回滚版本文件不存在"), { code: "PLUGIN_VERSION_FILES_MISSING" });
    }
    const operationId = crypto.randomUUID();
    const createdAt = timestamp();
    let operationCreated = false;
    try {
      getDb().transaction(() => {
        getDb().prepare(`INSERT INTO plugin_update_operations
          (id,pluginId,fromVersion,targetVersion,stage,targetChecksum,requestedBy,createdAt,updatedAt)
          VALUES (?,?,?,?,'downloaded',?,?,?,?)`)
          .run(operationId, pluginId, current.version, targetVersion, target.checksum, requestedBy, createdAt, createdAt);
      })();
      operationCreated = true;
      this.lifecycle.transitionOperation(operationId, "verified");
      this.lifecycle.transitionOperation(operationId, "staged");
    } catch (error) {
      const coded = error as Error;
      if (coded.message.includes("UNIQUE constraint failed")) {
        throw Object.assign(new Error("该插件已有未完成的更新操作"), { code: "PLUGIN_UPDATE_IN_PROGRESS" });
      }
      if (operationCreated) this.lifecycle.markOperationFailed(operationId, "PLUGIN_ROLLBACK_PREPARE_FAILED", coded.message);
      throw error;
    }
    let suspended = false;
    try {
      this.executions.suspendForUpdate(pluginId);
      suspended = true;
      await this.executions.shutdown(pluginId);
      this.lifecycle.beginPreflight(pluginId, operationId);
      const candidate = this.registry.recordForVersion(pluginId, targetVersion);
      await this.executions.preflightCandidate(candidate);
      this.permissions.initialize(JSON.parse(target.manifestJson), { preserveExistingGrants: true });
      return this.lifecycle.activateCandidate(pluginId, operationId, 5, {
        confirmedAt: candidate.nodeRuntimeConfirmedAt,
        confirmedBy: candidate.nodeRuntimeConfirmedBy,
      });
    } catch (error) {
      const coded = error as Error & { code?: string };
      const record = this.registry.get(pluginId);
      if (record?.activeOperationId === operationId) {
        this.lifecycle.rollback(pluginId, coded.message, coded.code || "PLUGIN_ROLLBACK_FAILED");
        await this.executions.restart(pluginId);
      } else {
        this.lifecycle.markOperationFailed(operationId, coded.code || "PLUGIN_ROLLBACK_FAILED", coded.message);
      }
      throw error;
    } finally {
      if (suspended) this.executions.resumeAfterUpdate(pluginId);
    }
  }
}
