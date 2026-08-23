import { pathToFileURL } from "node:url";

const pendingHostCalls = new Map();
let sequence = 0;
let plugin = null;
let activeExecutionId = null;

function send(message) {
  if (typeof process.send === "function") process.send(message);
}

function hostCall(method, args) {
  const callId = `${process.pid}-${++sequence}`;
  return new Promise((resolve, reject) => {
    pendingHostCalls.set(callId, { resolve, reject });
    send({ type: "host-call", callId, executionId: activeExecutionId, method, args });
  });
}

function namespace(prefix, methods) {
  return Object.fromEntries(methods.map((method) => [method, (args = {}) => hostCall(`${prefix}.${method}`, args)]));
}

const nowen = {
  notes: namespace("notes", ["get", "list", "create", "update"]),
  notebooks: namespace("notebooks", ["get", "list", "create"]),
  tags: namespace("tags", ["list", "create", "addToNote", "removeFromNote"]),
  tasks: namespace("tasks", ["get", "list", "create", "update"]),
  attachments: namespace("attachments", ["get", "list"]),
  diary: namespace("diary", ["get", "list", "create"]),
  mindmaps: namespace("mindmaps", ["get", "list", "create", "update"]),
  storage: namespace("storage", ["get", "set", "delete"]),
  external: namespace("external", ["fetch"]),
};

for (const level of ["log", "info", "warn", "error"]) {
  console[level] = (...parts) => send({
    type: "log",
    executionId: activeExecutionId,
    level: level === "log" ? "info" : level,
    message: parts.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" "),
  });
}

async function loadPlugin(mainPath) {
  const module = await import(`${pathToFileURL(mainPath).href}?worker=${Date.now()}`);
  plugin = module.default || module;
  if (!plugin || (typeof plugin.actions !== "object" && typeof plugin.execute !== "function")) {
    throw new Error("插件必须导出 actions 或 legacy execute 函数");
  }
  if (typeof plugin.activate === "function") await plugin.activate({ nowen });
}

process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "host-result") {
    const pending = pendingHostCalls.get(message.callId);
    if (!pending) return;
    pendingHostCalls.delete(message.callId);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message || "Host API 调用失败"), { code: message.error.code }));
    else pending.resolve(message.result);
    return;
  }
  if (message.type !== "execute") return;
  activeExecutionId = message.executionId;
  try {
    if (!plugin) await loadPlugin(message.mainPath);
    const action = plugin.actions?.[message.actionId];
    const result = typeof action === "function"
      ? await action({ input: message.input, nowen })
      : await plugin.execute({ userId: message.userId, workspaceId: message.workspaceId, log: console.info }, message.input);
    send({ type: "execution-result", executionId: message.executionId, result: result ?? { success: true } });
  } catch (error) {
    send({
      type: "execution-error",
      executionId: message.executionId,
      error: { message: error instanceof Error ? error.message : String(error), code: error?.code || "PLUGIN_EXECUTION_FAILED" },
    });
  } finally {
    activeExecutionId = null;
  }
});

process.on("disconnect", async () => {
  try { if (typeof plugin?.deactivate === "function") await plugin.deactivate(); } catch { /* host is gone */ }
  process.exit(0);
});

send({ type: "ready" });
