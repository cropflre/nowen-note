// electron/logger.js
// 日志落地（按日期轮转）+ 崩溃上报（crashReporter + uncaughtException / unhandledRejection）。
// 日志目录：<userData>/logs/   示例：
//   %APPDATA%/Nowen Note/logs/main-2026-04-23.log
//   %APPDATA%/Nowen Note/logs/crash/<guid>.dmp
//
// 不依赖 electron-log / winston，保持零新增依赖；必要时可升级。

const { app, crashReporter } = require("electron");
const fs = require("fs");
const path = require("path");

let initialized = false;
let logStream = null;
let currentDay = "";
let logDir = "";
let crashDir = "";

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timestamp() {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(
      d.getMilliseconds()
    ).padStart(3, "0")}`
  );
}

function ensureStream() {
  const day = today();
  if (logStream && day === currentDay) return logStream;
  if (logStream) {
    try {
      logStream.end();
    } catch {
      /* ignore */
    }
  }
  currentDay = day;
  const file = path.join(logDir, `main-${day}.log`);
  logStream = fs.createWriteStream(file, { flags: "a" });
  return logStream;
}

/** 删除 14 天前的日志文件 */
function rotate(maxDays = 14) {
  try {
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(logDir)) {
      if (!name.startsWith("main-") || !name.endsWith(".log")) continue;
      const full = path.join(logDir, name);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch {
    /* ignore */
  }
}

function write(level, args) {
  try {
    const stream = ensureStream();
    const msg = args
      .map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === "object") {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(" ");
    stream.write(`[${timestamp()}] [${level}] ${msg}\n`);
  } catch {
    /* 写日志失败不再递归报错 */
  }
}

function patchConsole() {
  const origLog = console.log.bind(console);
  const origInfo = console.info.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...a) => {
    write("INFO", a);
    origLog(...a);
  };
  console.info = (...a) => {
    write("INFO", a);
    origInfo(...a);
  };
  console.warn = (...a) => {
    write("WARN", a);
    origWarn(...a);
  };
  console.error = (...a) => {
    write("ERROR", a);
    origError(...a);
  };
}

/**
 * 初始化日志 + 崩溃上报。
 * 必须在 app.whenReady() 之前调用 crashReporter.start（官方推荐）。
 * @param {{ crashSubmitURL?: string, uploadCrashes?: boolean }} [opts]
 */
function initLogger(opts = {}) {
  if (initialized) return;
  initialized = true;

  const userData =
    app.getPath("userData") || path.join(require("os").tmpdir(), "nowen-note");
  logDir = path.join(userData, "logs");
  crashDir = path.join(logDir, "crash");

  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(crashDir, { recursive: true });
  } catch (e) {
    // 目录创建失败时，降级到临时目录
    logDir = path.join(require("os").tmpdir(), "nowen-note-logs");
    crashDir = path.join(logDir, "crash");
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.mkdirSync(crashDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  // 崩溃上报：未配置上报服务器时，仅本地落地 .dmp
  // Electron 要求 start() 必须调用才能产生 minidump；uploadToServer=false 时不会外发。
  try {
    crashReporter.start({
      productName: "Nowen Note",
      companyName: "Nowen",
      submitURL: opts.crashSubmitURL || "https://example.invalid/submit",
      uploadToServer: !!opts.uploadCrashes && !!opts.crashSubmitURL,
      ignoreSystemCrashHandler: false,
      compress: true,
    });

    // 把 minidump 放到 userData/logs/crash/（Electron 16+ 支持通过 app.setPath 修改）
    try {
      app.setPath("crashDumps", crashDir);
    } catch {
      /* older electron ignores */
    }
  } catch (e) {
    // crashReporter 初始化失败不阻塞启动
    write("WARN", ["[logger] crashReporter.start failed:", e?.message || e]);
  }

  rotate(14);
  patchConsole();

  // 捕获未处理异常 / Promise 拒绝
  process.on("uncaughtException", (err) => {
    write("FATAL", ["uncaughtException:", err]);
  });
  process.on("unhandledRejection", (reason) => {
    write("FATAL", ["unhandledRejection:", reason]);
  });

  write("INFO", [
    `===== Nowen Note 启动 v${app.getVersion()} platform=${process.platform} arch=${process.arch} =====`,
  ]);
}

function getLogDir() {
  return logDir;
}

function getCrashDir() {
  return crashDir;
}

module.exports = { initLogger, getLogDir, getCrashDir };
