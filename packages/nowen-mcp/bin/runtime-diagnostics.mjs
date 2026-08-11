import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const EXIT_CODES = Object.freeze({
  CONFIG: 64,
  ENTRY_NOT_FOUND: 66,
  SOFTWARE: 70,
  IO: 74,
});

export class StartupDiagnosticError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "StartupDiagnosticError";
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT_CODES.SOFTWARE;
    this.suggestion = options.suggestion ?? "查看 stderr 中的错误详情和堆栈";
  }
}

export function formatError(error) {
  if (error instanceof Error) {
    const formatted = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    if (typeof error.code === "string") formatted.code = error.code;
    if (error.cause !== undefined) formatted.cause = formatError(error.cause);
    return formatted;
  }
  return { name: "NonErrorThrown", message: String(error) };
}

export function createStructuredLogger(options = {}) {
  const stream = options.stream ?? process.stderr;
  const base = options.base ?? {};
  return (level, event, details = {}) => {
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...base,
      ...details,
    };
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) delete payload[key];
    }
    try {
      stream.write(`[nowen-mcp] ${JSON.stringify(payload)}\n`);
    } catch {
      // stderr may already be closed by the parent process.
    }
  };
}

export function parseHeartbeatMs(rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value || value === "0" || value.toLowerCase() === "off") return 0;
  if (!/^\d+$/.test(value)) {
    throw new StartupDiagnosticError(
      "INVALID_HEARTBEAT_INTERVAL",
      "NOWEN_MCP_HEARTBEAT_MS 必须是整数毫秒、0 或 off",
      {
        exitCode: EXIT_CODES.CONFIG,
        suggestion: "删除该变量以关闭心跳，或设置为不小于 10000 的整数",
      },
    );
  }
  const heartbeatMs = Number(value);
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10_000 || heartbeatMs > 86_400_000) {
    throw new StartupDiagnosticError(
      "INVALID_HEARTBEAT_INTERVAL",
      "NOWEN_MCP_HEARTBEAT_MS 必须在 10000 到 86400000 毫秒之间",
      {
        exitCode: EXIT_CODES.CONFIG,
        suggestion: "推荐调试时设置 NOWEN_MCP_HEARTBEAT_MS=300000",
      },
    );
  }
  return heartbeatMs;
}

export function validateRuntimeConfig(options = {}) {
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new StartupDiagnosticError(
      "UNSUPPORTED_NODE_VERSION",
      `nowen-mcp 需要 Node.js 20 或更高版本，当前为 ${nodeVersion}`,
      {
        exitCode: EXIT_CODES.CONFIG,
        suggestion: "安装 Node.js 20、22 或 24 后重新启动 MCP 客户端",
      },
    );
  }

  const rawTargetUrl = String(env.NOWEN_URL || "http://localhost:3001").trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(rawTargetUrl);
  } catch (error) {
    throw new StartupDiagnosticError(
      "INVALID_NOWEN_URL",
      `NOWEN_URL 不是有效 URL: ${rawTargetUrl}`,
      {
        exitCode: EXIT_CODES.CONFIG,
        suggestion: "设置为可访问的 http:// 或 https:// Nowen Note 地址",
        cause: error,
      },
    );
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new StartupDiagnosticError(
      "INVALID_NOWEN_URL_PROTOCOL",
      `NOWEN_URL 仅支持 http 或 https，当前为 ${parsedUrl.protocol}`,
      {
        exitCode: EXIT_CODES.CONFIG,
        suggestion: "例如设置 NOWEN_URL=http://192.168.1.20:3001",
      },
    );
  }

  parsedUrl.username = "";
  parsedUrl.password = "";
  const targetUrl = parsedUrl.toString().replace(/\/$/, "");
  return {
    targetUrl,
    heartbeatMs: parseHeartbeatMs(env.NOWEN_MCP_HEARTBEAT_MS),
    authMode: env.NOWEN_API_TOKEN ? "api-token" : "username-password",
  };
}

export function classifyStartupError(error, options = {}) {
  if (error instanceof StartupDiagnosticError) {
    return {
      code: error.code,
      message: error.message,
      suggestion: error.suggestion,
      exitCode: error.exitCode,
      error: formatError(error),
    };
  }

  const entryPath = options.entryPath ?? "";
  const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const formatted = formatError(error);
  const errorCode = formatted.code ?? "";
  const moduleMissing = errorCode === "ERR_MODULE_NOT_FOUND"
    || errorCode === "MODULE_NOT_FOUND"
    || /cannot find (?:package|module)/i.test(formatted.message);

  if (moduleMissing) {
    if (entryPath && !existsSync(entryPath)) {
      return {
        code: "ENTRY_NOT_FOUND",
        message: `找不到 MCP 构建入口: ${entryPath}`,
        suggestion: `在 ${packageRoot} 执行 npm install && npm run build`,
        exitCode: EXIT_CODES.ENTRY_NOT_FOUND,
        error: formatted,
      };
    }
    return {
      code: "DEPENDENCY_NOT_FOUND",
      message: "MCP 入口存在，但运行依赖或编译产物不完整",
      suggestion: `在 ${packageRoot} 执行 npm install && npm run build，然后完全重启 MCP 客户端`,
      exitCode: EXIT_CODES.SOFTWARE,
      error: formatted,
    };
  }

  return {
    code: "STARTUP_IMPORT_FAILED",
    message: "nowen-mcp 初始化失败",
    suggestion: "查看 error.stack；确认依赖已安装、构建已完成且 Node.js 版本受支持",
    exitCode: EXIT_CODES.SOFTWARE,
    error: formatted,
  };
}

export function installLifecycleObservers(options = {}) {
  const logger = options.logger ?? createStructuredLogger();
  const heartbeatMs = options.heartbeatMs ?? 0;
  let terminating = false;
  let exitReason = "running";
  let heartbeatTimer = null;
  let forcedExitTimer = null;

  const stderrErrorHandler = () => {};
  process.stderr.on("error", stderrErrorHandler);

  const stopHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const terminate = (event, exitCode, details = {}) => {
    if (terminating) return;
    terminating = true;
    exitReason = event;
    stopHeartbeat();
    logger(exitCode === 0 ? "info" : "error", event, {
      exitCode,
      uptimeMs: Math.round(process.uptime() * 1000),
      ...details,
    });
    process.exitCode = exitCode;
    forcedExitTimer = setTimeout(() => process.exit(exitCode), 25);
  };

  const onUncaughtException = (error) => terminate(
    "uncaught_exception",
    EXIT_CODES.SOFTWARE,
    { error: formatError(error) },
  );
  const onUnhandledRejection = (reason) => terminate(
    "unhandled_rejection",
    EXIT_CODES.SOFTWARE,
    { error: formatError(reason) },
  );
  const onSigint = () => terminate("shutdown_signal", 0, { signal: "SIGINT" });
  const onSigterm = () => terminate("shutdown_signal", 0, { signal: "SIGTERM" });
  const onStdinEnd = () => terminate("stdin_closed", 0, { source: "end" });
  const onStdinClose = () => terminate("stdin_closed", 0, { source: "close" });
  const onStdinError = (error) => terminate(
    "stdin_error",
    EXIT_CODES.IO,
    { error: formatError(error) },
  );
  const onDisconnect = () => terminate("parent_disconnected", 0);
  const onWarning = (warning) => logger("warn", "process_warning", {
    warning: formatError(warning),
  });
  const onBeforeExit = (code) => logger("info", "before_exit", {
    code,
    exitReason,
    uptimeMs: Math.round(process.uptime() * 1000),
  });
  const onExit = (code) => logger("info", "process_exit", {
    code,
    exitReason,
    uptimeMs: Math.round(process.uptime() * 1000),
  });

  process.once("uncaughtException", onUncaughtException);
  process.once("unhandledRejection", onUnhandledRejection);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.stdin.once("end", onStdinEnd);
  process.stdin.once("close", onStdinClose);
  process.stdin.once("error", onStdinError);
  process.once("disconnect", onDisconnect);
  process.on("warning", onWarning);
  process.once("beforeExit", onBeforeExit);
  process.once("exit", onExit);

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      const memory = process.memoryUsage();
      logger("debug", "heartbeat", {
        uptimeMs: Math.round(process.uptime() * 1000),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      });
    }, heartbeatMs);
    heartbeatTimer.unref();
  }

  return {
    setExitReason(reason) {
      exitReason = reason;
    },
    cleanup() {
      stopHeartbeat();
      if (forcedExitTimer) clearTimeout(forcedExitTimer);
      process.stderr.off("error", stderrErrorHandler);
      process.off("uncaughtException", onUncaughtException);
      process.off("unhandledRejection", onUnhandledRejection);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.stdin.off("end", onStdinEnd);
      process.stdin.off("close", onStdinClose);
      process.stdin.off("error", onStdinError);
      process.off("disconnect", onDisconnect);
      process.off("warning", onWarning);
      process.off("beforeExit", onBeforeExit);
      process.off("exit", onExit);
    },
  };
}

export async function runLauncher(options = {}) {
  const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const entryPath = options.entryPath ?? path.join(packageRoot, "dist", "scoped-entry.js");
  const logger = options.logger ?? createStructuredLogger({
    base: {
      pid: process.pid,
      ppid: process.ppid,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
  });
  let lifecycle = null;

  try {
    const config = validateRuntimeConfig(options);
    logger("info", "startup_begin", {
      cwd: process.cwd(),
      packageRoot,
      entryPath,
      targetUrl: config.targetUrl,
      authMode: config.authMode,
      heartbeatMs: config.heartbeatMs,
    });

    if (!existsSync(entryPath)) {
      throw new StartupDiagnosticError(
        "ENTRY_NOT_FOUND",
        `找不到 MCP 构建入口: ${entryPath}`,
        {
exitCode: EXIT_CODES.ENTRY_NOT_FOUND,
suggestion: `在 ${packageRoot} 执行 npm install && npm run build`,
        },
      );
    }

    lifecycle = installLifecycleObservers({
      logger,
      heartbeatMs: config.heartbeatMs,
    });
    await import(pathToFileURL(entryPath).href);
    logger("info", "startup_ready", {
      entryPath,
      targetUrl: config.targetUrl,
      uptimeMs: Math.round(process.uptime() * 1000),
    });
    return 0;
  } catch (error) {
    lifecycle?.setExitReason("startup_failed");
    const failure = classifyStartupError(error, { entryPath, packageRoot });
    logger("error", "startup_failed", failure);
    return failure.exitCode;
  }
}
