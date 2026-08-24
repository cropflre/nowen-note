import crypto from "node:crypto";
import { getDb } from "../db/schema.js";
import { ExecutionLogTail } from "./logs.js";
import { compatibilityInputFromRecord } from "./extensionCompatibility.js";
import { ExtensionPolicy } from "./extensionPolicy.js";
import { PACKAGE_LIMITS } from "./packageValidator.js";
import { PluginRegistry } from "./registry.js";
import { PluginRunner } from "./runner.js";
import { SandboxRunner } from "./sandboxRunner.js";
import type { HostApiBroker } from "./hostApiBroker.js";
import type { PluginExecutionContext, PluginExecutionResult } from "./types.js";

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

export class PluginExecutionManager {
  private readonly runners = new Map<string, PluginRunner | SandboxRunner>();
  private readonly cancelledBeforeStart = new Set<string>();

  constructor(
    private readonly broker: HostApiBroker,
    private readonly registry = new PluginRegistry(),
    private readonly policy = new ExtensionPolicy(),
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

  private runner(pluginId: string): PluginRunner | SandboxRunner {
    const record = this.registry.get(pluginId);
    if (!record) throw new Error("插件不存在");
    const resolvedRuntime = this.policy.assertAllowed(compatibilityInputFromRecord(record));
    const existing = this.runners.get(pluginId);
    if (existing) return existing;
    const Runner = resolvedRuntime === "sandbox-js" ? SandboxRunner : PluginRunner;
    const runner = new Runner(
      record,
      (context, call) => this.broker.call(context, call),
      (executionId, progress) => this.updateProgress(executionId, progress),
    );
    this.runners.set(pluginId, runner);
    return runner;
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
    try {
      if (this.cancelledBeforeStart.delete(executionId)) {
        throw Object.assign(new Error("插件执行已取消"), { code: "PLUGIN_CANCELLED" });
      }
      startedAt = new Date();
      getDb().prepare("UPDATE plugin_executions SET status='running',startedAt=? WHERE id=?").run(startedAt.toISOString(), executionId);
      const result = await this.runner(input.pluginId).execute(context, input.actionInput, input.timeoutMs, logs);
      const outputBytes = jsonSize(result);
      if (outputBytes > PACKAGE_LIMITS.outputBytes) {
        throw Object.assign(new Error("Action output 超过 1MB"), { code: "PLUGIN_OUTPUT_TOO_LARGE" });
      }
      const finishedAt = new Date();
      getDb().prepare(`UPDATE plugin_executions SET status='completed',finishedAt=?,durationMs=?,outputBytes=?,logTail=? WHERE id=?`)
        .run(finishedAt.toISOString(), finishedAt.getTime() - startedAt.getTime(), outputBytes, JSON.stringify(logs.toArray()), executionId);
      getDb().prepare(`UPDATE plugin_registry SET probationRemaining=MAX(0,probationRemaining-1),probationVersion=CASE WHEN probationRemaining<=1 THEN NULL ELSE probationVersion END WHERE id=? AND probationVersion=version`).run(input.pluginId);
      return { executionId, result };
    } catch (error) {
      const coded = error as Error & { code?: string };
      logs.add("error", coded.message);
      const finishedAt = new Date();
      getDb().prepare(`UPDATE plugin_executions SET status=?,finishedAt=?,durationMs=?,errorCode=?,errorMessage=?,logTail=? WHERE id=?`)
        .run(coded.code === "PLUGIN_CANCELLED" ? "cancelled" : "failed", finishedAt.toISOString(), finishedAt.getTime() - startedAt.getTime(), coded.code || "PLUGIN_EXECUTION_FAILED", coded.message.slice(0, 2000), JSON.stringify(logs.toArray()), executionId);
      if (coded.code === "PLUGIN_TIMEOUT") this.registry.setStatus(input.pluginId, "error", coded.message);
      const probation = this.registry.get(input.pluginId);
      if (probation && probation.probationVersion === probation.version && probation.previousVersion) {
        const previousVersion = probation.previousVersion;
        await this.restart(input.pluginId);
        this.registry.switchVersion(input.pluginId, previousVersion);
        getDb().prepare("UPDATE plugin_registry SET status='disabled',probationVersion=NULL,probationRemaining=0,autoRollbackReason=?,lastError=? WHERE id=?").run(coded.message.slice(0, 1000), "新版本试运行失败，已自动回滚并禁用", input.pluginId);
      }
      throw Object.assign(coded, { executionId });
    } finally {
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
  }

  async preflight(pluginId: string): Promise<void> {
    await this.runner(pluginId).preflight();
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
