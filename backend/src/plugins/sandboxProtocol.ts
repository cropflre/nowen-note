import { HOST_API_BUDGETS, HOST_API_CONTRACT } from "./hostApiContract.js";
import type { PluginExecutionResult } from "./types.js";

export const SANDBOX_PROTOCOL_LIMITS = Object.freeze({
  messageBytes: HOST_API_BUDGETS.ipcMessageBytes,
  hostCallArgsBytes: HOST_API_BUDGETS.hostCallArgsBytes,
  hostCallResultBytes: HOST_API_BUDGETS.hostCallResultBytes,
  hostCalls: 1000,
  pendingHostCalls: 32,
  progressEvents: 100,
  progressMessageChars: 500,
});

export const SANDBOX_METHODS = Object.freeze(HOST_API_CONTRACT
  .filter((entry) => entry.runtimes.includes("sandbox-js"))
  .map((entry) => entry.method));

const SANDBOX_METHOD_SET = new Set<string>(SANDBOX_METHODS);
const MESSAGE_TYPES = new Set([
  "booted",
  "preflight",
  "ready",
  "execute",
  "host-call",
  "host-result",
  "progress",
  "execution-result",
  "execution-error",
  "cancel",
  "shutdown",
]);

export type SandboxProtocolErrorCode =
  | "PLUGIN_PROTOCOL_INVALID"
  | "PLUGIN_PROTOCOL_MESSAGE_TOO_LARGE"
  | "PLUGIN_PROTOCOL_HOST_ARGS_TOO_LARGE"
  | "PLUGIN_PROTOCOL_HOST_RESULT_TOO_LARGE"
  | "PLUGIN_PROTOCOL_METHOD_UNSUPPORTED"
  | "PLUGIN_PROTOCOL_LIMIT_EXCEEDED";

export interface SandboxErrorPayload {
  code: string;
  message: string;
}

export interface SandboxExecutionContextPayload {
  executionId: string;
  pluginId: string;
  actionId: string;
  userId: string;
  workspaceId: string | null;
  source?: "user" | "plugin" | "workflow" | "sync" | "system";
  sourceId?: string;
  correlationId?: string;
  causationId?: string;
  depth?: number;
  idempotencyKey?: string;
}

export type SandboxMessage =
  | { type: "booted" }
  | { type: "preflight"; executionId: string; source: string; filename: string; actionIds: string[]; methods: string[]; timeoutMs: number }
  | { type: "ready"; executionId: string; ok: boolean; error?: SandboxErrorPayload }
  | { type: "execute"; executionId: string; source: string; filename: string; actionId: string; methods: string[]; input: Record<string, unknown>; context: SandboxExecutionContextPayload; timeoutMs: number }
  | { type: "host-call"; executionId: string; callId: string; method: string; args: unknown }
  | { type: "host-result"; executionId: string; callId: string; result?: unknown; error?: SandboxErrorPayload }
  | { type: "progress"; executionId: string; current?: number; total?: number; message?: string }
  | { type: "execution-result"; executionId: string; result: PluginExecutionResult }
  | { type: "execution-error"; executionId: string; error: SandboxErrorPayload }
  | { type: "cancel"; executionId: string }
  | { type: "shutdown" };

type SandboxMessageType = SandboxMessage["type"];
type Direction = "supervisor-to-child" | "child-to-supervisor";

const SUPERVISOR_TYPES = new Set<SandboxMessageType>(["preflight", "execute", "host-result", "cancel", "shutdown"]);
const CHILD_TYPES = new Set<SandboxMessageType>(["booted", "ready", "host-call", "progress", "execution-result", "execution-error"]);

function protocolError(code: SandboxProtocolErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox IPC 消息字段不合法");
  }
}

function assertString(value: unknown, label: string, max = 1024): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw protocolError("PLUGIN_PROTOCOL_INVALID", `${label} 不合法`);
  }
}

function assertOptionalString(value: unknown, label: string, max = 1024): void {
  if (value !== undefined && (typeof value !== "string" || value.length > max)) {
    throw protocolError("PLUGIN_PROTOCOL_INVALID", `${label} 不合法`);
  }
}

function assertFiniteNumber(value: unknown, label: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw protocolError("PLUGIN_PROTOCOL_INVALID", `${label} 不合法`);
  }
}

function jsonBytes(value: unknown, code: SandboxProtocolErrorCode, label: string): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw protocolError(code, `${label} 必须是可序列化 JSON`);
  }
  if (serialized === undefined) throw protocolError(code, `${label} 必须是可序列化 JSON`);
  return Buffer.byteLength(serialized, "utf8");
}

function assertError(value: unknown): asserts value is SandboxErrorPayload {
  if (!isRecord(value)) throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox 错误对象不合法");
  assertExactKeys(value, ["code", "message"]);
  assertString(value.code, "Sandbox 错误码", 128);
  assertString(value.message, "Sandbox 错误消息", 2000);
}

function assertMethods(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > SANDBOX_METHODS.length) {
    throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox Host API 方法清单不合法");
  }
  const seen = new Set<string>();
  for (const method of value) {
    if (typeof method !== "string" || !SANDBOX_METHOD_SET.has(method) || seen.has(method)) {
      throw protocolError("PLUGIN_PROTOCOL_METHOD_UNSUPPORTED", "Sandbox Host API 方法不在生成合同中");
    }
    seen.add(method);
  }
}

function assertContext(value: unknown, executionId: string): asserts value is SandboxExecutionContextPayload {
  if (!isRecord(value)) throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox 执行上下文不合法");
  assertExactKeys(value, ["executionId", "pluginId", "actionId", "userId", "workspaceId"], [
    "source", "sourceId", "correlationId", "causationId", "depth", "idempotencyKey",
  ]);
  assertString(value.executionId, "executionId", 256);
  if (value.executionId !== executionId) throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox executionId 不一致");
  assertString(value.pluginId, "pluginId", 256);
  assertString(value.actionId, "actionId", 256);
  assertString(value.userId, "userId", 256);
  if (value.workspaceId !== null) assertString(value.workspaceId, "workspaceId", 256);
  if (value.source !== undefined && !["user", "plugin", "workflow", "sync", "system"].includes(String(value.source))) {
    throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox source 不合法");
  }
  for (const key of ["sourceId", "correlationId", "causationId", "idempotencyKey"] as const) {
    assertOptionalString(value[key], key, 512);
  }
  if (value.depth !== undefined) assertFiniteNumber(value.depth, "depth");
}

export function sandboxJsonBytes(value: unknown): number {
  return jsonBytes(value, "PLUGIN_PROTOCOL_INVALID", "Sandbox IPC 消息");
}

export function assertSandboxMethod(method: string): void {
  if (!SANDBOX_METHOD_SET.has(method)) {
    throw protocolError("PLUGIN_PROTOCOL_METHOD_UNSUPPORTED", `Sandbox Host API 方法不受支持: ${method}`);
  }
}

export function sandboxMethodsForApiVersion(apiVersion: number): string[] {
  return HOST_API_CONTRACT
    .filter((entry) => entry.runtimes.includes("sandbox-js") && apiVersion >= entry.sinceApiVersion)
    .map((entry) => entry.method);
}

export function validateSandboxMessage(value: unknown, direction: Direction): SandboxMessage {
  if (!isRecord(value)) throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox IPC 消息必须是对象");
  const bytes = jsonBytes(value, "PLUGIN_PROTOCOL_INVALID", "Sandbox IPC 消息");
  if (bytes > SANDBOX_PROTOCOL_LIMITS.messageBytes) {
    throw protocolError("PLUGIN_PROTOCOL_MESSAGE_TOO_LARGE", "Sandbox IPC 消息超过 2MB");
  }
  if (typeof value.type !== "string" || !MESSAGE_TYPES.has(value.type)) {
    throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox IPC 消息类型不合法");
  }
  const type = value.type as SandboxMessageType;
  if (!(direction === "supervisor-to-child" ? SUPERVISOR_TYPES : CHILD_TYPES).has(type)) {
    throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox IPC 消息方向不合法");
  }

  switch (type) {
    case "booted":
    case "shutdown":
      assertExactKeys(value, ["type"]);
      break;
    case "preflight":
      assertExactKeys(value, ["type", "executionId", "source", "filename", "actionIds", "methods", "timeoutMs"]);
      assertString(value.executionId, "executionId", 256);
      assertString(value.source, "Sandbox 源码", SANDBOX_PROTOCOL_LIMITS.messageBytes);
      assertString(value.filename, "Sandbox 文件名", 1024);
      if (!Array.isArray(value.actionIds) || value.actionIds.some((item) => typeof item !== "string" || item.length === 0 || item.length > 256)) {
        throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox Action 清单不合法");
      }
      assertMethods(value.methods);
      assertFiniteNumber(value.timeoutMs, "timeoutMs", 1);
      break;
    case "ready":
      assertExactKeys(value, ["type", "executionId", "ok"], ["error"]);
      assertString(value.executionId, "executionId", 256);
      if (typeof value.ok !== "boolean") throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox ready 状态不合法");
      if (value.ok === false) assertError(value.error);
      else if (value.error !== undefined) throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox ready 成功消息不能携带错误");
      break;
    case "execute":
      assertExactKeys(value, ["type", "executionId", "source", "filename", "actionId", "methods", "input", "context", "timeoutMs"]);
      assertString(value.executionId, "executionId", 256);
      assertString(value.source, "Sandbox 源码", SANDBOX_PROTOCOL_LIMITS.messageBytes);
      assertString(value.filename, "Sandbox 文件名", 1024);
      assertString(value.actionId, "actionId", 256);
      assertMethods(value.methods);
      if (!isRecord(value.input)) throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox 输入必须是对象");
      jsonBytes(value.input, "PLUGIN_PROTOCOL_INVALID", "Sandbox 输入");
      assertContext(value.context, value.executionId);
      assertFiniteNumber(value.timeoutMs, "timeoutMs", 1);
      break;
    case "host-call":
      assertExactKeys(value, ["type", "executionId", "callId", "method", "args"]);
      assertString(value.executionId, "executionId", 256);
      assertString(value.callId, "callId", 256);
      assertString(value.method, "Host API 方法", 256);
      assertSandboxMethod(value.method);
      if (jsonBytes(value.args, "PLUGIN_PROTOCOL_HOST_ARGS_TOO_LARGE", "Host API 参数") > SANDBOX_PROTOCOL_LIMITS.hostCallArgsBytes) {
        throw protocolError("PLUGIN_PROTOCOL_HOST_ARGS_TOO_LARGE", "Host API 参数超过 256KB");
      }
      break;
    case "host-result": {
      assertExactKeys(value, ["type", "executionId", "callId"], ["result", "error"]);
      assertString(value.executionId, "executionId", 256);
      assertString(value.callId, "callId", 256);
      const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
      const hasError = Object.prototype.hasOwnProperty.call(value, "error");
      if (hasResult === hasError) throw protocolError("PLUGIN_PROTOCOL_INVALID", "Host API 结果必须且只能包含 result 或 error");
      if (hasError) assertError(value.error);
      if (hasResult && jsonBytes(value.result, "PLUGIN_PROTOCOL_HOST_RESULT_TOO_LARGE", "Host API 结果") > SANDBOX_PROTOCOL_LIMITS.hostCallResultBytes) {
        throw protocolError("PLUGIN_PROTOCOL_HOST_RESULT_TOO_LARGE", "Host API 结果超过 1MB");
      }
      break;
    }
    case "progress":
      assertExactKeys(value, ["type", "executionId"], ["current", "total", "message"]);
      assertString(value.executionId, "executionId", 256);
      if (value.current !== undefined) assertFiniteNumber(value.current, "progress.current");
      if (value.total !== undefined) assertFiniteNumber(value.total, "progress.total");
      assertOptionalString(value.message, "progress.message", SANDBOX_PROTOCOL_LIMITS.progressMessageChars);
      break;
    case "execution-result":
      assertExactKeys(value, ["type", "executionId", "result"]);
      assertString(value.executionId, "executionId", 256);
      if (!isRecord(value.result) || typeof value.result.success !== "boolean") {
        throw protocolError("PLUGIN_PROTOCOL_INVALID", "Sandbox 执行结果不合法");
      }
      jsonBytes(value.result, "PLUGIN_PROTOCOL_INVALID", "Sandbox 执行结果");
      break;
    case "execution-error":
      assertExactKeys(value, ["type", "executionId", "error"]);
      assertString(value.executionId, "executionId", 256);
      assertError(value.error);
      break;
    case "cancel":
      assertExactKeys(value, ["type", "executionId"]);
      assertString(value.executionId, "executionId", 256);
      break;
  }
  return value as SandboxMessage;
}

export function normalizeSandboxError(error: unknown, fallbackCode = "PLUGIN_SANDBOX_FAILED"): SandboxErrorPayload {
  const coded = error as { code?: unknown; message?: unknown } | null;
  const code = typeof coded?.code === "string" && /^[A-Z0-9_]{1,128}$/.test(coded.code)
    ? coded.code
    : fallbackCode;
  const rawMessage = typeof coded?.message === "string" ? coded.message : "Sandbox 执行失败";
  return { code, message: rawMessage.replace(/[\r\n\t]+/g, " ").slice(0, 2000) || "Sandbox 执行失败" };
}
