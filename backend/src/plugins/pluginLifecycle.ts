import fs from "node:fs";
import { getDb } from "../db/schema.js";
import type { PluginLifecycleState, PluginManifest, PluginRegistryRecord, PluginUpdateStage, PluginVersionRecord } from "./types.js";

const ALLOWED_TRANSITIONS: Readonly<Record<PluginLifecycleState, readonly PluginLifecycleState[]>> = Object.freeze({
  installed: ["preflight"],
  preflight: ["probation", "rollback_pending"],
  probation: ["stable", "rollback_pending"],
  stable: [],
  rollback_pending: ["rolling_back"],
  rolling_back: ["stable", "disabled"],
  disabled: [],
});

function now(): string {
  return new Date().toISOString();
}

function lifecycleError(from: PluginLifecycleState, to: PluginLifecycleState): Error {
  return Object.assign(new Error(`插件生命周期不允许从 ${from} 转换到 ${to}`), {
    code: "PLUGIN_LIFECYCLE_INVALID_TRANSITION",
  });
}

export function assertPluginLifecycleTransition(from: PluginLifecycleState, to: PluginLifecycleState): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) throw lifecycleError(from, to);
}

interface UpdateOperationRecord {
  id: string;
  pluginId: string;
  fromVersion: string | null;
  targetVersion: string;
  stage: PluginUpdateStage;
}

export class PluginLifecycle {
  /**
   * 为一个新候选版本建立独立生命周期。此时当前版本仍未切换，旧 stable 版本继续作为回滚基线。
   */
  beginPreflight(pluginId: string, operationId: string): void {
    const db = getDb();
    db.transaction(() => {
      const record = this.requirePlugin(pluginId);
      const operation = this.requireOperation(operationId, pluginId);
      const target = this.requireVersion(pluginId, operation.targetVersion);
      if (operation.stage !== "staged" || target.status !== "installed") {
        throw lifecycleError("installed", "preflight");
      }
      assertPluginLifecycleTransition("installed", "preflight");
      const timestamp = now();
      const previousStableVersion = record.lifecycleState === "stable" && fs.existsSync(record.installedPath)
        ? record.version
        : null;
      db.prepare(`UPDATE plugin_registry SET
        previousStableVersion=?,activeOperationId=?,stateUpdatedAt=?,updatedAt=?
        WHERE id=?`).run(previousStableVersion, operationId, timestamp, timestamp, pluginId);
      db.prepare("UPDATE plugin_versions SET status='preflight' WHERE pluginId=? AND version=?")
        .run(pluginId, target.version);
    })();
  }

  /** preflight 已通过后，在一个事务内切换当前版本并进入 probation。 */
  activateCandidate(
    pluginId: string,
    operationId: string,
    probationExecutions = 5,
    runtimeConfirmation: { confirmedAt?: string | null; confirmedBy?: string | null } = {},
  ): PluginRegistryRecord {
    const db = getDb();
    db.transaction(() => {
      const current = this.requirePlugin(pluginId);
      const operation = this.requireOperation(operationId, pluginId);
      const target = this.requireVersion(pluginId, operation.targetVersion);
      if (current.activeOperationId !== operationId || operation.stage !== "staged" || target.status !== "preflight") {
        throw lifecycleError("preflight", "probation");
      }
      db.prepare("UPDATE plugin_update_operations SET stage='switching',updatedAt=? WHERE id=?")
        .run(now(), operationId);
    })();
    db.transaction(() => {
      const current = this.requirePlugin(pluginId);
      const operation = this.requireOperation(operationId, pluginId);
      const target = this.requireVersion(pluginId, operation.targetVersion);
      if (current.activeOperationId !== operationId || operation.stage !== "switching" || target.status !== "preflight") {
        throw lifecycleError("preflight", "probation");
      }
      assertPluginLifecycleTransition("preflight", "probation");
      if (!fs.existsSync(target.installedPath)) {
        throw Object.assign(new Error("候选插件版本文件不存在"), { code: "PLUGIN_VERSION_FILES_MISSING" });
      }
      const manifest = JSON.parse(target.manifestJson) as PluginManifest;
      const timestamp = now();
      db.prepare(`UPDATE plugin_registry SET
        name=?,version=?,apiVersion=?,runtime=?,main=?,source=?,trustLevel=?,checksum=?,manifestJson=?,installedPath=?,
        previousVersion=?,previousStableVersion=?,publisher=?,signatureState=?,advisoryState='unknown',
        lifecycleState='probation',activeOperationId=?,stateUpdatedAt=?,probationVersion=?,probationRemaining=?,
        nodeRuntimeConfirmedAt=COALESCE(?,nodeRuntimeConfirmedAt),
        nodeRuntimeConfirmedBy=COALESCE(?,nodeRuntimeConfirmedBy),autoRollbackReason=NULL,updatedAt=?,lastError=NULL
        WHERE id=?`).run(
          manifest.name,
          manifest.version,
          manifest.apiVersion,
          manifest.runtime,
          manifest.main,
          target.source,
          target.trustLevel,
          target.checksum,
          target.manifestJson,
          target.installedPath,
          current.version,
          current.version,
          manifest.apiVersion === 2 ? manifest.publisher : null,
          target.signatureState || "unsigned",
          operationId,
          timestamp,
          target.version,
          Math.max(1, probationExecutions),
          runtimeConfirmation.confirmedAt || null,
          runtimeConfirmation.confirmedBy || null,
          timestamp,
          pluginId,
        );
      db.prepare("UPDATE plugin_update_operations SET stage='probation',updatedAt=? WHERE id=?")
        .run(timestamp, operationId);
      db.prepare("UPDATE plugin_versions SET status='probation' WHERE pluginId=? AND version=?")
        .run(pluginId, target.version);
    })();
    return this.requirePlugin(pluginId);
  }

  /** 普通启用也走 installed -> preflight -> probation；没有更新 operation 时只更新注册表。 */
  beginInstalledPreflight(pluginId: string): void {
    const db = getDb();
    db.transaction(() => {
      const record = this.requirePlugin(pluginId);
      if (record.lifecycleState !== "installed") throw lifecycleError(record.lifecycleState, "preflight");
      this.transitionInTransaction(pluginId, "preflight", now());
    })();
  }

  activateInstalled(pluginId: string, probationExecutions = 5): void {
    const db = getDb();
    db.transaction(() => {
      const record = this.requirePlugin(pluginId);
      assertPluginLifecycleTransition(record.lifecycleState, "probation");
      const timestamp = now();
      db.prepare(`UPDATE plugin_registry SET
        lifecycleState='probation',status='enabled',probationVersion=version,probationRemaining=?,
        stateUpdatedAt=?,updatedAt=?,lastError=NULL
        WHERE id=?`).run(Math.max(1, probationExecutions), timestamp, timestamp, pluginId);
      db.prepare("UPDATE plugin_versions SET status='probation',verifiedAt=? WHERE pluginId=? AND version=?")
        .run(timestamp, pluginId, record.version);
    })();
  }

  completeProbationExecution(pluginId: string): void {
    const db = getDb();
    db.transaction(() => {
      const record = this.requirePlugin(pluginId);
      if (record.lifecycleState !== "probation" || record.probationVersion !== record.version) return;
      const remaining = Math.max(0, (record.probationRemaining || 0) - 1);
      const timestamp = now();
      if (remaining > 0) {
        db.prepare("UPDATE plugin_registry SET probationRemaining=?,updatedAt=? WHERE id=?")
          .run(remaining, timestamp, pluginId);
        return;
      }
      assertPluginLifecycleTransition("probation", "stable");
      db.prepare(`UPDATE plugin_registry SET
        lifecycleState='stable',previousStableVersion=NULL,activeOperationId=NULL,
        probationVersion=NULL,probationRemaining=0,stateUpdatedAt=?,updatedAt=?,lastError=NULL
        WHERE id=?`).run(timestamp, timestamp, pluginId);
      db.prepare("UPDATE plugin_versions SET status='stable',verifiedAt=? WHERE pluginId=? AND version=?")
        .run(timestamp, pluginId, record.version);
      if (record.activeOperationId) {
        db.prepare("UPDATE plugin_update_operations SET stage='stable',updatedAt=?,completedAt=? WHERE id=?")
          .run(timestamp, timestamp, record.activeOperationId);
      }
    })();
  }

  stabilizeWithoutProbation(pluginId: string): void {
    const db = getDb();
    db.transaction(() => {
      const record = this.requirePlugin(pluginId);
      if (record.lifecycleState !== "probation") throw lifecycleError(record.lifecycleState, "stable");
      assertPluginLifecycleTransition("probation", "stable");
      const timestamp = now();
      db.prepare(`UPDATE plugin_registry SET
        lifecycleState='stable',previousStableVersion=NULL,activeOperationId=NULL,
        probationVersion=NULL,probationRemaining=0,stateUpdatedAt=?,updatedAt=?,lastError=NULL
        WHERE id=?`).run(timestamp, timestamp, pluginId);
      db.prepare("UPDATE plugin_versions SET status='stable',verifiedAt=? WHERE pluginId=? AND version=?")
        .run(timestamp, pluginId, record.version);
      if (record.activeOperationId) {
        db.prepare("UPDATE plugin_update_operations SET stage='stable',updatedAt=?,completedAt=? WHERE id=?")
          .run(timestamp, timestamp, record.activeOperationId);
      }
    })();
  }

  /**
   * 将 preflight/probation 候选回退到 previous stable。只有 previous 不可恢复时才禁用插件。
   */
  rollback(pluginId: string, reason: string, errorCode = "PLUGIN_PROBATION_FAILED"): PluginRegistryRecord {
    const db = getDb();
    db.transaction(() => {
      const current = this.requirePlugin(pluginId);
      const operationId = current.activeOperationId;
      const operation = operationId ? this.requireOperation(operationId, pluginId) : null;
      const candidate = operation ? this.getVersion(pluginId, operation.targetVersion) : undefined;
      if (candidate?.status === "preflight" && current.version !== candidate.version) {
        assertPluginLifecycleTransition("preflight", "rollback_pending");
        db.prepare("UPDATE plugin_versions SET status='rollback_pending' WHERE pluginId=? AND version=?")
          .run(pluginId, candidate.version);
        assertPluginLifecycleTransition("rollback_pending", "rolling_back");
        db.prepare("UPDATE plugin_versions SET status='rolling_back' WHERE pluginId=? AND version=?")
          .run(pluginId, candidate.version);
        const timestamp = now();
        if (current.lifecycleState === "stable" && fs.existsSync(current.installedPath)) {
          assertPluginLifecycleTransition("rolling_back", "stable");
          db.prepare(`UPDATE plugin_registry SET
            previousStableVersion=NULL,activeOperationId=NULL,stateUpdatedAt=?,updatedAt=?,lastError=NULL
            WHERE id=?`).run(timestamp, timestamp, pluginId);
          db.prepare("UPDATE plugin_versions SET status='rolled_back' WHERE pluginId=? AND version=?")
            .run(pluginId, candidate.version);
          this.finishOperation(operationId!, "rolled_back", timestamp, errorCode, reason);
          return;
        }
        assertPluginLifecycleTransition("rolling_back", "disabled");
        db.prepare(`UPDATE plugin_registry SET
          lifecycleState='disabled',status='disabled',previousStableVersion=NULL,activeOperationId=NULL,
          probationVersion=NULL,probationRemaining=0,autoRollbackReason=?,lastError=?,stateUpdatedAt=?,updatedAt=?
          WHERE id=?`).run(reason.slice(0, 1000), "回滚版本不可用，插件已禁用", timestamp, timestamp, pluginId);
        db.prepare("UPDATE plugin_versions SET status='failed' WHERE pluginId=? AND version=?")
          .run(pluginId, candidate.version);
        this.finishOperation(operationId!, "failed", timestamp, errorCode, reason);
        return;
      }
      if (current.lifecycleState !== "preflight" && current.lifecycleState !== "probation") {
        throw lifecycleError(current.lifecycleState, "rollback_pending");
      }
      const timestamp = now();
      this.transitionInTransaction(pluginId, "rollback_pending", timestamp);
      this.transitionInTransaction(pluginId, "rolling_back", timestamp);
      const rollingBack = this.requirePlugin(pluginId);
      const previousVersion = rollingBack.previousStableVersion || rollingBack.previousVersion;
      const previous = previousVersion ? this.getVersion(pluginId, previousVersion) : undefined;
      const rollingBackOperationId = rollingBack.activeOperationId;
      if (!previous || !fs.existsSync(previous.installedPath)) {
        assertPluginLifecycleTransition("rolling_back", "disabled");
        db.prepare(`UPDATE plugin_registry SET
          lifecycleState='disabled',status='disabled',activeOperationId=NULL,probationVersion=NULL,
          probationRemaining=0,autoRollbackReason=?,lastError=?,stateUpdatedAt=?,updatedAt=?
          WHERE id=?`).run(reason.slice(0, 1000), "回滚版本不可用，插件已禁用", timestamp, timestamp, pluginId);
        if (rollingBackOperationId) this.finishOperation(rollingBackOperationId, "failed", timestamp, errorCode, reason);
        return;
      }
      const manifest = JSON.parse(previous.manifestJson) as PluginManifest;
      assertPluginLifecycleTransition("rolling_back", "stable");
      db.prepare(`UPDATE plugin_registry SET
        name=?,version=?,apiVersion=?,runtime=?,main=?,source=?,trustLevel=?,status='enabled',checksum=?,
        manifestJson=?,installedPath=?,previousVersion=?,previousStableVersion=NULL,publisher=?,signatureState=?,
        lifecycleState='stable',activeOperationId=NULL,probationVersion=NULL,probationRemaining=0,
        autoRollbackReason=?,lastError=NULL,stateUpdatedAt=?,updatedAt=?
        WHERE id=?`).run(
          manifest.name,
          manifest.version,
          manifest.apiVersion,
          manifest.runtime,
          manifest.main,
          previous.source,
          previous.trustLevel,
          previous.checksum,
          previous.manifestJson,
          previous.installedPath,
          current.version === previous.version ? current.previousVersion : current.version,
          manifest.apiVersion === 2 ? manifest.publisher : null,
          previous.signatureState || "unsigned",
          reason.slice(0, 1000),
          timestamp,
          timestamp,
          pluginId,
        );
      db.prepare("UPDATE plugin_versions SET status='stable',verifiedAt=COALESCE(verifiedAt,?) WHERE pluginId=? AND version=?")
        .run(timestamp, pluginId, previous.version);
      if (rollingBackOperationId) this.finishOperation(rollingBackOperationId, "rolled_back", timestamp, errorCode, reason);
    })();
    return this.requirePlugin(pluginId);
  }

  recoverStable(pluginId: string, operationId: string): void {
    const db = getDb();
    db.transaction(() => {
      const record = this.requirePlugin(pluginId);
      const timestamp = now();
      if (record.activeOperationId === operationId) {
        this.rollback(pluginId, "Nowen 启动时恢复未完成的插件更新", "PLUGIN_UPDATE_INTERRUPTED");
        return;
      }
      db.prepare("UPDATE plugin_registry SET activeOperationId=NULL,updatedAt=? WHERE id=? AND activeOperationId=?")
        .run(timestamp, pluginId, operationId);
      this.finishOperation(operationId, "rolled_back", timestamp, "PLUGIN_UPDATE_INTERRUPTED", "更新在切换前中断");
    })();
  }

  markOperationFailed(operationId: string, errorCode: string, message: string): void {
    const timestamp = now();
    this.finishOperation(operationId, "failed", timestamp, errorCode, message);
  }

  private transitionInTransaction(pluginId: string, to: PluginLifecycleState, timestamp: string): void {
    const record = this.requirePlugin(pluginId);
    assertPluginLifecycleTransition(record.lifecycleState, to);
    getDb().prepare("UPDATE plugin_registry SET lifecycleState=?,stateUpdatedAt=?,updatedAt=? WHERE id=?")
      .run(to, timestamp, timestamp, pluginId);
  }

  private finishOperation(operationId: string, stage: "failed" | "rolled_back", timestamp: string, errorCode: string, message: string): void {
    getDb().prepare(`UPDATE plugin_update_operations SET
      stage=?,errorCode=?,errorMessage=?,updatedAt=?,completedAt=? WHERE id=?`)
      .run(stage, errorCode, message.slice(0, 2000), timestamp, timestamp, operationId);
  }

  private requirePlugin(pluginId: string): PluginRegistryRecord {
    const record = getDb().prepare("SELECT * FROM plugin_registry WHERE id=?").get(pluginId) as PluginRegistryRecord | undefined;
    if (!record) throw Object.assign(new Error("插件不存在"), { code: "PLUGIN_NOT_FOUND" });
    return record;
  }

  private requireOperation(operationId: string, pluginId: string): UpdateOperationRecord {
    const operation = getDb().prepare("SELECT * FROM plugin_update_operations WHERE id=? AND pluginId=?")
      .get(operationId, pluginId) as UpdateOperationRecord | undefined;
    if (!operation) throw Object.assign(new Error("插件更新操作不存在"), { code: "PLUGIN_UPDATE_OPERATION_NOT_FOUND" });
    return operation;
  }

  private getVersion(pluginId: string, version: string): PluginVersionRecord | undefined {
    return getDb().prepare("SELECT * FROM plugin_versions WHERE pluginId=? AND version=?")
      .get(pluginId, version) as PluginVersionRecord | undefined;
  }

  private requireVersion(pluginId: string, version: string): PluginVersionRecord {
    const record = this.getVersion(pluginId, version);
    if (!record) throw Object.assign(new Error("插件版本不存在"), { code: "PLUGIN_VERSION_NOT_FOUND" });
    return record;
  }
}
