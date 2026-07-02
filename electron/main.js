const { app, BrowserWindow, shell, dialog, ipcMain, Menu, session } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const http = require("http");
const crypto = require("crypto");

const { buildMenu, applyFormatState } = require("./menu");
const { createTray, destroyTray, markQuitting, getIsQuitting } = require("./tray");
const { initAutoUpdater, checkForUpdatesManually, setUpdaterContext } = require("./updater");
const { initLogger, getLogDir } = require("./logger");
const { handleArgv, setupMacOpenFile, flushPending } = require("./fileAssoc");
const { registerDiscoveryIpc, shutdown: shutdownDiscovery } = require("./discovery");
const { setSettingsPath, readSettings, writeSettings } = require("./settings");
const { openSetupWindow } = require("./setupWindow");
const {
  setCredentialsPath,
  registerCredentialsIpc,
  clear: clearCredentials,
} = require("./credentials");
const folderSync = require("./folder-sync");
const {
  isAllowedExternalUrl,
  isAllowedMainWindowNavigation,
  isTrustedMainWindowSender,
  isTrustedSetupWindowSender,
  assertMainWindowSender,
  setTrustedMainWindowId,
} = require("./security");

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
// 当前运行模式快照（在 ready 时读 settings.json 后赋值）
let currentMode = "full";   // "full" | "lite"
let currentRemoteUrl = "";  // lite 模式下的远端 URL
let currentHideMenuBar = false; // Windows/Linux 是否隐藏菜单栏
// Phase A: 桌面零登录所用的本地账号 token / user，在 startBackend 之后由
// ensureLocalAccount() 写入；renderer 通过 ipcMain "desktop:get-local-auth" 拉取。
// 仅 full 模式有意义；lite 模式（连远端）保持原有手动登录流程。
let localAuthCache = null;  // { token: string, user: object } | null

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

/**
 * 当前是否为"Lite-only 发行版"：打包产物内不含 backend。
 *
 * 判断依据：
 *   1. 环境变量 NOWEN_LITE_ONLY=1（CI / 调试可强制声明）
 *   2. 已 packaged 但 backend/dist/index.js 不存在（lite builder.config 剥掉了 backend）
 * 开发环境下始终返回 false，避免误切。
 */
function isLiteOnlyBuild() {
  if (process.env.NOWEN_LITE_ONLY === "1") return true;
  if (!app.isPackaged) return false;
  try {
    return !fs.existsSync(getBackendEntry());
  } catch {
    return false;
  }
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

// ---------- Lite 模式：远端可达性探测 ----------
//
// 与 waitForBackendReady 不同：
//   - 远端可能是 https 自签证书，要走 https 模块；
//   - 路径优先 /api/health，失败兜底 /；
//   - 失败时不立刻 retry，而是给较长间隔（1s），避免在网络中断时狂打目标服务器。
function waitForRemoteReady(remoteUrl, timeoutMs = 15000) {
  if (!remoteUrl) {
    return Promise.reject(new Error("远端 URL 为空（请在'选择服务器'里设置）"));
  }
  let parsed;
  try {
    parsed = new URL(remoteUrl);
  } catch (e) {
    return Promise.reject(new Error(`远端 URL 无效：${remoteUrl}`));
  }

  // 在浏览器端通常用 fetch；Node 主进程这边用 http/https 即可
  const lib = parsed.protocol === "https:" ? require("https") : require("http");
  const baseOpts = {
    host: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    timeout: 3000,
    rejectUnauthorized: false, // 容忍自签
  };

  const start = Date.now();
  return new Promise((resolve, reject) => {
    let lastErr = null;
    const tick = () => {
      const req = lib.get({ ...baseOpts, path: "/api/health" }, (res) => {
        // 任何 2xx/3xx/4xx 都说明服务器在跑（4xx 可能是没鉴权的健康端点）
        if (res.statusCode < 500) {
          res.resume();
          return resolve();
        }
        res.resume();
        lastErr = new Error(`HTTP ${res.statusCode}`);
        retry();
      });
      req.on("error", (e) => {
        lastErr = e;
        retry();
      });
      req.on("timeout", () => {
        req.destroy();
        lastErr = new Error("连接超时");
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(
            `远端服务无法连接：${remoteUrl}` +
              (lastErr ? `（${lastErr.message}）` : "")
          )
        );
      }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

// 把任意 URL 截成 "host:port" 用于展示（splash / 错误弹窗），失败兜底原串
function safeHost(url) {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url || "(未配置)";
  }
}

// Lite 启动失败后的恢复路径：让用户选择"换服务器 / 回到本地模式 / 退出"
async function offerLiteRecovery() {
  const liteOnly = isLiteOnlyBuild();
  const buttons = liteOnly
    ? ["更换服务器…", "退出"]
    : ["更换服务器…", "回到本地模式", "退出"];
  const r = await dialog.showMessageBox({
    type: "warning",
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    title: "无法连接到远端服务",
    message: `远端服务 ${safeHost(currentRemoteUrl)} 当前不可达。`,
    detail: liteOnly
      ? "当前是轻量发行版，只能连接远端服务。你可以更换服务器或退出稍后再试。"
      : "你可以更换服务器、切回内置本地模式，或者退出应用稍后再试。",
  });
  if (r.response === 0) {
    const sel = await openSetupWindow({ initialUrl: currentRemoteUrl });
    if (sel.ok) {
      writeSettings({ mode: "lite", remoteUrl: sel.url });
      await clearWebStorage();
      relaunchApp();
    } else {
      app.quit();
    }
  } else if (!liteOnly && r.response === 1) {
    writeSettings({ mode: "full", remoteUrl: "" });
    await clearWebStorage();
    relaunchApp();
  } else {
    app.quit();
  }
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

  const localAccountSecret = getLocalAccountSecret();
  const spawnEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(backendPort),
    DB_PATH: dbPath,
    ELECTRON_USER_DATA: userDataPath,
    ELECTRON_LOCAL_ACCOUNT_SECRET: localAccountSecret,
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

// ---------- Phase A: 桌面零登录的本地账号自动准备 ----------
//
// 设计：
//   - full 模式下，backend 起来后向自身 localhost:port 走一遍 /auth/login；
//     用户名固定为 "desktop"，密码用 userData/.local_account_secret 持久化的 32B base64。
//   - 第一次启动找不到用户 → 直接 POST /auth/register 创建（首个用户自动成为 admin）。
//   - 拿到 token 后缓存在主进程，preload 通过 ipcMain "desktop:get-local-auth" 暴露给前端。
//   - 失败不抛：renderer 拿不到 localAuth 就走原本的登录页，相当于"零登录"功能未生效。
//
// 安全性说明：
//   - 这个账号只在 127.0.0.1 上可用（backend 默认 listen 127.0.0.1），不暴露公网；
//   - 密码秘密存在 userData 下，权限 0600；用户磁盘被人物理拿到时本就不再是 trust boundary。
//   - 用户随时可以从 App 内"账号设置 → 切换账号"绕回手动登录路径。
function getLocalAccountSecret() {
  const userDataPath = getUserDataPath();
  const f = path.join(userDataPath, ".local_account_secret");
  try {
    if (fs.existsSync(f)) {
      const v = fs.readFileSync(f, "utf8").trim();
      if (v.length >= 16) return v;
    }
  } catch (e) {
    console.warn("[Electron] read .local_account_secret failed:", e?.message || e);
  }
  const secret = crypto.randomBytes(32).toString("base64");
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(f, secret, { encoding: "utf8", mode: 0o600 });
  } catch (e) {
    console.error("[Electron] write .local_account_secret failed:", e?.message || e);
  }
  return secret;
}

// 简易 JSON POST：只在 127.0.0.1:backendPort 上用，5s 超时
function localApiRequest(pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? "" : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: backendPort,
        path: `/api${pathname}`,
        method: "POST",
        timeout: 5000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...extraHeaders,
        },
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = chunks ? JSON.parse(chunks) : null; } catch { /* ignore */ }
          resolve({ status: res.statusCode || 0, data: parsed });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

async function ensureLocalAccount() {
  if (currentMode !== "full") return null;
  if (!backendPort) return null;

  const password = getLocalAccountSecret();
  const username = "desktop";

  // 先尝试登录
  try {
    const r = await localApiRequest("/auth/login", { username, password });
    if (r.status === 200 && r.data?.token) {
      console.log("[Electron] local desktop account login OK");
      return { token: r.data.token, user: r.data.user };
    }
    // 401：密码错或用户存在但密码对不上；404 / 400：用户不存在 → 走注册
  } catch (e) {
    console.warn("[Electron] local login failed:", e?.message || e);
  }

  // 注册（首个用户自动 admin；后续用户也能注册成功 —— 即使关闭注册开关，
  //   首启路径上注册开关本身就是默认开的，且我们要的就是"开箱即用"）
  try {
    const r = await localApiRequest("/auth/register", {
      username,
      password,
      displayName: "本机用户",
    });
    if ((r.status === 200 || r.status === 201) && r.data?.token) {
      console.log("[Electron] local desktop account registered");
      return { token: r.data.token, user: r.data.user };
    }
    // 409：用户名已存在（说明密码被人改了或 secret 文件丢了），
    //   不去暴力重置，让用户在登录页手动处理
    console.warn(
      "[Electron] local register failed: status=" + r.status +
        " err=" + (r.data?.error || ""),
    );
  } catch (e) {
    console.warn("[Electron] local register error:", e?.message || e);
  }
  return null;
}

async function resetLocalAccountAuth() {
  if (currentMode !== "full") return { ok: false, error: "not-full-mode" };
  if (!backendPort) return { ok: false, error: "backend-not-ready" };
  const password = getLocalAccountSecret();
  try {
    const r = await localApiRequest(
      "/auth/desktop/reset-local",
      { username: "desktop", password },
      { "X-Nowen-Desktop-Secret": password },
    );
    if (r.status === 200 && r.data?.token) {
      localAuthCache = { token: r.data.token, user: r.data.user };
      return { ok: true, token: r.data.token, user: r.data.user };
    }
    return { ok: false, error: r.data?.error || `status=${r.status}` };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---------- 启动闪屏 ----------
function createSplash(message) {
  const hint = message || "正在启动本地服务";
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: "#0D1117",
    // SEC-ELECTRON-01-B: 显式安全参数
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  // SEC-ELECTRON-01-C-B2-B3: 禁止 data URL 窗口打开新窗口
  splashWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
      <div class="hint">${hint} <span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
    </div></body></html>`;
  splashWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildMainWindowErrorHtml({ title, message, details = [] }) {
  const rows = details
    .filter((row) => row && row.value !== undefined && row.value !== null && row.value !== "")
    .map(
      (row) => `
        <div class="row">
          <div class="key">${escapeHtml(row.label)}</div>
          <div class="value">${escapeHtml(row.value)}</div>
        </div>`
    )
    .join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    html,body{margin:0;min-height:100vh;background:#0D1117;color:#E6EDF3;font-family:system-ui,sans-serif}
    body{display:flex;align-items:center;justify-content:center;padding:28px;box-sizing:border-box}
    .box{width:min(760px,100%);border:1px solid #30363d;border-radius:8px;background:#161b22;padding:24px;box-sizing:border-box}
    .title{font-size:20px;font-weight:600;margin-bottom:10px}
    .message{font-size:14px;color:#c9d1d9;line-height:1.6;margin-bottom:18px}
    .row{display:grid;grid-template-columns:150px minmax(0,1fr);gap:12px;border-top:1px solid #30363d;padding:10px 0}
    .key{font-size:12px;color:#8b949e}
    .value{font-size:12px;color:#E6EDF3;word-break:break-word;white-space:pre-wrap}
    button{margin-top:18px;padding:8px 18px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#E6EDF3;cursor:pointer;font-size:13px}
    button:hover{background:#30363d}
  </style></head><body><div class="box">
    <div class="title">${escapeHtml(title)}</div>
    <div class="message">${escapeHtml(message)}</div>
    ${rows}
    <button onclick="window.location.reload()">重新加载</button>
  </div></body></html>`;
}

function loadMainWindowErrorPage(win, payload) {
  if (!win || win.isDestroyed()) return;
  const html = buildMainWindowErrorHtml(payload);
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html)).catch((e) => {
    console.error("[main-window] failed to load local error page:", e?.message || e);
  });
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
    // SEC-ELECTRON-01-B: 显式安全参数
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  // SEC-ELECTRON-01-C-B2-B3: 禁止 data URL 窗口打开新窗口
  about.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
function applyMenuBarPreference() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (process.platform === "darwin") return;
  const hide = !!currentHideMenuBar;
  try {
    mainWindow.setAutoHideMenuBar(hide);
    mainWindow.setMenuBarVisibility(!hide);
  } catch (e) {
    console.warn("[menu] apply menu bar preference failed:", e?.message || e);
  }
}

function createWindow() {
  const isMac = process.platform === "darwin";
  const hideMenuBar = !isMac && !!currentHideMenuBar;
  const preloadPath = path.join(__dirname, "preload.js");

  // macOS 原生观感：
  //   - hiddenInset 把 Traffic Light 嵌入工具栏，不占独立标题栏；
  //   - vibrancy: 'sidebar' 启用系统级毛玻璃（配合前端 macOS 皮肤效果最佳）；
  //   - visualEffectState: 'active' 避免窗口失焦后毛玻璃褪色导致"发灰"。
  //   - trafficLightPosition: { x: 12, y: 52 } 避免与 NavRail 顶部按钮重叠
  //     NavRail 顶部有 40px 高的按钮 + 4px paddingTop，所以 y 设为 52 更安全。
  // 注：仅 macOS 生效；Windows/Linux 保持原有无边框策略（默认），避免踩 Mica/Acrylic 的坑。
  const macWindowOpts = isMac
    ? {
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 12, y: 52 },
        vibrancy: "sidebar",
        visualEffectState: "active",
        transparent: false, // 开启 vibrancy 时 backgroundColor 可设半透明或不设
      }
    : {};

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Nowen Note",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: isMac ? "#00000000" : "#0D1117",
    show: false,
    autoHideMenuBar: hideMenuBar,
    ...macWindowOpts,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // sandbox 不能开：preload 使用 require("electron")，sandbox 下 require 不可用
      preload: preloadPath,
      additionalArguments: isLiteOnlyBuild() ? ["--nowen-lite-only"] : [],
    },
  });

  // SEC-ELECTRON-01-B-RV1: 注册主窗口 webContents.id 用于 IPC sender 校验
  setTrustedMainWindowId(mainWindow.webContents.id);
  let hasShownMainWindow = false;
  let loadingErrorPage = false;
  const revealMainWindow = (reason) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (hasShownMainWindow) return;
    hasShownMainWindow = true;
    closeSplash();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    console.log(
      `[main-window] reveal reason=${reason} url=${mainWindow.webContents.getURL()}`
    );
  };
  const startupRevealTimer = setTimeout(() => {
    console.warn(
      `[main-window] startup-timeout url=${mainWindow?.webContents?.getURL?.() || ""}`
    );
    revealMainWindow("startup-timeout");
  }, 10000);
  startupRevealTimer.unref?.();

  // 根据当前模式决定 API 目标：
  //   full → 本机后端 http://127.0.0.1:{backendPort}
  //   lite → 用户在 setup 窗里选择并写入 settings.json 的 remoteUrl
  //
  // 重要：桌面客户端永远加载本地 frontend/dist，而不是远端服务器页面。
  // 这样服务端即使开启「API-only / 关闭网页端」也不会影响 PC 客户端。
  const targetUrl =
    currentMode === "lite" && currentRemoteUrl
      ? currentRemoteUrl
      : `http://127.0.0.1:${backendPort}`;
  const frontendIndex = path.join(getFrontendDist(), "index.html");
  const frontendIndexExists = fs.existsSync(frontendIndex);
  const preloadExists = fs.existsSync(preloadPath);
  console.log(
    `[main-window] resourcesPath=${process.resourcesPath || ""} ` +
      `frontendIndex=${frontendIndex} exists=${frontendIndexExists} ` +
      `preload=${preloadPath} exists=${preloadExists} ` +
      `targetUrl=${targetUrl} mode=${currentMode} packaged=${app.isPackaged}`
  );
  const handleInitialLoadError = (err) => {
    console.error("[main-window] initial load failed:", err?.stack || err?.message || err);
    if (!loadingErrorPage) {
      loadingErrorPage = true;
      loadMainWindowErrorPage(mainWindow, {
        title: "Nowen Note 窗口加载失败",
        message: "主窗口初始资源加载失败。应用已打开诊断页，避免只剩后台进程。",
        details: [
          { label: "error", value: err?.stack || err?.message || err },
          { label: "currentURL", value: mainWindow.webContents.getURL() },
          { label: "frontendIndex", value: frontendIndex },
          { label: "frontendIndex exists", value: String(fs.existsSync(frontendIndex)) },
          { label: "preload", value: preloadPath },
          { label: "preload exists", value: String(fs.existsSync(preloadPath)) },
          { label: "targetUrl", value: targetUrl },
          { label: "logs", value: getLogDir() },
          { label: "data", value: getUserDataPath() },
        ],
      });
    }
    revealMainWindow("initial-load-error");
  };
  if (frontendIndexExists) {
    // 桌面客户端始终加载本地 UI，远程地址作为 API base 通过 query 参数传入
    mainWindow
      .loadFile(frontendIndex, { query: { serverUrl: targetUrl } })
      .catch(handleInitialLoadError);
  } else if (app.isPackaged || currentMode === "lite") {
    // packaged / lite 包缺前端时直接展示本地错误页，不要静默落到远端或隐藏窗口。
    loadingErrorPage = true;
    loadMainWindowErrorPage(mainWindow, {
      title: "Nowen Note 客户端资源缺失",
      message: "本地前端文件未找到。请重新安装 Nowen Note，或检查安装包是否完整。",
      details: [
        { label: "frontendIndex", value: frontendIndex },
        { label: "frontendIndex exists", value: String(frontendIndexExists) },
        { label: "preload", value: preloadPath },
        { label: "preload exists", value: String(preloadExists) },
        { label: "targetUrl", value: targetUrl },
        { label: "mode", value: currentMode },
        { label: "resourcesPath", value: process.resourcesPath || "" },
        { label: "logs", value: getLogDir() },
        { label: "data", value: getUserDataPath() },
      ],
    });
    revealMainWindow("frontend-missing");
  } else {
    // full 模式 dev 环境：加载本地 dev server
    mainWindow.loadURL(targetUrl).catch(handleInitialLoadError);
  }
  applyMenuBarPreference();

  // ---------- macOS：全屏进出时通知 renderer 调整 Traffic Light 让位 ----------
  // 全屏模式下 Traffic Light 自动隐藏，顶部 72px 左 padding 应回收；离开全屏再恢复。
  // 通过 dom.document.documentElement[data-fullscreen] 驱动 CSS 分支，避免轮询。
  if (isMac) {
    const notifyFullscreen = (value) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents
          .executeJavaScript(
            `document.documentElement.setAttribute("data-fullscreen", "${value ? "1" : "0"}")`
          )
          .catch(() => { /* 页面可能还未就绪，忽略 */ });
      }
    };
    mainWindow.on("enter-full-screen", () => notifyFullscreen(true));
    mainWindow.on("leave-full-screen", () => notifyFullscreen(false));
    mainWindow.webContents.on("did-finish-load", () => {
      notifyFullscreen(mainWindow.isFullScreen());
    });
  }

  mainWindow.once("ready-to-show", () => {
    revealMainWindow("ready-to-show");
  });

  // 首次加载完成后，冲刷待送的文件关联打开请求
  mainWindow.webContents.on("did-finish-load", () => {
    revealMainWindow("did-finish-load");
    flushPending(mainWindow);
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      console.error(
        `[main-window] did-fail-load code=${errorCode} desc=${errorDescription} ` +
          `url=${validatedURL} isMainFrame=${isMainFrame}`
      );
      if (!isMainFrame || loadingErrorPage) {
        revealMainWindow("did-fail-load");
        return;
      }
      loadingErrorPage = true;
      loadMainWindowErrorPage(mainWindow, {
        title: "Nowen Note 窗口加载失败",
        message: "主窗口资源加载失败。应用已打开诊断页，方便定位安装包资源、前端或本地服务问题。",
        details: [
          { label: "errorCode", value: String(errorCode) },
          { label: "errorDescription", value: errorDescription },
          { label: "validatedURL", value: validatedURL },
          { label: "currentURL", value: mainWindow.webContents.getURL() },
          { label: "frontendIndex", value: frontendIndex },
          { label: "frontendIndex exists", value: String(fs.existsSync(frontendIndex)) },
          { label: "preload", value: preloadPath },
          { label: "preload exists", value: String(fs.existsSync(preloadPath)) },
          { label: "targetUrl", value: targetUrl },
          { label: "logs", value: getLogDir() },
          { label: "data", value: getUserDataPath() },
        ],
      });
      revealMainWindow("did-fail-load");
    }
  );

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[main-window] render-process-gone:", details);
    if (!loadingErrorPage) {
      loadingErrorPage = true;
      loadMainWindowErrorPage(mainWindow, {
        title: "Nowen Note 渲染进程异常",
        message: "主窗口渲染进程已退出。应用已打开诊断页，避免只剩后台进程。",
        details: [
          { label: "reason", value: details?.reason },
          { label: "exitCode", value: details?.exitCode },
          { label: "currentURL", value: mainWindow.webContents.getURL() },
          { label: "logs", value: getLogDir() },
          { label: "data", value: getUserDataPath() },
        ],
      });
    }
    revealMainWindow("render-process-gone");
  });

  mainWindow.webContents.on("unresponsive", () => {
    console.warn("[main-window] unresponsive url=" + mainWindow.webContents.getURL());
    revealMainWindow("unresponsive");
  });
  mainWindow.webContents.on("responsive", () => {
    console.log("[main-window] responsive url=" + mainWindow.webContents.getURL());
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(
      `[main-window] console-message level=${level} source=${sourceId}:${line} ${message}`
    );
  });
  mainWindow.webContents.on("preload-error", (_event, failedPreloadPath, error) => {
    console.error(
      `[main-window] preload-error path=${failedPreloadPath} error=${error?.stack || error?.message || error}`
    );
    if (!loadingErrorPage) {
      loadingErrorPage = true;
      loadMainWindowErrorPage(mainWindow, {
        title: "Nowen Note Preload 加载失败",
        message: "主窗口 preload 脚本加载失败。桌面端桥接能力不可用，请根据下面路径和日志排查安装包。",
        details: [
          { label: "preload", value: failedPreloadPath || preloadPath },
          { label: "preload exists", value: String(fs.existsSync(preloadPath)) },
          { label: "error", value: error?.stack || error?.message || error },
          { label: "currentURL", value: mainWindow.webContents.getURL() },
          { label: "logs", value: getLogDir() },
          { label: "data", value: getUserDataPath() },
        ],
      });
    }
    revealMainWindow("preload-error");
  });

  // SEC-ELECTRON-01-C-B1: 主窗口 navigation 拦截
  // 防止 renderer 通过 window.location、恶意链接、脚本跳转等方式把主窗口导航到非应用页面
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (isAllowedMainWindowNavigation(navigationUrl, currentUrl)) {
      return; // 允许内部导航
    }

    // 阻止主窗口跳转
    event.preventDefault();

    // 外部 http/https/mailto 走安全外链打开
    if (isAllowedExternalUrl(navigationUrl)) {
      shell.openExternal(navigationUrl);
    } else {
      console.warn("[main] blocked main window navigation to unsafe URL:", navigationUrl);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // SEC-ELECTRON-01-B1: 使用 URL parser 验证协议，只允许安全协议
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url);
    } else {
      // SEC-ELECTRON-01-B-RV1: 日志脱敏，不输出完整 URL
      try {
        console.warn("[main] blocked external URL protocol:", new URL(url).protocol);
      } catch {
        console.warn("[main] blocked external URL with invalid format");
      }
    }
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
    clearTimeout(startupRevealTimer);
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
  const isLite = currentMode === "lite";
  const detail =
    (isLite
      ? `连接远端服务失败：${currentRemoteUrl}\n\n`
      : `本地服务未能正常启动。\n\n`) +
    `${err?.message || err}\n\n` +
    (tail ? `— 最近日志（尾 20 行）—\n${tail}\n\n` : "") +
    `日志目录：\n${logDir}\n\n` +
    `数据目录：\n${getUserDataPath()}`;
  dialog.showErrorBox(
    isLite ? "Nowen Note 连接失败" : "Nowen Note 启动失败",
    detail
  );
}

// ---------- 模式切换 ----------
//
// 设计：
//   - 切换 = 写 settings.json + relaunch + exit。
//     不在运行时"热切换"，因为：
//       1) full → lite 时要杀 backend、关 SQLite，重新初始化窗口/IPC，复杂度高；
//       2) lite → full 时要重新跑 startBackend()，且 renderer 已经登录到远端，
//          各种缓存（cookie/localStorage/IndexedDB）会和本地后端冲突。
//     重启是最干净也最快的方式（< 2s）。
//   - 切换前清登录态：调用方决定（switchToLite 接受 url 后清，switchToFull 也清）
//     —— 用户的需求是"切换服务器 = 清空登录态"。
async function clearWebStorage() {
  // 清掉默认 session 的 cookie / localStorage / IndexedDB / cache，
  // 这样切到新服务器后是全新登录态。
  // 不动 partition，因为本期只支持单一服务器。
  try {
    await session.defaultSession.clearStorageData({
      storages: [
        "cookies",
        "localstorage",
        "indexdb",
        "websql",
        "shadercache",
        "serviceworkers",
        "cachestorage",
      ],
    });
    await session.defaultSession.clearCache();
    console.log("[mode-switch] storage cleared");
  } catch (e) {
    console.warn("[mode-switch] clearStorageData failed:", e?.message || e);
  }
  // 切服务器 / 切模式 = 旧凭据已无效，连同"记住密码"一起清掉，
  // 否则下次自动登录会打到旧服务器。
  try { clearCredentials(); } catch { /* ignore */ }
}

function relaunchApp() {
  // 标记退出意图，避免 close → hide 拦截
  markQuitting();
  // 先停掉 backend（如果有），关闭托盘 / discovery
  try { stopBackend(); } catch { /* ignore */ }
  try { destroyTray(); } catch { /* ignore */ }
  try { shutdownDiscovery(); } catch { /* ignore */ }

  app.relaunch();
  app.exit(0);
}

/**
 * 切换到 Lite 模式。会弹出 setup 窗，让用户选远端 URL。
 * @param {Electron.BrowserWindow | null} parentWin 父窗口（可空）
 */
async function switchToLite(parentWin) {
  const r = await openSetupWindow({
    parent: parentWin || null,
    initialUrl: currentRemoteUrl || "",
  });
  if (!r.ok) return; // 用户取消
  writeSettings({ mode: "lite", remoteUrl: r.url });
  await clearWebStorage();
  relaunchApp();
}

/**
 * 切换到 Full（本地）模式。
 */
async function switchToFull() {
  if (isLiteOnlyBuild()) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: "info",
      buttons: ["知道了"],
      title: "轻量端不支持切换",
      message: "当前是\"轻量发行版\"，不包含本地后端。",
      detail: "如需使用本地后端，请下载完整版安装包。",
    });
    return;
  }
  const choice = await dialog.showMessageBox(mainWindow || undefined, {
    type: "question",
    buttons: ["切换", "取消"],
    defaultId: 0,
    cancelId: 1,
    title: "切换到本地模式",
    message: "切换到本地模式将启动内置后端并使用本机数据库。",
    detail: "当前的远端登录态会被清除（重新打开时需要登录本地账号）。",
  });
  if (choice.response !== 0) return;
  writeSettings({ mode: "full", remoteUrl: "" });
  await clearWebStorage();
  relaunchApp();
}

/**
 * 仅更换 lite 模式下的服务器地址（不退出 lite 模式）。
 */
async function changeRemoteServer() {
  const r = await openSetupWindow({
    parent: mainWindow || null,
    initialUrl: currentRemoteUrl || "",
  });
  if (!r.ok) return;
  writeSettings({ mode: "lite", remoteUrl: r.url });
  await clearWebStorage();
  relaunchApp();
}

// ---------- IPC：app 信息 ----------
function registerAppIpc() {
  // SEC-ELECTRON-01-C: app:info 只返回安全字段
  ipcMain.removeHandler("app:info");
  ipcMain.handle("app:info", (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    return {
      version: app.getVersion(),
      name: app.getName(),
      platform: process.platform,
      arch: process.arch,
      mode: currentMode,
      hideMenuBar: currentHideMenuBar,
    };
  });

  // SEC-ELECTRON-01-C: 诊断信息接口（敏感路径等，仅在需要时调用）
  ipcMain.removeHandler("app:diagnostics-info");
  ipcMain.handle("app:diagnostics-info", (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    return {
      userData: getUserDataPath(),
      logDir: getLogDir(),
      backendPort,
      remoteUrl: currentRemoteUrl,
    };
  });

  ipcMain.removeHandler("app:open-log-dir");
  ipcMain.handle("app:open-log-dir", async (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    const dir = getLogDir();
    await shell.openPath(dir);
    return { ok: true, path: dir };
  });

  ipcMain.removeHandler("app:open-data-dir");
  ipcMain.handle("app:open-data-dir", async (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    const dir = getUserDataPath();
    await shell.openPath(dir);
    return { ok: true, path: dir };
  });

  
// Task reminder notification
ipcMain.removeHandler("task:notify");
ipcMain.handle("task:notify", async (event, { title, body } = {}) => {
  // SEC-ELECTRON-01-C-RV1: sender 校验 + 参数类型/长度校验
  const reject = assertMainWindowSender(event);
  if (reject) return reject;
  try {
    const { Notification } = require("electron");
    if (!Notification.isSupported()) return { success: false, reason: "not-supported" };
    const safeTitle = typeof title === "string" ? title.slice(0, 200) : "";
    const safeBody = typeof body === "string" ? body.slice(0, 1000) : "";
    const notif = new Notification({ title: safeTitle, body: safeBody });
    notif.show();
    return { success: true };
  } catch (e) {
    return { success: false, reason: String(e) };
  }
});

ipcMain.removeHandler("task:notify-permission");
ipcMain.handle("task:notify-permission", () => {
  return { supported: require("electron").Notification.isSupported() };
});
  ipcMain.removeHandler("app:set-hide-menu-bar");
  ipcMain.handle("app:set-hide-menu-bar", async (_event, next) => {
    currentHideMenuBar = !!next;
    writeSettings({ hideMenuBar: currentHideMenuBar });
    applyMenuBarPreference();
    return { ok: true, hideMenuBar: currentHideMenuBar };
  });

  // Phase A: 桌面零登录 —— renderer 启动时拉取本地账号 token，跳过登录页。
  // 仅 full 模式返回非 null；lite 模式或 ensureLocalAccount 失败时返回 null。
  ipcMain.removeHandler("desktop:get-local-auth");
  ipcMain.handle("desktop:get-local-auth", (event) => {
    // SEC-ELECTRON-01-B: 高权限 IPC 来源校验
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    return localAuthCache;
  });

  // Phase A: 切换到云账号时 renderer 调这个清掉本地缓存，避免下次启动又被自动登录。
  // 注意只清主进程内存里的缓存；userData 下的 secret 文件保留（用户随时可以切回本地账号）。
  ipcMain.removeHandler("desktop:clear-local-auth");
  ipcMain.handle("desktop:clear-local-auth", (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    localAuthCache = null;
    return { ok: true };
  });

  ipcMain.removeHandler("desktop:reset-local-auth");
  ipcMain.handle("desktop:reset-local-auth", async (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;

    // SEC-ELECTRON-01-B2-B1: 主进程级别用户确认，防止 XSS 或误触重置本地账号
    const parentWin = BrowserWindow.getFocusedWindow() || mainWindow;
    const { response } = await dialog.showMessageBox(parentWin || null, {
      type: "warning",
      title: "重置本地账号？",
      message: "此操作会清除当前桌面端的本地账号认证信息。你可能需要重新登录或重新配置本地账号。是否继续？",
      buttons: ["取消", "重置"],
      defaultId: 0,  // 默认按钮是取消
      cancelId: 0,   // Esc / 关闭弹窗视为取消
    });

    // 用户点击"取消"或关闭弹窗
    if (response !== 1) {
      return { success: false, cancelled: true };
    }

    // 用户点击"重置"
    return resetLocalAccountAuth();
  });

  /**
   * renderer → main：上报格式状态，同步系统菜单栏 checked 标记。
   *
   * 为什么是 ipcMain.on 而不是 handle：
   *   - renderer 调用 ipcRenderer.send 是"火后不管"的单向通道，没有返回值预期；
   *   - 避免 renderer 在高频场景下 awaiting invoke 带来的微任务栈压力。
   *
   * 节流由 renderer 负责（100ms + 浅比较）——main 侧不再二次节流，
   * 收到即应用；Electron 的 MenuItem.checked 设置本身是轻量同步操作。
   */
  ipcMain.removeAllListeners("menu:format-state");
  ipcMain.on("menu:format-state", (_event, state) => {
    try {
      applyFormatState(state);
    } catch (err) {
      console.warn("[main] applyFormatState failed:", err);
    }
  });

  // ---------- 模式切换：renderer 主动触发 ----------
  // 前端"设置 / 关于"页可以放一个按钮调用这些接口，等价于走系统菜单。
  ipcMain.removeHandler("mode:switch-to-lite");
  ipcMain.handle("mode:switch-to-lite", async (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    await switchToLite(mainWindow);
    return { ok: true };
  });

  ipcMain.removeHandler("mode:switch-to-full");
  ipcMain.handle("mode:switch-to-full", async (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    await switchToFull();
    return { ok: true };
  });

  ipcMain.removeHandler("mode:change-server");
  ipcMain.handle("mode:change-server", async (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    await changeRemoteServer();
    return { ok: true };
  });

  // ---------- 导出 PDF（renderer 传入完整 HTML，主进程静默生成 PDF 并弹保存对话框） ----------
  //
  // 设计要点：
  //   1. 用一个**离屏 BrowserWindow**（show:false）加载 data: URL 来承载 HTML，
  //      这样能拿到完整 DOM + 完整样式渲染 → webContents.printToPDF 出矢量 PDF，
  //      文字可选、中文不失真，零额外依赖。
  //   2. 等 did-finish-load + 图片全部 decode 后再 printToPDF，避免缺图。
  //   3. 保存路径通过 dialog.showSaveDialog 让用户确认文件名/位置，默认在"文档"目录。
  //   4. 函数签名与 renderer 约定：
  //        invoke("export:note-to-pdf", { html, suggestedName })
  //          → { ok, path?, canceled?, error? }
  ipcMain.removeHandler("export:note-to-pdf");
  ipcMain.handle("export:note-to-pdf", async (event, payload) => {
    // SEC-ELECTRON-01-B: 来源校验
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    const { html, suggestedName } = payload || {};
    if (typeof html !== "string" || !html) {
      return { ok: false, error: "EMPTY_HTML" };
    }

    // 先弹保存对话框（在正式渲染之前，用户取消就不用浪费渲染资源）
    const safeName = String(suggestedName || "note").replace(/[\\/:*?"<>|]/g, "_");
    const defaultPath = path.join(app.getPath("documents"), `${safeName}.pdf`);
    const parentWin = BrowserWindow.getFocusedWindow() || mainWindow;
    const saveRes = await dialog.showSaveDialog(parentWin || null, {
      title: "保存 PDF",
      defaultPath,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (saveRes.canceled || !saveRes.filePath) {
      return { ok: false, canceled: true };
    }
    const outPath = saveRes.filePath;

    // 离屏窗口承载 HTML
    const offscreen = new BrowserWindow({
      show: false,
      width: 900,
      height: 1100,
      webPreferences: {
        offscreen: false,
        sandbox: true,
        contextIsolation: true,
        // 不需要 node 集成，纯展示
        nodeIntegration: false,
        // 禁用外部导航，安全兜底
        webSecurity: true,
      },
    });
    // SEC-ELECTRON-01-C-B2-B3: 禁止 data URL 窗口打开新窗口
    offscreen.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    try {
      // 用 data: URL 加载 HTML；base64 编码避免 URL 中特殊字符截断
      const dataUrl =
        "data:text/html;charset=utf-8;base64," +
        Buffer.from(html, "utf-8").toString("base64");

      await offscreen.loadURL(dataUrl);

      // 等图片全部解码完成（HTML 里可能有 data: 图或 localhost 后端图）
      await offscreen.webContents.executeJavaScript(`
        (async () => {
          const imgs = Array.from(document.images || []);
          await Promise.all(imgs.map(img => {
            if (img.complete && img.naturalWidth > 0) return Promise.resolve();
            return new Promise(res => {
              img.addEventListener('load', res, { once: true });
              img.addEventListener('error', res, { once: true });
              setTimeout(res, 3000); // 兜底 3s
            });
          }));
          // 再给布局一点时间
          await new Promise(r => setTimeout(r, 100));
          return true;
        })()
      `, true);

      const pdfBuffer = await offscreen.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
        margins: { marginType: "default" },
        preferCSSPageSize: true,
      });
      fs.writeFileSync(outPath, pdfBuffer);
      return { ok: true, path: outPath };
    } catch (err) {
      console.error("[export:note-to-pdf] failed:", err);
      return { ok: false, error: String(err && err.message || err) };
    } finally {
      try { offscreen.destroy(); } catch { /* noop */ }
    }
  });
}

// ---------- 生命周期 ----------
// macOS 双击 .md 的 open-file 事件需要在 ready 之前监听
setupMacOpenFile(() => mainWindow);

app.whenReady().then(async () => {
  // 先把 settings 路径定下来（依赖 app.getPath("userData")，必须 ready 后调）
  setSettingsPath(getUserDataPath());
  setCredentialsPath(getUserDataPath());
  folderSync.setDataDir(getUserDataPath());
  const liteOnly = isLiteOnlyBuild();
  const settings = readSettings();
  currentMode = settings.mode;
  currentRemoteUrl = settings.remoteUrl;
  currentHideMenuBar = !!settings.hideMenuBar;

  // SEC-ELECTRON-01-E2: 权限请求拦截 — 默认拒绝高风险权限，仅允许 notifications
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    // 只允许 notifications（任务提醒功能需要），其余全部拒绝
    if (permission === "notifications") {
      callback(true);
      return;
    }
    callback(false);
  });
  // setPermissionCheckHandler: 拦截权限查询（非弹窗类的静默检查）
  if (typeof defaultSession.setPermissionCheckHandler === "function") {
    defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      // 同样只允许 notifications
      return permission === "notifications";
    });
  }

  // SEC-ELECTRON-01-E3.2: CSP Report-Only 注入 — 先观察，不拦截
  // 注意：webRequest.onHeadersReceived 对 file:// 协议不生效（Chromium 限制），
  // 生产环境主窗口通过 loadFile 加载（file://），CSP Report-Only 仅对 http/https 响应生效。
  // 开发环境（Vite dev server）和 lite 模式远程页面会命中此拦截器。
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    // 仅对 HTML 文档注入，跳过 JS/CSS/图片等资源
    const contentType = (responseHeaders["content-type"] || responseHeaders["Content-Type"] || [""])[0] || "";
    if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
      const cspRo = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' file: blob: data: http: https:",
        "connect-src 'self' http: https: ws: wss:",
        "font-src 'self' blob: data:",
        "frame-src blob: data: http: https:",
        "object-src 'none'",
        "worker-src 'self' blob:",
        "media-src 'self' blob:",
      ].join("; ");
      responseHeaders["Content-Security-Policy-Report-Only"] = [cspRo];
    }
    callback({ responseHeaders });
  });
  console.log("[Electron] CSP Report-Only injected via webRequest.onHeadersReceived");

  // Lite-only 包强制使用 lite 模式：哪怕用户手改 settings.json 为 full 也纠正回来
  if (liteOnly && currentMode !== "lite") {
    console.log("[Electron] lite-only build detected, forcing mode=lite");
    currentMode = "lite";
    writeSettings({ mode: "lite", remoteUrl: currentRemoteUrl });
  }

  // Lite-only 首启没有服务器地址：立刻弹 setup 窗口
  if (liteOnly && currentMode === "lite" && !currentRemoteUrl) {
    console.log("[Electron] lite-only first launch, opening setup window");
    registerDiscoveryIpc(); // setup 依赖
    const r = await openSetupWindow({ initialUrl: "" });
    if (!r.ok) {
      // 用户取消 → 直接退出
      app.quit();
      return;
    }
    currentRemoteUrl = r.url;
    writeSettings({ mode: "lite", remoteUrl: r.url });
  }

  console.log(
    `[Electron] mode=${currentMode}${liteOnly ? " (lite-only build)" : ""}` +
      (currentMode === "lite" ? ` remoteUrl=${currentRemoteUrl}` : "")
  );

  createSplash(
    currentMode === "lite"
      ? `正在连接 ${safeHost(currentRemoteUrl)}`
      : "正在启动本地服务"
  );

  // discovery IPC 必须先注册：setup 窗口（首启失败 / 切换模式时）依赖它做 mDNS 列表。
  // 它本身不会启动 mDNS 浏览器，只有 renderer 调 discovery:start 才会启动，因此空跑无副作用。
  registerDiscoveryIpc();

  try {
    if (currentMode === "lite") {
      // Lite：探测远端可达后直接建窗口；不启 backend、不建 DB
      await waitForRemoteReady(currentRemoteUrl, 15000);
    } else {
      await startBackend();
      // Phase A: 后端就绪后立即准备本地零登录账号；失败不阻塞启动
      try {
        localAuthCache = await ensureLocalAccount();
      } catch (e) {
        console.warn("[Electron] ensureLocalAccount failed:", e?.message || e);
        localAuthCache = null;
      }
    }
    createWindow();
  } catch (err) {
    console.error("[Electron] Startup failed:", err);
    showStartupError(err);
    stopBackend();
    // Lite 启动失败时给用户机会改服务器或回退到本地
    if (currentMode === "lite") {
      await offerLiteRecovery();
    } else {
      app.quit();
    }
    return;
  }

  // 原生菜单（accelerator 同时担当全局快捷键）
  buildMenu({
    onCheckForUpdates: () => checkForUpdatesManually(),
    openAboutWindow,
    mode: currentMode,
    liteOnly: isLiteOnlyBuild(),
    onSwitchToLite: () => switchToLite(mainWindow),
    onSwitchToFull: () => switchToFull(),
    onChangeServer: () => changeRemoteServer(),
  });
  applyMenuBarPreference();

  // ---------- macOS Dock Quick Action（HIG：Dock 右键菜单） ----------
  // 用户未启动窗口时右键 Dock 即可快速进入关键操作。app.dock 仅存在于 darwin，
  // 其它平台跳过；点击会先确保主窗口可见并聚焦，再向 renderer 发送业务事件。
  if (process.platform === "darwin" && app.dock) {
    const focusAndSend = (channel) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        // 窗口已销毁（例如最后一个窗口关闭后）：重建
        createWindow();
        // createWindow 是同步的，但实际 show 要等 ready-to-show；事件先落盘
      }
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        // webContents 可能尚未 did-finish-load；对两种情况都覆盖
        if (mainWindow.webContents.isLoading()) {
          mainWindow.webContents.once("did-finish-load", () => {
            mainWindow.webContents.send(channel);
          });
        } else {
          mainWindow.webContents.send(channel);
        }
      }
    };
    const dockMenu = Menu.buildFromTemplate([
      {
        label: "新建笔记",
        click: () => focusAndSend("dock:new-note"),
      },
      {
        label: "搜索笔记",
        click: () => focusAndSend("dock:search"),
      },
    ]);
    app.dock.setMenu(dockMenu);
  }

  // 托盘
  createTray({
    getMainWindow: () => mainWindow,
    onNewNote: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("menu:new-note");
      }
    },
    mode: currentMode,
    liteOnly: isLiteOnlyBuild(),
    onSwitchToLite: () => switchToLite(mainWindow),
    onSwitchToFull: () => switchToFull(),
    onChangeServer: () => changeRemoteServer(),
  });

  // IPC
  registerAppIpc();
  registerCredentialsIpc();

  // 文件夹同步 IPC（SEC-ELECTRON-01-B: 全部加 sender 校验）
  ipcMain.handle("folder-sync:select-folder", async (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths.length) {
      return { cancelled: true };
    }
    return { cancelled: false, path: result.filePaths[0] };
  });
  ipcMain.handle("folder-sync:get-configs", (event) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    return folderSync.readConfigs();
  });
  ipcMain.handle("folder-sync:save-config", (event, config) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    if (!config || typeof config !== "object") return { ok: false, error: "INVALID_CONFIG" };
    // SEC-ELECTRON-01-C-RV1: 主进程侧字段白名单（双层防御，与 preload 对齐）
    const safe = {};
    if (typeof config.folderId === "string") safe.folderId = config.folderId.slice(0, 128);
    if (typeof config.folderPath === "string") safe.folderPath = config.folderPath.slice(0, 4096);
    if (typeof config.targetNotebookId === "string" || config.targetNotebookId === null) {
      safe.targetNotebookId = config.targetNotebookId;
    }
    if (typeof config.includeSubfolders === "boolean") safe.includeSubfolders = config.includeSubfolders;
    if (Array.isArray(config.fileTypes)) {
      const allowedExts = [".md", ".markdown", ".txt", ".html", ".htm", ".pdf", ".docx"];
      safe.fileTypes = config.fileTypes.filter(e => typeof e === "string" && allowedExts.includes(e.toLowerCase()));
    }
    if (typeof config.intervalMinutes === "number" && config.intervalMinutes >= 5 && config.intervalMinutes <= 1440) {
      safe.intervalMinutes = config.intervalMinutes;
    } else if (config.intervalMinutes === null) {
      safe.intervalMinutes = null;
    }
    if (typeof config.enabled === "boolean") safe.enabled = config.enabled;
    return folderSync.saveConfig(safe);
  });

  // SEC-ELECTRON-01-C: folder-sync 参数校验辅助函数
  function validateFolderId(folderId) {
    return typeof folderId === "string" && folderId.length > 0 && folderId.length <= 128
      && !folderId.includes("..") && !folderId.includes("/") && !folderId.includes("\\");
  }
  function validateRelativePath(p) {
    return typeof p === "string" && p.length > 0 && p.length <= 4096
      && !p.includes("..") && !/^[A-Za-z]:/.test(p) && !p.startsWith("/");
  }

  ipcMain.handle("folder-sync:remove-config", (event, folderId) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    if (!validateFolderId(folderId)) return { ok: false, error: "INVALID_FOLDER_ID" };
    return folderSync.removeConfig(folderId);
  });
  ipcMain.handle("folder-sync:get-logs", (event, folderId) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    if (!validateFolderId(folderId)) return { ok: false, error: "INVALID_FOLDER_ID" };
    return folderSync.getLogs(folderId);
  });
  ipcMain.handle("folder-sync:run-now", (event, folderId) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    if (!validateFolderId(folderId)) return { ok: false, error: "INVALID_FOLDER_ID" };
    return folderSync.runNow(folderId);
  });
  ipcMain.handle("folder-sync:get-index", (event, folderId) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    if (!validateFolderId(folderId)) return { ok: false, error: "INVALID_FOLDER_ID" };
    return folderSync.getIndex(folderId);
  });
  ipcMain.handle("folder-sync:get-pending-uploads", (event, folderId) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    if (!validateFolderId(folderId)) return { ok: false, error: "INVALID_FOLDER_ID" };
    return folderSync.getPendingUploads(folderId);
  });
  ipcMain.handle("folder-sync:mark-upload-result", (event, folderId, relativePath, result) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    if (!validateFolderId(folderId)) return { ok: false, error: "INVALID_FOLDER_ID" };
    if (!validateRelativePath(relativePath)) return { ok: false, error: "INVALID_PATH" };
    if (!result || typeof result !== "object") return { ok: false, error: "INVALID_RESULT" };
    return folderSync.markUploadResult(folderId, relativePath, result);
  });
  ipcMain.handle("folder-sync:append-log", (event, folderId, type, message, detail) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    if (!validateFolderId(folderId)) return { ok: false, error: "INVALID_FOLDER_ID" };
    // SEC-ELECTRON-01-C-RV1: 主进程侧 type/message/detail 校验（双层防御）
    const allowedTypes = ["info", "warn", "error", "sync", "upload"];
    const safeType = allowedTypes.includes(type) ? type : "info";
    const safeMsg = typeof message === "string" ? message.slice(0, 1000) : "";
    const safeDetail = typeof detail === "string" ? detail.slice(0, 2000) : "";
    folderSync.appendLog(folderId, safeType, safeMsg, safeDetail);
    return { ok: true };
  });
  ipcMain.handle("folder-sync:get-upload-file", (event, folderId, relativePath) => {
    const reject = assertMainWindowSender(event);
    if (reject) return reject;
    if (!validateFolderId(folderId)) return { ok: false, error: "INVALID_FOLDER_ID" };
    if (!validateRelativePath(relativePath)) return { ok: false, error: "INVALID_PATH" };
    return folderSync.getUploadFile(folderId, relativePath);
  });

  // 局域网服务发现的 IPC 已在更早处注册（setup 窗口依赖它）；这里不重复注册

  // 自动更新（生产环境生效）
  initAutoUpdater({
    onQuitRequested: () => markQuitting(),
  });
  // 把 userData 路径注入 updater，升级前 DB 备份需要从这里取
  setUpdaterContext({ getUserDataPath });

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
