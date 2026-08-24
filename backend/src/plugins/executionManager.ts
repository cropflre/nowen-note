import crypto from "node:crypto";
import { getDb } from "../db/schema.js";
import { ExecutionLogTail } from "./logs.js";
import { compatibilityInputFromRecord } from "./extensionCompatibility.js";
import { ExtensionPolicy } from "./extensionPolicy.js";
import { PACKAGE_LIMITS } from "./packageValidator.js";
import { PluginRegistry } from "./registry.js";
import { PluginLifecycle } from "./pluginLifecycle.js";
import { PluginRunner } from "./runner.js";
import { SandboxRunner } from "./sandboxRunner.js";
import type { HostApiBroker } from "./hostApiBroker.js";
import type { PluginExecutionContext, PluginExecutionResult, PluginManifest, PluginRegistryRecord } from "./types.js";

const MAX_GLOBAL_CONCURRENCY = 2;
let activeGlobalExecutions = 0;
const globalWaiters: Array<() => void> = [];

async function acquireGlobalSlot(): Promise<() => void> {
  if (activeGlobalExecutions >= MAX_GLOBAL_CONCURRENCY) {
    await new Promise<void>((resolve) => globalWaiters.push(resolve));
  }
  activeGlobalExecutions += 1;
  return () => {
    activeGlobalExecutions = Math.max(0, activeGlobalExecutions - 1);
    globalWaiters.shift()?.();
  };
}

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function actionSchemaDigest(record: PluginRegistryRecord, actionId: string): string {
  const manifest = JSON.parse(record.manifestJson) as PluginManifest;
  const action = manifest.actions.find((candidate) => candidate.id === actionId);
  if (!action) throw Object.assign(new Error("Action 不存在"), { code: "PLUGIN_ACTION_NOT_FOUND" });
  return crypto.createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

export class PluginExecutionManager {
  private readonly runners = new Map<string, PluginRunner | SandboxRunner>();
  private readonly runnerBindings = new Map<string, { version: string; checksum: string }>();
  private readonly cancelledBeforeStart = new Set<string>();
  private readonly suspendedForUpdate = new Set<string>();
  private readonly probationActive = new Set<string>();
  private readonly probationWaiters = new Map<string, Array<() => void>>();

  constructor(
    private readonly broker: HostApiBroker,
    private readonly registry = new PluginRegistry(),
    private readonly policy = new ExtensionPolicy(),
    private readonly lifecycle = new PluginLifecycle(),
  ) {
    this.recoverInterruptedExecutions();
  }

  private recoverInterruptedExecutions(): void {
    const finishedAt = new Date().toISOString();
    getDb().prepare(`UPDATE plugin_executions
      SET status='failed',finishedAt=?,errorCode='HOST_RESTARTED',errorMessage='Nowen 重启，排队任务未执行'
      WHERE status='queued'`).run(finishedAt);
    getDb().prepare(`UPDATE plugin_executions
      SET status='interrupted',finishedAt=?,errorCode='HOST_RESTARTED',errorMessage='Nowen 重启，运行中的任务已中断'
      WHERE status='running'`).run(finishedAt);
  }

  private runner(
    pluginId: string,
    allowPreflight = false,
    expected?: { version: string; checksum: string },
  ): PluginRunner | SandboxRunner {
    const record = this.registry.get(pluginId);
    if (!record) throw new Error("插件不存在");
    if (!allowPreflight && this.suspendedForUpdate.has(pluginId)) {
      throw Object.assign(new Error("插件正在切换版本"), { code: "PLUGIN_UPDATE_IN_PROGRESS" });
    }
    if (!allowPreflight && record.activeOperationId && record.lifecycleState !== "probation") {
      throw Object.assign(new Error("插件正在验证候选版本"), { code: "PLUGIN_UPDATE_IN_PROGRESS" });
    }
    if (!allowPreflight && record.status !== "enabled") {
      throw Object.assign(new Error(`插件当前状态为 ${record.status}`), { code: "PLUGIN_NOT_ENABLED" });
    }
    if (record.lifecycleState !== "stable" && record.lifecycleState !== "probation"
      && !(allowPreflight && record.lifecycleState === "preflight")) {
      throw Object.assign(new Error(`插件生命周期当前为 ${record.lifecycleState}`), { code: "PLUGIN_LIFECYCLE_NOT_EXECUTABLE" });
    }
    if (expected && (record.version !== expected.version || record.checksum !== expected.checksum)) {
      throw Object.assign(new Error("插件在排队期间已切换版本"), { code: "PLUGIN_VERSION_CHANGED_WHILE_QUEUED" });
    }
    const resolvedRuntime = this.policy.assertAllowed(compatibilityInputFromRecord(record));
    const existing = this.runners.get(pluginId);
    if (existing) {
      const binding = this.runnerBindings.get(pluginId);
      if (!binding || binding.version !== record.version || binding.checksum !== record.checksum) {
        throw Object.assign(new Error("插件 Runner 与当前版本不一致"), { code: "PLUGIN_RUNNER_STALE" });
      }
      return existing;
    }
    const Runner = resolvedRuntime === "sandbox-js" ? SandboxRunner : PluginRunner;
    const runner = new Runner(
      record,
      (context, call) => this.broker.call(context, call),
      (executionId, progress) => this.updateProgress(executionId, progress),
    );
    this.runners.set(pluginId, runner);
    this.runnerBindings.set(pluginId, { version: record.version, checksum: record.checksum });
    return runner;
  }

  private async acquireProbationSlot(pluginId: string): Promise<() => void> {
    if (this.probationActive.has(pluginId)) {
      await new Promise<void>((resolve) => {
        const waiters = this.probationWaiters.get(pluginId) || [];
        waiters.push(resolve);
        this.probationWaiters.set(pluginId, waiters);
      });
    } else {
      this.probationActive.add(pluginId);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiters = this.probationWaiters.get(pluginId);
      const next = waiters?.shift();
      if (next) {
        next();
      } else {
        this.probationWaiters.delete(pluginId);
        this.probationActive.delete(pluginId);
      }
    };
  }

  private assertQueuedBinding(
    pluginId: string,
    actionId: string,
    queued: { version: string; checksum: string; actionDigest: string },
  ): PluginRegistryRecord {
    const current = this.registry.get(pluginId);
    if (!current) throw Object.assign(new Error("插件不存在"), { code: "PLUGIN_NOT_FOUND" });
    if (current.version !== queued.version || current.checksum !== queued.checksum) {
      throw Object.assign(new Error("插件在排队期间已切换版本"), { code: "PLUGIN_VERSION_CHANGED_WHILE_QUEUED" });
    }
    if (actionSchemaDigest(current, actionId) !== queued.actionDigest) {
      throw Object.assign(new Error("Action schema 在排队期间已变化"), { code: "PLUGIN_ACTION_SCHEMA_CHANGED" });
    }
    return current;
  }

  async execute(input: {
    pluginId: string;
    actionId: string;
    userId: string;
    workspaceId?: string | null;
    actionInput: Record<string, unknown>;
    timeoutMs: number;
    executionId?: string;
    executionContext?: Omit<PluginExecutionContext, "executionId" | "pluginId" | "actionId" | "userId" | "workspaceId">;
  }): Promise<{ executionId: string; result: PluginExecutionResult }> {
    const inputBytes = jsonSize(input.actionInput);
    if (inputBytes > PACKAGE_LIMITS.inputBytes) throw Object.assign(new Error("Action input 超过 256KB"), { code: "PLUGIN_INPUT_TOO_LARGE" });
    const queuedRecord = this.registry.get(input.pluginId);
    if (!queuedRecord) throw Object.assign(new Error("插件不存在"), { code: "PLUGIN_NOT_FOUND" });
    const queuedBinding = {
      version: queuedRecord.version,
      checksum: queuedRecord.checksum,
      actionDigest: actionSchemaDigest(queuedRecord, input.actionId),
    };
    const executionId = input.executionId || crypto.randomUUID();
    let startedAt = new Date();
    const context: PluginExecutionContext = {
      executionId,
      pluginId: input.pluginId,
      actionId: input.actionId,
      userId: input.userId,
      workspaceId: input.workspaceId || null,
      ...(input.executionContext || {}),
    };
    getDb().prepare(`INSERT INTO plugin_executions
      (id,pluginId,actionId,userId,workspaceId,status,startedAt,inputBytes,outputBytes,logTail)
      VALUES (?,?,?,?,?,'queued',?,?,0,'[]')`)
      .run(executionId, input.pluginId, input.actionId, input.userId, context.workspaceId, startedAt.toISOString(), inputBytes);
    const logs = new ExecutionLogTail();
    const release = await acquireGlobalSlot();
    let releaseProbation: (() => void) | null = null;
    let boundRecord: PluginRegistryRecord | null = null;
    let executionStarted = false;
    try {
      if (this.cancelledBeforeStart.delete(executionId)) {
        throw Object.assign(new Error("插件执行已取消"), { code: "PLUGIN_CANCELLED" });
      }
      const beforeProbationLock = this.assertQueuedBinding(input.pluginId, input.actionId, queuedBinding);
      if (beforeProbationLock.lifecycleState === "probation") {
        releaseProbation = await this.acquireProbationSlot(input.pluginId);
      }
      if (this.cancelledBeforeStart.delete(executionId)) {
        throw Object.assign(new Error("插件执行已取消"), { code: "PLUGIN_CANCELLED" });
      }
      boundRecord = this.assertQueuedBinding(input.pluginId, input.actionId, queuedBinding);
      const runner = this.runner(input.pluginId, false, queuedBinding);
      startedAt = new Date();
      getDb().prepare("UPDATE plugin_executions SET status='running',startedAt=? WHERE id=?").run(startedAt.toISOString(), executionId);
      executionStarted = true;
      const result = await runner.execute(context, input.actionInput, input.timeoutMs, logs);
      const outputBytes = jsonSize(result);
      if (outputBytes > PACKAGE_LIMITS.outputBytes) {
        throw Object.assign(new Error("Action output 超过 1MB"), { code: "PLUGIN_OUTPUT_TOO_LARGE" });
      }
      const finishedAt = new Date();
      getDb().prepare(`UPDATE plugin_executions SET status='completed',finishedAt=?,durationMs=?,outputBytes=?,logTail=? WHERE id=?`)
        .run(finishedAt.toISOString(), finishedAt.getTime() - startedAt.getTime(), outputBytes, JSON.stringify(logs.toArray()), executionId);
      this.lifecycle.completeProbationExecution(input.pluginId);
      return { executionId, result };
    } catch (error) {
      const coded = error as Error & { code?: string };
      logs.add("error", coded.message);
      const finishedAt = new Date();
      getDb().prepare(`UPDATE plugin_executions SET status=?,finishedAt=?,durationMs=?,errorCode=?,errorMessage=?,logTail=? WHERE id=?`)
        .run(coded.code === "PLUGIN_CANCELLED" ? "cancelled" : "failed", finishedAt.toISOString(), finishedAt.getTime() - startedAt.getTime(), coded.code || "PLUGIN_EXECUTION_FAILED", coded.message.slice(0, 2000), JSON.stringify(logs.toArray()), executionId);
      const probation = this.registry.get(input.pluginId);
      const shouldRollbackProbation = executionStarted
        && coded.code !== "PLUGIN_CANCELLED"
        && boundRecord?.lifecycleState === "probation"
        && probation?.lifecycleState === "probation"
        && probation.status === "enabled"
        && probation.version === boundRecord.version
        && probation.checksum === boundRecord.checksum;
      if (shouldRollbackProbation) {
        this.suspendForUpdate(input.pluginId);
        try {
          this.lifecycle.rollback(input.pluginId, coded.message, coded.code || "PLUGIN_EXECUTION_FAILED");
          await this.restart(input.pluginId);
        } finally {
          this.resumeAfterUpdate(input.pluginId);
        }
      } else if (coded.code === "PLUGIN_TIMEOUT") {
        this.registry.setStatus(input.pluginId, "error", coded.message);
      }
      throw Object.assign(coded, { executionId });
    } finally {
      releaseProbation?.();
      release();
    }
  }

  get(executionId: string): Record<string, unknown> | undefined {
    return getDb().prepare("SELECT * FROM plugin_executions WHERE id=?").get(executionId) as Record<string, unknown> | undefined;
  }

  list(pluginId: string, userId?: string, limit = 100): Record<string, unknown>[] {
    if (userId) {
      return getDb().prepare("SELECT * FROM plugin_executions WHERE pluginId=? AND userId=? ORDER BY startedAt DESC LIMIT ?")
        .all(pluginId, userId, Math.min(500, Math.max(1, limit))) as Record<string, unknown>[];
    }
    return getDb().prepare("SELECT * FROM plugin_executions WHERE pluginId=? ORDER BY startedAt DESC LIMIT ?")
      .all(pluginId, Math.min(500, Math.max(1, limit))) as Record<string, unknown>[];
  }

  cancel(executionId: string): boolean {
    const row = this.get(executionId) as { pluginId?: string; status?: string } | undefined;
    if (!row?.pluginId) return false;
    if (row.status === "queued") {
      this.cancelledBeforeStart.add(executionId);
      getDb().prepare(`UPDATE plugin_executions
        SET status='cancelled',finishedAt=?,errorCode='PLUGIN_CANCELLED',errorMessage='插件执行已取消'
        WHERE id=? AND status='queued'`).run(new Date().toISOString(), executionId);
      return true;
    }
    return this.runners.get(row.pluginId)?.cancel(executionId) || false;
  }

  async restart(pluginId: string): Promise<void> {
    const runner = this.runners.get(pluginId);
    if (runner) await runner.terminate();
    this.runners.delete(pluginId);
    this.runnerBindings.delete(pluginId);
  }

  async preflight(pluginId: string): Promise<void> {
    await this.runner(pluginId, true).preflight();
  }

  async preflightCandidate(record: PluginRegistryRecord): Promise<void> {
    const resolvedRuntime = this.policy.assertAllowed(compatibilityInputFromRecord(record));
    const Runner = resolvedRuntime === "sandbox-js" ? SandboxRunner : PluginRunner;
    const runner = new Runner(
      record,
      (context, call) => this.broker.call(context, call),
      () => undefined,
    );
    try {
      await runner.preflight();
    } finally {
      await runner.terminate();
    }
  }

  suspendForUpdate(pluginId: string): void {
    this.suspendedForUpdate.add(pluginId);
  }

  resumeAfterUpdate(pluginId: string): void {
    this.suspendedForUpdate.delete(pluginId);
  }

  private updateProgress(executionId: string, progress: { current?: number; total?: number; message?: string }): void {
    const current = Number.isFinite(progress.current) ? Math.max(0, Math.floor(progress.current!)) : null;
    const total = Number.isFinite(progress.total) ? Math.max(0, Math.floor(progress.total!)) : null;
    getDb().prepare(`UPDATE plugin_executions
      SET progressCurrent=?,progressTotal=?,progressMessage=?
      WHERE id=? AND status='running'`)
      .run(current, total, progress.message?.slice(0, 500) || null, executionId);
  }

  async shutdown(pluginId: string): Promise<void> {
    await this.restart(pluginId);
  }
}
