const { app, BrowserWindow, shell, dialog, ipcMain } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const http = require("http");
const crypto = require("crypto");

const { buildMenu } = require("./menu");
const { createTray, destroyTray, markQuitting, getIsQuitting } = require("./tray");
const { initAutoUpdater, checkForUpdatesManually } = require("./updater");
const { initLogger, getLogDir } = require("./logger");
const { handleArgv, setupMacOpenFile, flushPending } = require("./fileAssoc");
const { registerDiscoveryIpc, shutdown: shutdownDiscovery } = require("./discovery");

// 日志 & 崩溃上报需尽早初始化（crashReporter.start 建议在 ready 之前）
initLogger({
  // 如需接入外部崩溃上报服务（如 Sentry/Bugsnag/自建 collector），填入 URL 并设置 uploadCrashes=true
  // crashSubmitURL: process.env.NOWEN_CRASH_URL,
  // uploadCrashes: true,
});

let mainWindow = null;
let splashWindow = null;
let backendProcess = null;
let backendPort = 0;

// ---------- 单实例锁（防止多开损坏 SQLite） ----------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  // 二次启动时传入的 .md 文件转发给现有窗口
  handleArgv(argv, () => mainWindow);
});

// ---------- 路径工具 ----------
function getUserDataPath() {
  return path.join(app.getPath("userData"), "nowen-data");
}

// ---------- JWT 密钥：桌面版"首启自动生成并持久化" ----------
// 与 docker-entrypoint.sh 等价的策略，保证：
//   1. 不使用硬编码密钥（生产安全基线）
//   2. 桌面用户零配置启动
//   3. 每台机器独立随机密钥，且重装/升级后保持一致（存在 userData 下，卸载时默认保留）
//   4. 若用户手动设置了外部 JWT_SECRET（长度 >= 16）则完全尊重，不覆盖
function ensureJwtSecret() {
  const existing = process.env.JWT_SECRET;
  if (existing && existing.length >= 16) {
    console.log("[Electron] JWT_SECRET provided via environment, using as-is");
    return existing;
  }

  const userDataPath = getUserDataPath();
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
  } catch (e) {
    console.error("[Electron] mkdir userData failed:", e?.message || e);
  }
  const secretFile = path.join(userDataPath, ".jwt_secret");

  // 读取已有密钥
  try {
    if (fs.existsSync(secretFile)) {
      const saved = fs.readFileSync(secretFile, "utf8").trim();
      if (saved.length >= 16) {
        console.log("[Electron] JWT_SECRET loaded from", secretFile);
        return saved;
      }
    }
  } catch (e) {
    console.warn("[Electron] read .jwt_secret failed, will regenerate:", e?.message || e);
  }

  // 首次启动：生成 48 字节随机值 → base64（约 64 字符）并持久化
  const secret = crypto.randomBytes(48).toString("base64");
  try {
    fs.writeFileSync(secretFile, secret, { encoding: "utf8", mode: 0o600 });
    // Windows 下 mode 0o600 被忽略，用 NTFS ACL 也足够（userData 本身就是当前用户独占）
    console.log("[Electron] JWT_SECRET auto-generated and stored at", secretFile);
  } catch (e) {
    console.error("[Electron] write .jwt_secret failed (continuing in-memory):", e?.message || e);
  }
  return secret;
}

function getBackendEntry() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "backend", "dist", "index.js");
  }
  return path.join(__dirname, "..", "backend", "dist", "index.js");
}

function getFrontendDist() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "frontend", "dist");
  }
  return path.join(__dirname, "..", "frontend", "dist");
}

// 查找 Node 可执行文件：打包后优先内嵌 node，其次 Electron 自带 node 模式，最后系统 PATH
function findNodeExecutable() {
  if (app.isPackaged) {
    const platformDir = {
      win32: "win32-x64",
      darwin: process.arch === "arm64" ? "darwin-arm64" : "darwin-x64",
      linux: "linux-x64",
    }[process.platform];

    const exeName = process.platform === "win32" ? "node.exe" : "node";
    const embeddedNode = path.join(
      process.resourcesPath,
      "node",
      platformDir || "",
      exeName
    );
    if (fs.existsSync(embeddedNode)) {
      console.log("[Electron] Using embedded node:", embeddedNode);
      return { cmd: embeddedNode, useElectron: false };
    }

    // 兼容旧目录结构（node 直接放 resources/node/node.exe）
    const legacyNode = path.join(process.resourcesPath, "node", exeName);
    if (fs.existsSync(legacyNode)) {
      console.log("[Electron] Using legacy embedded node:", legacyNode);
      return { cmd: legacyNode, useElectron: false };
    }

    // 兜底：用 Electron 二进制自身以 "node 模式" 运行子进程（ELECTRON_RUN_AS_NODE=1）
    // 这样即使没有打进 node.exe 也能跑，缺点是需要 better-sqlite3 的 .node ABI 与 Electron 的 node 版本一致
    console.warn(
      "[Electron] No embedded node found, fallback to Electron-as-node (set ELECTRON_RUN_AS_NODE=1)"
    );
    return { cmd: process.execPath, useElectron: true };
  }
  return { cmd: "node", useElectron: false };
}

// ---------- 动态获取空闲端口 ----------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---------- 健康探测（轮询 /api/health） ----------
function waitForBackendReady(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/health", timeout: 1000 },
        (res) => {
          if (res.statusCode === 200) {
            res.resume();
            return resolve();
          }
          res.resume();
          retry();
        }
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`后端启动超时（${timeoutMs}ms）`));
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

// ---------- 启动后端 ----------
async function startBackend() {
  backendPort = await getFreePort();
  const backendEntry = getBackendEntry();
  const userDataPath = getUserDataPath();
  const dbPath = path.join(userDataPath, "nowen-note.db");
  const backendCwd = app.isPackaged
    ? path.join(process.resourcesPath)
    : path.join(__dirname, "..");

  // 确保 userData 目录存在（第一次运行时 db 文件所在目录可能不存在）
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
  } catch (e) {
    console.error("[Electron] mkdir userData failed:", e?.message || e);
  }

  // 后端入口文件是否存在？不存在直接抛，避免 30s 超时误导
  if (!fs.existsSync(backendEntry)) {
    throw new Error(`后端入口文件不存在：${backendEntry}`);
  }

  const { cmd: nodeExe, useElectron } = findNodeExecutable();
  console.log("[Electron] Node cmd:", nodeExe, "(useElectron=" + useElectron + ")");
  console.log("[Electron] Backend entry:", backendEntry);
  console.log("[Electron] Backend cwd:", backendCwd);
  console.log("[Electron] Backend port:", backendPort);
  console.log("[Electron] DB path:", dbPath);

  const spawnEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(backendPort),
    DB_PATH: dbPath,
    ELECTRON_USER_DATA: userDataPath,
    FRONTEND_DIST: getFrontendDist(),
    JWT_SECRET: ensureJwtSecret(),
  };
  // 关键：用 Electron 自身跑 node 模式时必须设置这个环境变量
  if (useElectron) spawnEnv.ELECTRON_RUN_AS_NODE = "1";

  try {
    backendProcess = spawn(nodeExe, [backendEntry], {
      cwd: backendCwd,
      env: spawnEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    throw new Error(`后端进程 spawn 失败：${e?.message || e}`);
  }

  // spawn 本身异步失败（ENOENT 等）会走 error 事件，必须监听，否则静默
  let spawnErr = null;
  backendProcess.on("error", (err) => {
    spawnErr = err;
    console.error("[Backend] spawn error:", err?.message || err);
  });

  backendProcess.stdout.on("data", (d) =>
    console.log("[Backend]", d.toString().trimEnd())
  );
  backendProcess.stderr.on("data", (d) =>
    console.error("[Backend Error]", d.toString().trimEnd())
  );
  backendProcess.on("exit", (code, signal) => {
    console.error(
      `[Backend] Exited code=${code} signal=${signal || ""}${spawnErr ? " err=" + spawnErr.message : ""}`
    );
    backendProcess = null;
  });

  // 轮询健康端点，确认服务真正就绪
  try {
    await waitForBackendReady(backendPort, 30000);
  } catch (e) {
    // 附带 spawn 错误信息一起抛给 UI 弹窗
    if (spawnErr) {
      throw new Error(`${e.message}；子进程启动错误：${spawnErr.message}`);
    }
    throw e;
  }
}

function stopBackend() {
  if (backendProcess) {
    try {
      backendProcess.kill();
    } catch {
      /* ignore */
    }
    backendProcess = null;
  }
}

// ---------- 启动闪屏 ----------
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#0D1117",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const html = `
    <html><head><style>
      html,body{margin:0;height:100%;background:#0D1117;color:#E6EDF3;font-family:system-ui,sans-serif;
        display:flex;align-items:center;justify-content:center;border-radius:12px;overflow:hidden;}
      .box{text-align:center}
      .title{font-size:22px;font-weight:600;margin-bottom:10px;letter-spacing:1px}
      .hint{font-size:13px;color:#7d8590}
      .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#58a6ff;margin:0 3px;
        animation:b 1.2s infinite ease-in-out both}
      .dot:nth-child(2){animation-delay:.15s}.dot:nth-child(3){animation-delay:.3s}
      @keyframes b{0%,80%,100%{transform:scale(.5);opacity:.4}40%{transform:scale(1);opacity:1}}
    </style></head><body><div class="box">
      <div class="title">Nowen Note</div>
      <div class="hint">正在启动本地服务 <span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
    </div></body></html>`;
  splashWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}

// ---------- 关于窗口 ----------
function openAboutWindow() {
  const about = new BrowserWindow({
    width: 360,
    height: 240,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow || undefined,
    modal: true,
    title: "关于 Nowen Note",
    backgroundColor: "#0D1117",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const html = `
    <html><head><style>
      html,body{margin:0;height:100%;background:#0D1117;color:#E6EDF3;
        font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;}
      .box{text-align:center;padding:20px}
      .title{font-size:20px;font-weight:600;margin-bottom:6px}
      .ver{font-size:13px;color:#7d8590;margin-bottom:16px}
      .desc{font-size:12px;color:#8b949e;line-height:1.6}
    </style></head><body><div class="box">
      <div class="title">Nowen Note</div>
      <div class="ver">v${app.getVersion()}</div>
      <div class="desc">一款现代化的笔记应用<br/>© Nowen</div>
    </div></body></html>`;
  about.setMenuBarVisibility(false);
  about.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

// ---------- 主窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Nowen Note",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#0D1117",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);

  mainWindow.once("ready-to-show", () => {
    closeSplash();
    mainWindow.show();
  });

  // 首次加载完成后，冲刷待送的文件关联打开请求
  mainWindow.webContents.on("did-finish-load", () => {
    flushPending(mainWindow);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  // 关闭按钮：最小化到托盘，而不是直接退出
  mainWindow.on("close", (e) => {
    if (!getIsQuitting()) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------- 启动失败弹窗 ----------
function tailLogFile(lines = 20) {
  try {
    const dir = getLogDir();
    if (!dir || !fs.existsSync(dir)) return "";
    const files = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith("main-") && n.endsWith(".log"))
      .sort();
    if (files.length === 0) return "";
    const latest = path.join(dir, files[files.length - 1]);
    const content = fs.readFileSync(latest, "utf8");
    const arr = content.split(/\r?\n/).filter(Boolean);
    return arr.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function showStartupError(err) {
  closeSplash();
  const logDir = getLogDir();
  const tail = tailLogFile(20);
  const detail =
    `本地服务未能正常启动。\n\n` +
    `${err?.message || err}\n\n` +
    (tail ? `— 最近日志（尾 20 行）—\n${tail}\n\n` : "") +
    `日志目录：\n${logDir}\n\n` +
    `数据目录：\n${getUserDataPath()}`;
  dialog.showErrorBox("Nowen Note 启动失败", detail);
}

// ---------- IPC：app 信息 ----------
function registerAppIpc() {
  ipcMain.removeHandler("app:info");
  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    name: app.getName(),
    platform: process.platform,
    arch: process.arch,
    userData: getUserDataPath(),
    logDir: getLogDir(),
    backendPort,
  }));

  ipcMain.removeHandler("app:open-log-dir");
  ipcMain.handle("app:open-log-dir", async () => {
    const dir = getLogDir();
    await shell.openPath(dir);
    return { ok: true, path: dir };
  });
}

// ---------- 生命周期 ----------
// macOS 双击 .md 的 open-file 事件需要在 ready 之前监听
setupMacOpenFile(() => mainWindow);

app.whenReady().then(async () => {
  createSplash();
  try {
    await startBackend();
    createWindow();
  } catch (err) {
    console.error("[Electron] Startup failed:", err);
    showStartupError(err);
    stopBackend();
    app.quit();
    return;
  }

  // 原生菜单（accelerator 同时担当全局快捷键）
  buildMenu({
    onCheckForUpdates: () => checkForUpdatesManually(),
    openAboutWindow,
  });

  // 托盘
  createTray({
    getMainWindow: () => mainWindow,
    onNewNote: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("menu:new-note");
      }
    },
  });

  // IPC
  registerAppIpc();
  // 局域网服务发现（mDNS）：注册 discovery:start / stop / list，
  // renderer 端通过 window.nowenDesktop.discovery.* 使用
  registerDiscoveryIpc();

  // 自动更新（生产环境生效）
  initAutoUpdater({
    onQuitRequested: () => markQuitting(),
  });

  // 首次启动时传入的 .md 文件（Windows/Linux 命令行）
  handleArgv(process.argv, () => mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on("window-all-closed", () => {
  // 有托盘时不退出；仅 macOS 保持默认行为（本来就不退出）
  // 实际上开启了托盘 + close 拦截后，这里几乎不会走到
  if (process.platform !== "darwin" && getIsQuitting()) {
    stopBackend();
    destroyTray();
    app.quit();
  }
});

app.on("before-quit", () => {
  markQuitting();
  stopBackend();
  destroyTray();
  try { shutdownDiscovery(); } catch { /* ignore */ }
});
