import { getQuickJS } from "quickjs-emscripten";

const LIMITS = Object.freeze({
  messageBytes: 2 * 1024 * 1024,
  hostCallArgsBytes: 256 * 1024,
  hostCallResultBytes: 1024 * 1024,
  hostCalls: 1000,
  pendingHostCalls: 32,
  progressEvents: 100,
  progressMessageChars: 500,
});

const PARENT_MESSAGE_TYPES = new Set(["preflight", "execute", "host-result", "cancel", "shutdown"]);
const CHILD_MESSAGE_TYPES = new Set(["booted", "ready", "host-call", "progress", "execution-result", "execution-error"]);
let active = null;
let shuttingDown = false;
let callSequence = 0;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox IPC 消息字段不合法");
  }
}

function assertString(value, label, max = 1024) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw codedError("PLUGIN_PROTOCOL_INVALID", `${label} 不合法`);
  }
}

function jsonBytes(value, code = "PLUGIN_PROTOCOL_INVALID", label = "Sandbox IPC 消息") {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw codedError(code, `${label} 必须是可序列化 JSON`);
  }
  if (serialized === undefined) throw codedError(code, `${label} 必须是可序列化 JSON`);
  return Buffer.byteLength(serialized, "utf8");
}

function assertError(value) {
  if (!isRecord(value)) throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox 错误对象不合法");
  assertExactKeys(value, ["code", "message"]);
  assertString(value.code, "Sandbox 错误码", 128);
  assertString(value.message, "Sandbox 错误消息", 2000);
}

function assertOptionalFiniteNumber(value, label) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw codedError("PLUGIN_PROTOCOL_INVALID", `${label} 不合法`);
  }
}

function assertMethods(value) {
  if (!Array.isArray(value) || value.length > 256) {
    throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox Host API 方法清单不合法");
  }
  const seen = new Set();
  for (const method of value) {
    if (typeof method !== "string" || !/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/.test(method) || seen.has(method)) {
      throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox Host API 方法清单不合法");
    }
    seen.add(method);
  }
}

function assertContext(value, executionId) {
  if (!isRecord(value)) throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox 执行上下文不合法");
  assertExactKeys(value, ["executionId", "pluginId", "actionId", "userId", "workspaceId"], [
    "source", "sourceId", "correlationId", "causationId", "depth", "idempotencyKey",
  ]);
  assertString(value.executionId, "context.executionId", 256);
  if (value.executionId !== executionId) throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox executionId 不一致");
  assertString(value.pluginId, "context.pluginId", 256);
  assertString(value.actionId, "context.actionId", 256);
  assertString(value.userId, "context.userId", 256);
  if (value.workspaceId !== null) assertString(value.workspaceId, "context.workspaceId", 256);
  if (value.source !== undefined && !["user", "plugin", "workflow", "sync", "system"].includes(value.source)) {
    throw codedError("PLUGIN_PROTOCOL_INVALID", "context.source 不合法");
  }
  for (const key of ["sourceId", "correlationId", "causationId", "idempotencyKey"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 512)) {
      throw codedError("PLUGIN_PROTOCOL_INVALID", `context.${key} 不合法`);
    }
  }
  if (value.depth !== undefined && (typeof value.depth !== "number" || !Number.isFinite(value.depth) || value.depth < 0)) {
    throw codedError("PLUGIN_PROTOCOL_INVALID", "context.depth 不合法");
  }
}

function validateParentMessage(value) {
  if (!isRecord(value)) throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox IPC 消息必须是对象");
  if (jsonBytes(value) > LIMITS.messageBytes) throw codedError("PLUGIN_PROTOCOL_MESSAGE_TOO_LARGE", "Sandbox IPC 消息超过 2MB");
  if (typeof value.type !== "string" || !PARENT_MESSAGE_TYPES.has(value.type)) {
    throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox IPC 消息类型或方向不合法");
  }
  if (value.type === "shutdown") {
    assertExactKeys(value, ["type"]);
    return value;
  }
  if (value.type === "cancel") {
    assertExactKeys(value, ["type", "executionId"]);
    assertString(value.executionId, "executionId", 256);
    return value;
  }
  if (value.type === "host-result") {
    assertExactKeys(value, ["type", "executionId", "callId"], ["result", "error"]);
    assertString(value.executionId, "executionId", 256);
    assertString(value.callId, "callId", 256);
    const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
    const hasError = Object.prototype.hasOwnProperty.call(value, "error");
    if (hasResult === hasError) throw codedError("PLUGIN_PROTOCOL_INVALID", "Host API 结果必须且只能包含 result 或 error");
    if (hasError) assertError(value.error);
    if (hasResult && jsonBytes(value.result, "PLUGIN_PROTOCOL_HOST_RESULT_TOO_LARGE", "Host API 结果") > LIMITS.hostCallResultBytes) {
      throw codedError("PLUGIN_PROTOCOL_HOST_RESULT_TOO_LARGE", "Host API 结果超过 1MB");
    }
    return value;
  }
  if (value.type === "preflight") {
    assertExactKeys(value, ["type", "executionId", "source", "filename", "actionIds", "methods", "timeoutMs"]);
    assertString(value.executionId, "executionId", 256);
    assertString(value.source, "Sandbox 源码", LIMITS.messageBytes);
    assertString(value.filename, "Sandbox 文件名", 1024);
    if (!Array.isArray(value.actionIds) || value.actionIds.some((item) => typeof item !== "string" || item.length === 0 || item.length > 256)) {
      throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox Action 清单不合法");
    }
    assertMethods(value.methods);
    if (!Number.isFinite(value.timeoutMs) || value.timeoutMs < 1) throw codedError("PLUGIN_PROTOCOL_INVALID", "timeoutMs 不合法");
    return value;
  }
  assertExactKeys(value, ["type", "executionId", "source", "filename", "actionId", "methods", "input", "context", "timeoutMs"]);
  assertString(value.executionId, "executionId", 256);
  assertString(value.source, "Sandbox 源码", LIMITS.messageBytes);
  assertString(value.filename, "Sandbox 文件名", 1024);
  assertString(value.actionId, "actionId", 256);
  assertMethods(value.methods);
  if (!isRecord(value.input)) {
    throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox 执行负载不合法");
  }
  jsonBytes(value.input, "PLUGIN_PROTOCOL_INVALID", "Sandbox 输入");
  assertContext(value.context, value.executionId);
  if (!Number.isFinite(value.timeoutMs) || value.timeoutMs < 1) throw codedError("PLUGIN_PROTOCOL_INVALID", "timeoutMs 不合法");
  return value;
}

function validateChildMessage(value) {
  if (!isRecord(value) || typeof value.type !== "string" || !CHILD_MESSAGE_TYPES.has(value.type)) {
    throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox 子进程消息类型不合法");
  }
  const bytes = jsonBytes(value);
  if (bytes > LIMITS.messageBytes) throw codedError("PLUGIN_PROTOCOL_MESSAGE_TOO_LARGE", "Sandbox IPC 消息超过 2MB");
  if (value.type === "booted") {
    assertExactKeys(value, ["type"]);
  } else if (value.type === "ready") {
    assertExactKeys(value, ["type", "executionId", "ok"], ["error"]);
    assertString(value.executionId, "executionId", 256);
    if (typeof value.ok !== "boolean") throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox ready 状态不合法");
    if (!value.ok) assertError(value.error);
    else if (value.error !== undefined) throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox ready 成功消息不能携带错误");
  } else if (value.type === "host-call") {
    assertExactKeys(value, ["type", "executionId", "callId", "method", "args"]);
    assertString(value.executionId, "executionId", 256);
    assertString(value.callId, "callId", 256);
    assertString(value.method, "Host API 方法", 256);
    if (!/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/.test(value.method)) {
      throw codedError("PLUGIN_PROTOCOL_METHOD_UNSUPPORTED", "Host API 方法名不合法");
    }
    if (jsonBytes(value.args, "PLUGIN_PROTOCOL_HOST_ARGS_TOO_LARGE", "Host API 参数") > LIMITS.hostCallArgsBytes) {
      throw codedError("PLUGIN_PROTOCOL_HOST_ARGS_TOO_LARGE", "Host API 参数超过 256KB");
    }
  } else if (value.type === "progress") {
    assertExactKeys(value, ["type", "executionId"], ["current", "total", "message"]);
    assertString(value.executionId, "executionId", 256);
    assertOptionalFiniteNumber(value.current, "progress.current");
    assertOptionalFiniteNumber(value.total, "progress.total");
    if (value.message !== undefined && (typeof value.message !== "string" || value.message.length > LIMITS.progressMessageChars)) {
      throw codedError("PLUGIN_PROTOCOL_INVALID", "progress.message 不合法");
    }
  } else if (value.type === "execution-result") {
    assertExactKeys(value, ["type", "executionId", "result"]);
    assertString(value.executionId, "executionId", 256);
    if (!isRecord(value.result) || typeof value.result.success !== "boolean") {
      throw codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox 执行结果不合法");
    }
  } else if (value.type === "execution-error") {
    assertExactKeys(value, ["type", "executionId", "error"]);
    assertString(value.executionId, "executionId", 256);
    assertError(value.error);
  }
  return value;
}

function normalizeError(error, fallbackCode = "PLUGIN_SANDBOX_FAILED") {
  let code = typeof error?.code === "string" && /^[A-Z0-9_]{1,128}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const rawMessage = error instanceof Error ? error.message : typeof error?.message === "string" ? error.message : "Sandbox 执行失败";
  if (active?.cancelled) {
    code = active.cancelReason === "timeout"
      ? "PLUGIN_TIMEOUT"
      : active.cancelReason === "cancel"
        ? "PLUGIN_CANCELLED"
        : "PLUGIN_SANDBOX_FAILED";
  }
  else if (/out of memory|memory limit|allocation failed|cannot allocate/i.test(rawMessage)) code = "PLUGIN_MEMORY_LIMIT";
  else if (/interrupted/i.test(rawMessage) || Date.now() >= (active?.deadline || Number.POSITIVE_INFINITY)) code = "PLUGIN_TIMEOUT";
  return {
    code,
    message: rawMessage.replace(/[\r\n\t]+/g, " ").slice(0, 2000) || "Sandbox 执行失败",
  };
}

function send(message) {
  try {
    if (jsonBytes(message) > LIMITS.messageBytes) return false;
    validateChildMessage(message);
    if (typeof process.send !== "function" || !process.connected) return false;
    process.send(message, (error) => {
      if (error) {
        cancelActive("crash");
        setImmediate(() => process.exit(1));
      }
    });
    return true;
  } catch {
    return false;
  }
}

function sendExecutionError(executionId, error, fallbackCode) {
  const payload = { type: "execution-error", executionId, error: normalizeError(error, fallbackCode) };
  if (!send(payload)) {
    send({
      type: "execution-error",
      executionId,
      error: { code: "PLUGIN_SANDBOX_FAILED", message: "Sandbox 返回消息超过协议限制" },
    });
  }
}

function rejectDeferred(vm, deferred, message) {
  const handle = vm.newError(message.message);
  try {
    const codeHandle = vm.newString(message.code);
    try { vm.setProp(handle, "code", codeHandle); } finally { codeHandle.dispose(); }
    deferred.reject(handle);
  } finally {
    handle.dispose();
  }
}

function driveJobs(operation, suppressErrors = false) {
  try {
    const result = operation.runtime.executePendingJobs();
    try {
      if (result.error) operation.vm.unwrapResult(result);
    } finally {
      result.dispose();
    }
  } catch (error) {
    if (!suppressErrors) throw error;
  }
}

function cancelActive(reason) {
  if (!active) return;
  active.cancelled = true;
  active.cancelReason = reason;
  for (const pending of active.pendingHostCalls.values()) {
    rejectDeferred(active.vm, pending.deferred, {
      code: reason === "timeout" ? "PLUGIN_TIMEOUT" : reason === "cancel" ? "PLUGIN_CANCELLED" : "PLUGIN_SANDBOX_FAILED",
      message: reason === "timeout" ? "Sandbox execution interrupted" : reason === "cancel" ? "Sandbox execution cancelled" : "Sandbox IPC failed",
    });
  }
  active.pendingHostCalls.clear();
  driveJobs(active, true);
}

function buildBridge(methods) {
  return `
(() => {
  const __host = globalThis.__nowenHostCall;
  const __progress = globalThis.__nowenProgress;
  const __call = (method, args) => __host(method, JSON.stringify(args ?? {})).then(JSON.parse);
  const __root = Object.create(null);
  for (const __fullMethod of ${JSON.stringify(methods)}) {
    const __separator = __fullMethod.indexOf('.');
    const __namespace = __fullMethod.slice(0, __separator);
    const __method = __fullMethod.slice(__separator + 1);
    const __target = __root[__namespace] || (__root[__namespace] = Object.create(null));
    Object.defineProperty(__target, __method, {
      value: (args = {}) => __call(__fullMethod, args), enumerable: true, writable: false, configurable: false
    });
  }
  for (const __target of Object.values(__root)) Object.freeze(__target);
  Object.defineProperty(__root, 'progress', {
    value: (value = {}) => __progress(JSON.stringify(value)), enumerable: true, writable: false, configurable: false
  });
  Object.freeze(__root);
  Object.defineProperty(globalThis, 'nowen', { value: __root, enumerable: true, writable: false, configurable: false });
  for (const __name of ['process', 'require', 'fetch', 'Buffer', 'WebSocket', 'XMLHttpRequest', 'module', 'exports']) {
    Object.defineProperty(globalThis, __name, { value: undefined, writable: false, configurable: false });
  }
  Object.defineProperty(globalThis, 'eval', { value: undefined, writable: false, configurable: false });
  Object.defineProperty(globalThis, 'Function', { value: undefined, writable: false, configurable: false });
  try { Object.defineProperty((async function(){}).constructor.prototype, 'constructor', { value: undefined }); } catch {}
  try { Object.defineProperty((function(){}).constructor.prototype, 'constructor', { value: undefined }); } catch {}
  delete globalThis.__nowenHostCall;
  delete globalThis.__nowenProgress;
})();`;
}

async function createSandbox(message, kind) {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const operation = {
    executionId: message.executionId,
    kind,
    methods: new Set(message.methods),
    runtime,
    vm: null,
    pendingHostCalls: new Map(),
    totalHostCalls: 0,
    progressEvents: 0,
    cancelled: false,
    cancelReason: null,
    deadline: Date.now() + Math.max(1, Math.floor(message.timeoutMs)),
  };
  active = operation;
  runtime.setInterruptHandler(() => operation.cancelled || Date.now() >= operation.deadline);
  const vm = runtime.newContext();
  operation.vm = vm;

  const hostCall = vm.newFunction("__nowenHostCall", (methodHandle, argsHandle) => {
    const deferred = vm.newPromise();
    try {
      if (operation.cancelled) throw codedError("PLUGIN_CANCELLED", "Sandbox execution cancelled");
      const method = vm.getString(methodHandle);
      const argsText = vm.getString(argsHandle);
      if (!operation.methods.has(method)) throw codedError("PLUGIN_PROTOCOL_METHOD_UNSUPPORTED", `Host API 方法不受支持: ${method}`);
      if (Buffer.byteLength(argsText, "utf8") > LIMITS.hostCallArgsBytes) {
        throw codedError("PLUGIN_PROTOCOL_HOST_ARGS_TOO_LARGE", "Host API 参数超过 256KB");
      }
      const args = JSON.parse(argsText);
      if (++operation.totalHostCalls > LIMITS.hostCalls) {
        throw codedError("PLUGIN_PROTOCOL_LIMIT_EXCEEDED", "Host API 调用次数超过 1000");
      }
      if (operation.pendingHostCalls.size >= LIMITS.pendingHostCalls) {
        throw codedError("PLUGIN_PROTOCOL_LIMIT_EXCEEDED", "并发 Host API 调用超过 32");
      }
      const callId = `${operation.executionId}:${++callSequence}`;
      operation.pendingHostCalls.set(callId, { deferred });
      if (!send({ type: "host-call", executionId: operation.executionId, callId, method, args })) {
        operation.pendingHostCalls.delete(callId);
        operation.cancelled = true;
        operation.cancelReason = "crash";
        throw codedError("PLUGIN_SANDBOX_FAILED", "Host API IPC 发送失败");
      }
    } catch (error) {
      rejectDeferred(vm, deferred, normalizeError(error));
    }
    return deferred.handle;
  });
  vm.setProp(vm.global, "__nowenHostCall", hostCall);
  hostCall.dispose();

  const progress = vm.newFunction("__nowenProgress", (valueHandle) => {
    try {
      if (++operation.progressEvents > LIMITS.progressEvents) {
        throw codedError("PLUGIN_PROTOCOL_LIMIT_EXCEEDED", "进度事件超过 100");
      }
      const raw = JSON.parse(vm.getString(valueHandle));
      const value = isRecord(raw) ? raw : {};
      const messageText = typeof value.message === "string" ? value.message.slice(0, LIMITS.progressMessageChars) : undefined;
      const current = Number.isFinite(Number(value.current)) ? Math.max(0, Math.floor(Number(value.current))) : undefined;
      const total = Number.isFinite(Number(value.total)) ? Math.max(0, Math.floor(Number(value.total))) : undefined;
      if (!send({ type: "progress", executionId: operation.executionId, current, total, message: messageText })) {
        operation.cancelled = true;
        operation.cancelReason = "crash";
        throw codedError("PLUGIN_SANDBOX_FAILED", "进度 IPC 发送失败");
      }
    } catch (error) {
      throw error;
    }
  });
  vm.setProp(vm.global, "__nowenProgress", progress);
  progress.dispose();

  const loaded = vm.evalCode(
    `${buildBridge(message.methods)}\n${message.source}\n;if(!globalThis.__nowenPluginModule) throw new Error('sandbox bundle must define globalThis.__nowenPluginModule');`,
    message.filename,
  );
  vm.unwrapResult(loaded).dispose();
  return operation;
}

async function disposeOperation(operation) {
  if (!operation) return;
  for (const pending of operation.pendingHostCalls.values()) {
    try {
      rejectDeferred(operation.vm, pending.deferred, { code: "PLUGIN_SANDBOX_FAILED", message: "Sandbox execution closed" });
    } catch { /* Context 正在释放 */ }
  }
  operation.pendingHostCalls.clear();
  driveJobs(operation, true);
  try { operation.vm?.dispose(); } catch { /* 已释放 */ }
  try { operation.runtime?.dispose(); } catch { /* 已释放 */ }
  if (active === operation) active = null;
}

async function runPreflight(message) {
  let operation;
  try {
    operation = await createSandbox(message, "preflight");
    const check = operation.vm.evalCode(`(() => {
      const root = globalThis.__nowenPluginModule;
      const plugin = root.default || root;
      const actions = plugin.actions || plugin;
      return ${JSON.stringify(message.actionIds)}.every((id) => typeof actions[id] === 'function');
    })()`);
    const handle = operation.vm.unwrapResult(check);
    const valid = operation.vm.dump(handle) === true;
    handle.dispose();
    if (!valid) throw codedError("PLUGIN_ACTION_MISMATCH", "Sandbox bundle 缺少声明的 Action");
    send({ type: "ready", executionId: message.executionId, ok: true });
  } catch (error) {
    send({ type: "ready", executionId: message.executionId, ok: false, error: normalizeError(error, "PLUGIN_PREFLIGHT_FAILED") });
  } finally {
    await disposeOperation(operation || active);
    if (shuttingDown) process.exit(0);
  }
}

async function runExecution(message) {
  let operation;
  let promiseHandle;
  try {
    operation = await createSandbox(message, "execute");
    const actionId = JSON.stringify(message.actionId);
    const input = JSON.stringify(message.input);
    const execution = JSON.stringify({ ...message.context, id: message.executionId, executionId: message.executionId });
    const evaluation = operation.vm.evalCode(`(async () => {
      const root = globalThis.__nowenPluginModule;
      const plugin = root.default || root;
      const action = (plugin.actions && plugin.actions[${actionId}]) || plugin[${actionId}];
      if (typeof action !== 'function') throw new Error('Action 不存在');
      const value = await action({ input: ${input}, nowen: globalThis.nowen, execution: ${execution} });
      return JSON.stringify(value === undefined ? { success: true } : value);
    })()`);
    promiseHandle = operation.vm.unwrapResult(evaluation);
    const resolvedPromise = operation.vm.resolvePromise(promiseHandle);
    driveJobs(operation);
    const resolved = await resolvedPromise;
    const valueHandle = operation.vm.unwrapResult(resolved);
    const serialized = operation.vm.getString(valueHandle);
    valueHandle.dispose();
    const value = JSON.parse(serialized || "null");
    const result = value && typeof value === "object" && typeof value.success === "boolean"
      ? value
      : { success: true, data: value };
    if (!send({ type: "execution-result", executionId: message.executionId, result })) {
      throw codedError("PLUGIN_SANDBOX_FAILED", "Sandbox 执行结果超过协议限制");
    }
  } catch (error) {
    sendExecutionError(message.executionId, error, "PLUGIN_SANDBOX_FAILED");
  } finally {
    try { promiseHandle?.dispose(); } catch { /* 已释放 */ }
    await disposeOperation(operation || active);
    if (shuttingDown) process.exit(0);
  }
}

function settleHostResult(message) {
  const operation = active;
  if (!operation || operation.executionId !== message.executionId) return;
  const pending = operation.pendingHostCalls.get(message.callId);
  if (!pending) return;
  operation.pendingHostCalls.delete(message.callId);
  try {
    if (message.error) {
      rejectDeferred(operation.vm, pending.deferred, message.error);
    } else {
      const serialized = JSON.stringify(message.result ?? null);
      const handle = operation.vm.newString(serialized);
      try { pending.deferred.resolve(handle); } finally { handle.dispose(); }
    }
    driveJobs(operation);
  } catch {
    cancelActive("crash");
  }
}

process.on("message", (rawMessage) => {
  let message;
  try {
    message = validateParentMessage(rawMessage);
  } catch (error) {
    if (active) sendExecutionError(active.executionId, error, "PLUGIN_PROTOCOL_INVALID");
    cancelActive("crash");
    setImmediate(() => process.exit(1));
    return;
  }
  if (message.type === "host-result") {
    settleHostResult(message);
    return;
  }
  if (message.type === "cancel") {
    if (active?.executionId === message.executionId) cancelActive("cancel");
    return;
  }
  if (message.type === "shutdown") {
    shuttingDown = true;
    cancelActive("cancel");
    if (!active) process.exit(0);
    return;
  }
  if (active) {
    sendExecutionError(message.executionId, codedError("PLUGIN_PROTOCOL_INVALID", "Sandbox 不允许并发执行"));
    return;
  }
  if (message.type === "preflight") void runPreflight(message);
  else void runExecution(message);
});

process.on("disconnect", () => {
  shuttingDown = true;
  cancelActive("cancel");
  if (!active) process.exit(0);
});

process.on("uncaughtException", (error) => {
  if (active) sendExecutionError(active.executionId, error, "PLUGIN_SANDBOX_FAILED");
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  if (active) sendExecutionError(active.executionId, error, "PLUGIN_SANDBOX_FAILED");
  process.exit(1);
});

send({ type: "booted" });
