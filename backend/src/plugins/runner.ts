import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExecutionLogTail } from "./logs.js";
import type { HostCall, PluginExecutionContext, PluginExecutionResult, PluginProgress, PluginRegistryRecord } from "./types.js";

type HostCallHandler = (context: PluginExecutionContext, call: HostCall) => Promise<unknown>;
type ProgressHandler = (executionId: string, progress: PluginProgress) => void;

interface PendingExecution {
  context: PluginExecutionContext;
  resolve: (result: PluginExecutionResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  logs: ExecutionLogTail;
}

function runnerChildPath(): string {
  const candidates = [
    path.join(__dirname, "runner-child.mjs"),
    path.join(process.cwd(), "src", "plugins", "runner-child.mjs"),
    path.join(process.cwd(), "backend", "src", "plugins", "runner-child.mjs"),
    path.join(process.cwd(), "backend", "dist", "runner-child.mjs"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("找不到插件子进程运行器 runner-child.mjs");
  return found;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"];
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", ELECTRON_RUN_AS_NODE: "1" };
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  return env;
}

export class PluginRunner {
  private child: ChildProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingExecution>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly record: PluginRegistryRecord,
    private readonly hostCallHandler: HostCallHandler,
    private readonly progressHandler: ProgressHandler = () => undefined,
  ) {}

  private ensureChild(): Promise<void> {
    if (this.child?.connected && this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const child = fork(runnerChildPath(), [], {
        cwd: this.record.installedPath,
        env: sanitizedEnvironment(),
        execArgv: ["--max-old-space-size=128"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      this.child = child;
      child.unref();
      child.channel?.unref();
      const startupTimer = setTimeout(() => reject(new Error("插件 Worker 启动超时")), 5000);
      child.on("message", (message: any) => {
        if (message?.type === "booted") {
          child.send({
            type: "preflight",
            mainPath: path.resolve(this.record.installedPath, this.record.main),
            actions: (JSON.parse(this.record.manifestJson).actions || []).map((action: { id: string }) => action.id),
          });
          return;
        }
        if (message?.type === "ready") {
          clearTimeout(startupTimer);
          resolve();
          return;
        }
        if (message?.type === "preflight-error") {
          clearTimeout(startupTimer);
          const error = Object.assign(new Error(message.error?.message || "插件 Preflight 失败"), { code: message.error?.code || "PLUGIN_PREFLIGHT_FAILED" });
          void this.terminate().finally(() => reject(error));
          return;
        }
        void this.handleMessage(message);
      });
      child.once("error", (error) => {
        clearTimeout(startupTimer);
        reject(error);
        this.failAll(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(startupTimer);
        this.child = null;
        this.readyPromise = null;
        this.failAll(new Error(`插件 Worker 已退出 (${signal || code || "unknown"})`));
      });
    });
    return this.readyPromise;
  }

  private async handleMessage(message: any): Promise<void> {
    if (!message || typeof message !== "object") return;
    if (message.type === "progress" && message.executionId) {
      this.progressHandler(String(message.executionId), {
        current: message.current,
        total: message.total,
        message: message.message,
      });
      return;
    }
    const pending = this.pending.get(String(message.executionId || ""));
    if (message.type === "log" && pending) {
      pending.logs.add(message.level || "info", message.message || "");
      return;
    }
    if (message.type === "host-call" && pending && this.child?.connected) {
      try {
        const result = await this.hostCallHandler(pending.context, { method: message.method, args: message.args });
        this.child.send({ type: "host-result", callId: message.callId, result });
      } catch (error) {
        const coded = error as Error & { code?: string };
        this.child.send({ type: "host-result", callId: message.callId, error: { message: coded.message, code: coded.code || "HOST_CALL_FAILED" } });
      }
      return;
    }
    if (!pending) return;
    if (message.type === "execution-result") {
      clearTimeout(pending.timer);
      this.pending.delete(pending.context.executionId);
      pending.resolve(message.result);
    } else if (message.type === "execution-error") {
      clearTimeout(pending.timer);
      this.pending.delete(pending.context.executionId);
      const error = Object.assign(new Error(message.error?.message || "插件执行失败"), { code: message.error?.code });
      pending.reject(error);
    }
  }

  execute(context: PluginExecutionContext, input: Record<string, unknown>, timeoutMs: number, logs: ExecutionLogTail): Promise<PluginExecutionResult> {
    const task = this.queue.then(async () => {
      await this.ensureChild();
      return new Promise<PluginExecutionResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          const error = Object.assign(new Error(`插件执行超时 (${timeoutMs}ms)`), { code: "PLUGIN_TIMEOUT" });
          this.pending.delete(context.executionId);
          void this.terminate().finally(() => reject(error));
        }, timeoutMs);
        this.pending.set(context.executionId, { context, resolve, reject, timer, logs });
        this.child!.send({
          type: "execute",
          ...context,
          input,
          mainPath: path.resolve(this.record.installedPath, this.record.main),
        });
      });
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  async preflight(): Promise<void> {
    await this.ensureChild();
  }

  cancel(executionId: string): boolean {
    if (!this.pending.has(executionId)) return false;
    const pending = this.pending.get(executionId)!;
    clearTimeout(pending.timer);
    this.pending.delete(executionId);
    void this.terminate().finally(() => pending.reject(Object.assign(new Error("插件执行已取消"), { code: "PLUGIN_CANCELLED" })));
    return true;
  }

  async terminate(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.readyPromise = null;
    if (!child) return;
    if (!child.killed) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => { clearTimeout(force); resolve(); });
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
