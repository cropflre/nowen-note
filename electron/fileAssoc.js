// electron/fileAssoc.js
// 文件关联：处理"双击 .md / 命令行参数 / macOS open-file"打开外部 Markdown 文件。
// 流程：
//   1. 进程启动或 second-instance 时，从命令行收集 *.md 文件路径
//   2. macOS 的 "open-file" 事件单独处理
//   3. 把文件内容读出来，通过 IPC("file:open") 发给 renderer，让前端把它作为外部文档打开
// 前端需自行侦听：window.nowenDesktop.on("file:open", ({ path, name, content }) => ...)

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const MAX_BYTES = 10 * 1024 * 1024; // 10MB 安全上限
const VALID_EXT = new Set([".md", ".markdown", ".txt"]);

const pendingFiles = []; // 窗口就绪前先暂存

function isMarkdownArg(arg) {
  if (!arg || typeof arg !== "string") return false;
  if (arg.startsWith("-")) return false;
  const ext = path.extname(arg).toLowerCase();
  return VALID_EXT.has(ext);
}

function pickFilesFromArgv(argv) {
  // argv[0] 在打包后是 exe 路径；electron dev 下前几个可能是 electron/main.js
  // 直接过滤 *.md / *.txt 后缀
  return (argv || []).filter(isMarkdownArg);
}

function readFileSafe(filePath) {
  try {
    const abs = path.resolve(filePath);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_BYTES) {
      console.warn("[fileAssoc] file too large, skipped:", abs, stat.size);
      return null;
    }
    const content = fs.readFileSync(abs, "utf8");
    return {
      path: abs,
      name: path.basename(abs),
      size: stat.size,
      content,
    };
  } catch (e) {
    console.warn("[fileAssoc] read failed:", filePath, e?.message || e);
    return null;
  }
}

function sendToRenderer(getMainWindow, payload) {
  const win = getMainWindow?.();
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isLoading()) {
    win.webContents.send("file:open", payload);
  } else {
    pendingFiles.push(payload);
  }
}

/**
 * 消费启动时 / second-instance 传入的文件参数。
 * 应在主窗口就绪后和 app.on("second-instance") 中调用。
 */
function handleArgv(argv, getMainWindow) {
  const files = pickFilesFromArgv(argv);
  for (const f of files) {
    const payload = readFileSafe(f);
    if (payload) sendToRenderer(getMainWindow, payload);
  }
}

/** macOS：open-file 事件（拖到 dock / Finder 双击） */
function setupMacOpenFile(getMainWindow) {
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    const payload = readFileSafe(filePath);
    if (payload) sendToRenderer(getMainWindow, payload);
  });
}

/** 主窗口 did-finish-load 时调用，冲刷 pending 队列 */
function flushPending(win) {
  if (!win || win.isDestroyed()) return;
  while (pendingFiles.length) {
    const p = pendingFiles.shift();
    win.webContents.send("file:open", p);
  }
}

module.exports = {
  handleArgv,
  setupMacOpenFile,
  flushPending,
};
