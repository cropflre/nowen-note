import { fork, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExecutionLogTail } from "./logs.js";
import {
  normalizeSandboxError,
  sandboxJsonBytes,
  sandboxMethodsForApiVersion,
  SANDBOX_PROTOCOL_LIMITS,
  validateSandboxMessage,
  type SandboxErrorPayload,
  type SandboxMessage,
} from "./sandboxProtocol.js";
import type { HostCall, PluginExecutionContext, PluginExecutionResult, PluginProgress, PluginRegistryRecord } from "./types.js";

type HostCallHandler = (context: PluginExecutionContext, call: HostCall) => Promise<unknown>;
type ProgressHandler = (executionId: string, progress: PluginProgress) => void;
type CancellationReason = "timeout" | "cancel";

interface PendingOperation<T> {
  kind: "preflight" | "execute";
  executionId: string;
  context: PluginExecutionContext;
  methods: ReadonlySet<string>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cancellationTimer: NodeJS.Timeout | null;
  cancellationReason: CancellationReason | null;
  hostCallIds: Set<string>;
  seenHostCallIds: Set<string>;
  totalHostCalls: number;
  progressEvents: number;
}

interface QueuedExecution {
  cancelled: boolean;
}

const CHILD_BOOT_TIMEOUT_MS = 5_000;
const CANCEL_GRACE_MS = 300;

function sandboxChildPath(): string {
  const candidates = [
    path.join(__dirname, "sandbox-child.mjs"),
    path.join(process.cwd(), "src", "plugins", "sandbox-child.mjs"),
    path.join(process.cwd(), "backend", "src", "plugins", "sandbox-child.mjs"),
    path.join(process.cwd(), "dist", "plugins", "sandbox-child.mjs"),
    path.join(process.cwd(), "backend", "dist", "plugins", "sandbox-child.mjs"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw Object.assign(new Error("找不到 QuickJS Sandbox 子进程入口 sandbox-child.mjs"), { code: "PLUGIN_SANDBOX_FAILED" });
  return found;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"];
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    ELECTRON_RUN_AS_NODE: "1",
  };
  for (const key of allowed) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function operationError(payload: SandboxErrorPayload, cancellationReason: CancellationReason | null): Error {
  if (cancellationReason === "timeout") return codedError("PLUGIN_TIMEOUT", "插件 Sandbox 执行超时");
  if (cancellationReason === "cancel") return codedError("PLUGIN_CANCELLED", "插件执行已取消");
  return codedError(payload.code, payload.message);
}

function manifestActionIds(record: PluginRegistryRecord): string[] {
  const manifest = JSON.parse(record.manifestJson) as { actions?: Array<{ id?: unknown }> };
  return (manifest.actions || [])
    .map((action) => action.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export class SandboxRunner {
  private child: ChildProcess | null = null;
  private bootPromise: Promise<void> | null = null;
  private bootResolve: (() => void) | null = null;
  private bootReject: ((error: Error) => void) | null = null;
  private active: PendingOperation<unknown> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly queuedExecutions = new Map<string, QueuedExecution>();

  constructor(
    private readonly record: PluginRegistryRecord,
    private readonly hostCallHandler: HostCallHandler,
    private readonly progressHandler: ProgressHandler = () => undefined,
  ) {}

  private source(): { source: string; filename: string } {
    const installedPath = path.resolve(this.record.installedPath);
    const target = path.resolve(installedPath, this.record.main);
    const relative = path.relative(installedPath, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw codedError("PLUGIN_SANDBOX_FAILED", "Sandbox 入口路径逃逸");
    }
    return { source: fs.readFileSync(target, "utf8"), filename: this.record.main };
  }

  private methods(): string[] {
    return sandboxMethodsForApiVersion(this.record.apiVersion);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation, operation);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async ensureChild(): Promise<void> {
    if (this.child?.connected && this.bootPromise) {
      await this.bootPromise;
      return;
    }

    const child = fork(sandboxChildPath(), [], {
      cwd: this.record.installedPath,
      env: sanitizedEnvironment(),
      execArgv: ["--max-old-space-size=128"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child = child;
    child.unref();
    child.channel?.unref();

    this.bootPromise = new Promise<void>((resolve, reject) => {
      this.bootResolve = resolve;
      this.bootReject = reject;
    });
    const startupTimer = setTimeout(() => {
      this.invalidateChild(child, codedError("PLUGIN_SANDBOX_FAILED", "QuickJS Sandbox 子进程启动超时"), true);
    }, CHILD_BOOT_TIMEOUT_MS);

    child.on("message", (rawMessage: unknown) => {
      try {
        const message = validateSandboxMessage(rawMessage, "child-to-supervisor");
        if (message.type === "booted") clearTimeout(startupTimer);
        void this.handleMessage(child, message);
      } catch (error) {
        clearTimeout(startupTimer);
        this.invalidateChild(child, codedError("PLUGIN_PROTOCOL_INVALID", normalizeSandboxError(error).message), true);
      }
    });
    child.once("error", (error) => {
      clearTimeout(startupTimer);
      this.invalidateChild(child, codedError("PLUGIN_SANDBOX_FAILED", error.message), true);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(startupTimer);
      this.invalidateChild(
        child,
        codedError("PLUGIN_SANDBOX_FAILED", `QuickJS Sandbox 子进程已退出 (${signal || code || "unknown"})`),
        false,
      );
    });

    await this.bootPromise;
  }

  private async send(child: ChildProcess, rawMessage: SandboxMessage): Promise<void> {
    if (sandboxJsonBytes(rawMessage) > SANDBOX_PROTOCOL_LIMITS.messageBytes) {
      throw codedError("PLUGIN_PROTOCOL_MESSAGE_TOO_LARGE", "Sandbox IPC 消息超过 2MB");
    }
    const message = validateSandboxMessage(rawMessage, "supervisor-to-child");
    if (child !== this.child || !child.connected || typeof child.send !== "function") {
      throw codedError("PLUGIN_SANDBOX_FAILED", "QuickJS Sandbox IPC 已断开");
    }
    await new Promise<void>((resolve, reject) => {
      try {
        child.send(message, (error) => {
          if (error) reject(codedError("PLUGIN_SANDBOX_FAILED", error.message));
          else resolve();
        });
      } catch (error) {
        reject(codedError("PLUGIN_SANDBOX_FAILED", normalizeSandboxError(error).message));
      }
    });
  }

  private async handleMessage(child: ChildProcess, message: SandboxMessage): Promise<void> {
    if (child !== this.child) return;
    if (message.type === "booted") {
      if (!this.bootResolve) {
        this.invalidateChild(child, codedError("PLUGIN_PROTOCOL_INVALID", "QuickJS Sandbox 重复发送 booted"), true);
        return;
      }
      const resolve = this.bootResolve;
      this.bootResolve = null;
      this.bootReject = null;
      resolve();
      return;
    }

    const pending = this.active;
    if (!pending || !("executionId" in message) || message.executionId !== pending.executionId) {
      this.invalidateChild(child, codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox IPC executionId 与当前操作不一致"), true);
      return;
    }

    if (message.type === "host-call") {
      await this.handleHostCall(child, pending, message);
      return;
    }
    if (message.type === "progress") {
      if (pending.kind !== "execute" || ++pending.progressEvents > SANDBOX_PROTOCOL_LIMITS.progressEvents) {
        this.invalidateChild(child, codedError("PLUGIN_PROTOCOL_LIMIT_EXCEEDED", "Sandbox 进度事件超过限制"), true);
        return;
      }
      this.progressHandler(pending.executionId, {
        current: message.current,
        total: message.total,
        message: message.message,
      });
      return;
    }
    if (message.type === "ready") {
      if (pending.kind !== "preflight") {
        this.invalidateChild(child, codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox ready 消息不属于 Preflight"), true);
        return;
      }
      if (pending.cancellationReason) {
        this.settleOperation(
          pending,
          undefined,
          operationError({ code: "PLUGIN_PREFLIGHT_FAILED", message: "Sandbox Preflight 已取消" }, pending.cancellationReason),
        );
      } else if (message.ok) this.settleOperation(pending, undefined);
      else this.settleOperation(pending, undefined, operationError(message.error!, pending.cancellationReason));
      return;
    }
    if (message.type === "execution-result") {
      if (pending.kind !== "execute") {
        this.invalidateChild(child, codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox 执行结果不属于 Execute"), true);
        return;
      }
      if (pending.cancellationReason) {
        this.settleOperation(
          pending,
          undefined,
          operationError({ code: "PLUGIN_SANDBOX_FAILED", message: "Sandbox 执行已取消" }, pending.cancellationReason),
        );
      } else {
        this.settleOperation(pending, message.result);
      }
      return;
    }
    if (message.type === "execution-error") {
      this.settleOperation(pending, undefined, operationError(message.error, pending.cancellationReason));
      return;
    }

    this.invalidateChild(child, codedError("PLUGIN_PROTOCOL_INVALID", `Sandbox 子进程消息时序不合法: ${message.type}`), true);
  }

  private async handleHostCall(
    child: ChildProcess,
    pending: PendingOperation<unknown>,
    message: Extract<SandboxMessage, { type: "host-call" }>,
  ): Promise<void> {
    if (pending.kind !== "execute" || !pending.methods.has(message.method)) {
      this.invalidateChild(child, codedError("PLUGIN_PROTOCOL_METHOD_UNSUPPORTED", "Sandbox 调用了未授权的 Host API 方法"), true);
      return;
    }
    if (++pending.totalHostCalls > SANDBOX_PROTOCOL_LIMITS.hostCalls) {
      this.invalidateChild(child, codedError("PLUGIN_PROTOCOL_LIMIT_EXCEEDED", "Host API 调用次数超过 1000"), true);
      return;
    }
    if (pending.hostCallIds.size >= SANDBOX_PROTOCOL_LIMITS.pendingHostCalls || pending.seenHostCallIds.has(message.callId)) {
      this.invalidateChild(child, codedError("PLUGIN_PROTOCOL_LIMIT_EXCEEDED", "并发 Host API 调用超过限制或 callId 重复"), true);
      return;
    }

    pending.hostCallIds.add(message.callId);
    pending.seenHostCallIds.add(message.callId);
    let response: Extract<SandboxMessage, { type: "host-result" }>;
    try {
      const result = await this.hostCallHandler(pending.context, { method: message.method, args: message.args });
      response = {
        type: "host-result",
        executionId: pending.executionId,
        callId: message.callId,
        result: result ?? null,
      };
    } catch (error) {
      response = {
        type: "host-result",
        executionId: pending.executionId,
        callId: message.callId,
        error: normalizeSandboxError(error, "HOST_CALL_FAILED"),
      };
    } finally {
      pending.hostCallIds.delete(message.callId);
    }

    if (this.active !== pending || child !== this.child || pending.cancellationReason) return;
    try {
      if (Object.prototype.hasOwnProperty.call(response, "result")
        && sandboxJsonBytes(response.result) > SANDBOX_PROTOCOL_LIMITS.hostCallResultBytes) {
        response = {
          type: "host-result",
          executionId: pending.executionId,
          callId: message.callId,
          error: {
            code: "PLUGIN_PROTOCOL_HOST_RESULT_TOO_LARGE",
            message: "Host API 结果超过 1MB",
          },
        };
      }
      await this.send(child, response);
    } catch (error) {
      this.invalidateChild(child, codedError("PLUGIN_SANDBOX_FAILED", normalizeSandboxError(error).message), true);
    }
  }

  private settleOperation<T>(pending: PendingOperation<T>, value?: T, error?: Error): void {
    if (this.active !== pending) return;
    clearTimeout(pending.timer);
    if (pending.cancellationTimer) clearTimeout(pending.cancellationTimer);
    this.active = null;
    if (error) pending.reject(error);
    else pending.resolve(value as T);
  }

  private invalidateChild(child: ChildProcess, error: Error, kill: boolean): void {
    if (child !== this.child) return;
    this.child = null;
    this.bootPromise = null;
    const rejectBoot = this.bootReject;
    this.bootResolve = null;
    this.bootReject = null;
    rejectBoot?.(error);
    if (this.active) this.settleOperation(this.active, undefined, error);
    if (kill && !child.killed) child.kill("SIGKILL");
  }

  private requestCancellation<T>(pending: PendingOperation<T>, reason: CancellationReason): void {
    if (this.active !== pending as PendingOperation<unknown> || pending.cancellationReason) return;
    pending.cancellationReason = reason;
    clearTimeout(pending.timer);
    const child = this.child;
    if (!child) {
      this.settleOperation(pending, undefined, operationError({ code: "PLUGIN_SANDBOX_FAILED", message: "Sandbox 子进程不可用" }, reason));
      return;
    }
    const cancellationError = operationError({ code: "PLUGIN_SANDBOX_FAILED", message: "Sandbox 执行已取消" }, reason);
    void this.send(child, { type: "cancel", executionId: pending.executionId }).catch(() => {
      this.invalidateChild(child, cancellationError, true);
    });
    pending.cancellationTimer = setTimeout(() => {
      if (this.active !== pending) return;
      this.invalidateChild(child, cancellationError, true);
    }, CANCEL_GRACE_MS);
  }

  private runOperation<T>(
    kind: PendingOperation<T>["kind"],
    context: PluginExecutionContext,
    timeoutMs: number,
    messageFactory: (methods: string[]) => SandboxMessage,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const methods = this.methods();
      const pending: PendingOperation<T> = {
        kind,
        executionId: context.executionId,
        context,
        methods: new Set(methods),
        resolve,
        reject,
        timer: setTimeout(() => this.requestCancellation(pending, "timeout"), timeoutMs),
        cancellationTimer: null,
        cancellationReason: null,
        hostCallIds: new Set(),
        seenHostCallIds: new Set(),
        totalHostCalls: 0,
        progressEvents: 0,
      };
      this.active = pending as PendingOperation<unknown>;
      const child = this.child;
      if (!child) {
        this.settleOperation(pending, undefined, codedError("PLUGIN_SANDBOX_FAILED", "QuickJS Sandbox 子进程不可用"));
        return;
      }
      void this.send(child, messageFactory(methods)).catch((error) => {
        this.invalidateChild(child, codedError("PLUGIN_SANDBOX_FAILED", normalizeSandboxError(error).message), true);
      });
    });
  }

  execute(
    context: PluginExecutionContext,
    input: Record<string, unknown>,
    timeoutMs: number,
    _logs: ExecutionLogTail,
  ): Promise<PluginExecutionResult> {
    const queued = { cancelled: false };
    this.queuedExecutions.set(context.executionId, queued);
    return this.enqueue(async () => {
      this.queuedExecutions.delete(context.executionId);
      if (queued.cancelled) throw codedError("PLUGIN_CANCELLED", "插件执行已取消");
      await this.ensureChild();
      const { source, filename } = this.source();
      return this.runOperation<PluginExecutionResult>("execute", context, timeoutMs, (methods) => ({
        type: "execute",
        executionId: context.executionId,
        source,
        filename,
        actionId: context.actionId,
        methods,
        input,
        context,
        timeoutMs,
      }));
    });
  }

  preflight(): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureChild();
      const { source, filename } = this.source();
      const executionId = `preflight-${crypto.randomUUID()}`;
      const context: PluginExecutionContext = {
        executionId,
        pluginId: this.record.id,
        actionId: "preflight",
        userId: "system",
        workspaceId: null,
        source: "system",
      };
      return this.runOperation<void>("preflight", context, 5_000, (methods) => ({
        type: "preflight",
        executionId,
        source,
        filename,
        actionIds: manifestActionIds(this.record),
        methods,
        timeoutMs: 5_000,
      }));
    });
  }

  cancel(executionId: string): boolean {
    const active = this.active;
    if (active?.executionId === executionId) {
      this.requestCancellation(active, "cancel");
      return true;
    }
    const queued = this.queuedExecutions.get(executionId);
    if (!queued) return false;
    queued.cancelled = true;
    return true;
  }

  async terminate(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.active) this.requestCancellation(this.active, "cancel");
    try {
      await this.send(child, { type: "shutdown" });
    } catch {
      // IPC 已断开时直接结束进程。
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const force = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolve();
      }, CANCEL_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
    });
    if (child === this.child) {
      this.invalidateChild(child, codedError("PLUGIN_CANCELLED", "QuickJS Sandbox 已关闭"), true);
    }
  }
}
