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

const ALLOWED_OPERATION_TRANSITIONS: Readonly<Record<PluginUpdateStage, readonly PluginUpdateStage[]>> = Object.freeze({
  downloaded: ["verified", "failed"],
  verified: ["staged", "failed"],
  staged: ["preflight", "rollback_pending", "failed"],
  preflight: ["switching", "rollback_pending", "failed"],
  switching: ["probation", "rollback_pending", "failed"],
  probation: ["stable", "rollback_pending", "failed"],
  rollback_pending: ["rolling_back", "failed"],
  rolling_back: ["rolled_back", "failed"],
  stable: [],
  failed: [],
  rolled_back: [],
});

function now(): string {
  return new Date().toISOString();
}

function lifecycleError(from: PluginLifecycleState, to: PluginLifecycleState): Error {
  return Object.assign(new Error(`插件生命周期不允许从 ${from} 转换到 ${to}`), {
    code: "PLUGIN_LIFECYCLE_INVALID_TRANSITION",
  });
}

function operationTransitionError(from: PluginUpdateStage, to: PluginUpdateStage): Error {
  return Object.assign(new Error(`插件更新阶段不允许从 ${from} 转换到 ${to}`), {
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
  targetChecksum: string | null;
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
      if (operation.stage !== "staged") throw operationTransitionError(operation.stage, "preflight");
      if (!operation.targetChecksum || operation.targetChecksum !== target.checksum) {
        throw Object.assign(new Error("候选插件版本校验和与更新操作不一致"), { code: "PLUGIN_VERSION_COORDINATE_CONFLICT" });
      }
      if (!fs.existsSync(target.installedPath)) {
        throw Object.assign(new Error("候选插件版本文件不存在"), { code: "PLUGIN_VERSION_FILES_MISSING" });
      }
      const timestamp = now();
      const previousStableVersion = record.lifecycleState === "stable" && fs.existsSync(record.installedPath)
        ? record.version
        : null;
      db.prepare(`UPDATE plugin_registry SET
        previousStableVersion=?,activeOperationId=?,stateUpdatedAt=?,updatedAt=?
        WHERE id=?`).run(previousStableVersion, operationId, timestamp, timestamp, pluginId);
      this.transitionOperationInTransaction(operationId, "preflight", timestamp);
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
      if (current.activeOperationId !== operationId || operation.stage !== "preflight") {
        throw operationTransitionError(operation.stage, "switching");
      }
      this.transitionOperationInTransaction(operationId, "switching", now());
    })();
    db.transaction(() => {
      const current = this.requirePlugin(pluginId);
      const operation = this.requireOperation(operationId, pluginId);
      const target = this.requireVersion(pluginId, operation.targetVersion);
      if (current.activeOperationId !== operationId || operation.stage !== "switching") {
        throw operationTransitionError(operation.stage, "probation");
      }
      if (!operation.targetChecksum || operation.targetChecksum !== target.checksum) {
        throw Object.assign(new Error("候选插件版本校验和与更新操作不一致"), { code: "PLUGIN_VERSION_COORDINATE_CONFLICT" });
      }
      if (!fs.existsSync(target.installedPath)) {
        throw Object.assign(new Error("候选插件版本文件不存在"), { code: "PLUGIN_VERSION_FILES_MISSING" });
      }
      const manifest = JSON.parse(target.manifestJson) as PluginManifest;
      const timestamp = now();
      db.prepare(`UPDATE plugin_registry SET
        name=?,version=?,apiVersion=?,runtime=?,main=?,source=?,trustLevel=?,checksum=?,manifestJson=?,installedPath=?,
        previousVersion=?,previousStableVersion=?,publisher=?,signatureState=?,advisoryState='unknown',
        lifecycleState='probation',activeOperationId=?,stateUpdatedAt=?,probationVersion=?,probationRemaining=?,
        nodeRuntimeConfirmedAt=?,nodeRuntimeConfirmedBy=?,autoRollbackReason=NULL,updatedAt=?,lastError=NULL
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
          current.previousStableVersion,
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
      this.transitionOperationInTransaction(operationId, "probation", timestamp);
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
        this.transitionOperationInTransaction(record.activeOperationId, "stable", timestamp);
      }
    })();
  }

  /**
   * 将 preflight/probation 候选回退到 previous stable。只有 previous 不可恢复时才禁用插件。
   */
  rollback(pluginId: string, reason: string, errorCode = "PLUGIN_PROBATION_FAILED"): PluginRegistryRecord {
    const db = getDb();
    const initial = this.requirePlugin(pluginId);
    const operationId = initial.activeOperationId;
    const operation = operationId ? this.requireOperation(operationId, pluginId) : null;
    const candidate = operation ? this.getVersion(pluginId, operation.targetVersion) : undefined;

    if (operation && candidate && initial.version !== candidate.version
      && ["preflight", "switching", "rollback_pending", "rolling_back"].includes(operation.stage)) {
      if (operation.stage === "preflight" || operation.stage === "switching") {
        db.transaction(() => this.transitionOperationInTransaction(operationId!, "rollback_pending", now()))();
      }
      const pending = this.requireOperation(operationId!, pluginId);
      if (pending.stage === "rollback_pending") {
        db.transaction(() => this.transitionOperationInTransaction(operationId!, "rolling_back", now()))();
      }
      db.transaction(() => {
        const current = this.requirePlugin(pluginId);
        const target = this.requireVersion(pluginId, operation.targetVersion);
        const timestamp = now();
        if (current.lifecycleState === "stable" && fs.existsSync(current.installedPath)) {
          db.prepare(`UPDATE plugin_registry SET
            previousStableVersion=NULL,activeOperationId=NULL,stateUpdatedAt=?,updatedAt=?,lastError=NULL
            WHERE id=?`).run(timestamp, timestamp, pluginId);
          if (target.status !== "stable") {
            db.prepare("UPDATE plugin_versions SET status='rolled_back' WHERE pluginId=? AND version=?")
              .run(pluginId, target.version);
          }
          this.transitionOperationInTransaction(operationId!, "rolled_back", timestamp, errorCode, reason);
          return;
        }
        db.prepare(`UPDATE plugin_registry SET
          lifecycleState='disabled',status='disabled',previousStableVersion=NULL,activeOperationId=NULL,
          probationVersion=NULL,probationRemaining=0,autoRollbackReason=?,lastError=?,stateUpdatedAt=?,updatedAt=?
          WHERE id=?`).run(reason.slice(0, 1000), "回滚版本不可用，插件已禁用", timestamp, timestamp, pluginId);
        if (target.status !== "stable") {
          db.prepare("UPDATE plugin_versions SET status='failed' WHERE pluginId=? AND version=?")
            .run(pluginId, target.version);
        }
        this.transitionOperationInTransaction(operationId!, "failed", timestamp, errorCode, reason);
      })();
      return this.requirePlugin(pluginId);
    }

    const beforeRollback = this.requirePlugin(pluginId);
    if (beforeRollback.lifecycleState === "preflight" || beforeRollback.lifecycleState === "probation") {
      db.transaction(() => {
        const current = this.requirePlugin(pluginId);
        const timestamp = now();
        this.transitionInTransaction(pluginId, "rollback_pending", timestamp);
        if (current.activeOperationId) {
          this.transitionOperationInTransaction(current.activeOperationId, "rollback_pending", timestamp);
        }
      })();
    } else if (beforeRollback.lifecycleState !== "rollback_pending" && beforeRollback.lifecycleState !== "rolling_back") {
      throw lifecycleError(beforeRollback.lifecycleState, "rollback_pending");
    }
    const beforeRollingBack = this.requirePlugin(pluginId);
    if (beforeRollingBack.lifecycleState === "rollback_pending") {
      db.transaction(() => {
        const current = this.requirePlugin(pluginId);
        const timestamp = now();
        this.transitionInTransaction(pluginId, "rolling_back", timestamp);
        if (current.activeOperationId) {
          this.transitionOperationInTransaction(current.activeOperationId, "rolling_back", timestamp);
        }
      })();
    }
    db.transaction(() => {
      const current = this.requirePlugin(pluginId);
      const previousVersion = current.previousStableVersion;
      const previous = previousVersion ? this.getVersion(pluginId, previousVersion) : undefined;
      const timestamp = now();
      if (!previous || previous.status !== "stable" || !previous.verifiedAt || !fs.existsSync(previous.installedPath)) {
        this.transitionInTransaction(pluginId, "disabled", timestamp);
        db.prepare(`UPDATE plugin_registry SET
          lifecycleState='disabled',status='disabled',previousStableVersion=NULL,activeOperationId=NULL,
          probationVersion=NULL,probationRemaining=0,autoRollbackReason=?,lastError=?,stateUpdatedAt=?,updatedAt=?
          WHERE id=?`).run(reason.slice(0, 1000), "回滚版本不可用，插件已禁用", timestamp, timestamp, pluginId);
        db.prepare("UPDATE plugin_versions SET status='failed' WHERE pluginId=? AND version=? AND status<>'stable'")
          .run(pluginId, current.version);
        if (current.activeOperationId) {
          this.transitionOperationInTransaction(current.activeOperationId, "failed", timestamp, errorCode, reason);
        }
        return;
      }
      const manifest = JSON.parse(previous.manifestJson) as PluginManifest;
      const currentManifest = JSON.parse(current.manifestJson) as PluginManifest;
      const sameRuntimeBoundary = currentManifest.apiVersion === manifest.apiVersion
        && currentManifest.runtime === manifest.runtime
        && (currentManifest.apiVersion === 2 ? currentManifest.publisher : null)
          === (manifest.apiVersion === 2 ? manifest.publisher : null)
        && current.trustLevel === previous.trustLevel;
      this.transitionInTransaction(pluginId, "stable", timestamp);
      db.prepare(`UPDATE plugin_registry SET
        name=?,version=?,apiVersion=?,runtime=?,main=?,source=?,trustLevel=?,status='enabled',checksum=?,
        manifestJson=?,installedPath=?,previousVersion=?,previousStableVersion=NULL,publisher=?,signatureState=?,
        nodeRuntimeConfirmedAt=?,nodeRuntimeConfirmedBy=?,
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
          sameRuntimeBoundary ? current.nodeRuntimeConfirmedAt : null,
          sameRuntimeBoundary ? current.nodeRuntimeConfirmedBy : null,
          reason.slice(0, 1000),
          timestamp,
          timestamp,
          pluginId,
        );
      db.prepare("UPDATE plugin_versions SET status='rolled_back' WHERE pluginId=? AND version=? AND status<>'stable'")
        .run(pluginId, current.version);
      db.prepare("UPDATE plugin_versions SET status='stable',verifiedAt=COALESCE(verifiedAt,?) WHERE pluginId=? AND version=?")
        .run(timestamp, pluginId, previous.version);
      if (current.activeOperationId) {
        this.transitionOperationInTransaction(current.activeOperationId, "rolled_back", timestamp, errorCode, reason);
      }
    })();
    return this.requirePlugin(pluginId);
  }

  recoverStable(pluginId: string, operationId: string): void {
    const record = this.requirePlugin(pluginId);
    const operation = this.requireOperation(operationId, pluginId);
    if (record.activeOperationId === operationId
      && record.lifecycleState === "probation"
      && record.version === operation.targetVersion
      && fs.existsSync(record.installedPath)) {
      if (operation.stage === "switching") {
        getDb().transaction(() => this.transitionOperationInTransaction(operationId, "probation", now()))();
      }
      return;
    }
    if (record.activeOperationId === operationId) {
      this.rollback(pluginId, "Nowen 启动时恢复未完成的插件更新", "PLUGIN_UPDATE_INTERRUPTED");
      return;
    }
    this.markOperationFailed(operationId, "PLUGIN_UPDATE_INTERRUPTED", "更新在绑定 active operation 前中断");
  }

  markOperationFailed(operationId: string, errorCode: string, message: string): void {
    const db = getDb();
    db.transaction(() => {
      const operation = db.prepare("SELECT * FROM plugin_update_operations WHERE id=?")
        .get(operationId) as UpdateOperationRecord | undefined;
      if (!operation || operation.stage === "failed" || operation.stage === "stable" || operation.stage === "rolled_back") return;
      this.transitionOperationInTransaction(operationId, "failed", now(), errorCode, message);
    })();
  }

  disableAfterRecoveryFailure(pluginId: string, operationId: string, errorCode: string, message: string): void {
    const db = getDb();
    db.transaction(() => {
      const timestamp = now();
      const record = db.prepare("SELECT * FROM plugin_registry WHERE id=?").get(pluginId) as PluginRegistryRecord | undefined;
      if (record) {
        db.prepare(`UPDATE plugin_registry SET
          lifecycleState='disabled',status='disabled',previousStableVersion=NULL,activeOperationId=NULL,
          probationVersion=NULL,probationRemaining=0,autoRollbackReason=?,lastError=?,stateUpdatedAt=?,updatedAt=?
          WHERE id=?`).run(message.slice(0, 1000), "启动恢复失败，插件已禁用", timestamp, timestamp, pluginId);
        db.prepare("UPDATE plugin_versions SET status='failed' WHERE pluginId=? AND version=? AND status<>'stable'")
          .run(pluginId, record.version);
      }
      const operation = db.prepare("SELECT * FROM plugin_update_operations WHERE id=?")
        .get(operationId) as UpdateOperationRecord | undefined;
      if (operation && operation.stage !== "stable" && operation.stage !== "failed" && operation.stage !== "rolled_back") {
        this.transitionOperationInTransaction(operationId, "failed", timestamp, errorCode, message);
      }
    })();
  }

  private transitionInTransaction(pluginId: string, to: PluginLifecycleState, timestamp: string): void {
    const record = this.requirePlugin(pluginId);
    assertPluginLifecycleTransition(record.lifecycleState, to);
    getDb().prepare("UPDATE plugin_registry SET lifecycleState=?,stateUpdatedAt=?,updatedAt=? WHERE id=?")
      .run(to, timestamp, timestamp, pluginId);
  }

  transitionOperation(operationId: string, to: PluginUpdateStage): void {
    getDb().transaction(() => this.transitionOperationInTransaction(operationId, to, now()))();
  }

  private transitionOperationInTransaction(
    operationId: string,
    to: PluginUpdateStage,
    timestamp: string,
    errorCode: string | null = null,
    message: string | null = null,
  ): void {
    const db = getDb();
    const operation = db.prepare("SELECT * FROM plugin_update_operations WHERE id=?")
      .get(operationId) as UpdateOperationRecord | undefined;
    if (!operation) throw Object.assign(new Error("插件更新操作不存在"), { code: "PLUGIN_UPDATE_OPERATION_NOT_FOUND" });
    if (!ALLOWED_OPERATION_TRANSITIONS[operation.stage]?.includes(to)) {
      throw operationTransitionError(operation.stage, to);
    }
    const terminal = to === "stable" || to === "failed" || to === "rolled_back";
    db.prepare(`UPDATE plugin_update_operations SET
      stage=?,errorCode=?,errorMessage=?,stagingPath=CASE WHEN ? THEN NULL ELSE stagingPath END,
      updatedAt=?,completedAt=? WHERE id=?`)
      .run(to, errorCode, message?.slice(0, 2000) || null, terminal ? 1 : 0, timestamp, terminal ? timestamp : null, operationId);
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
