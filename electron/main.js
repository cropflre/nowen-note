const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const { fork } = require("child_process");

let mainWindow = null;
let backendProcess = null;
const BACKEND_PORT = 3001;

// 获取用户数据目录（存放 SQLite 数据库和字体文件）
function getUserDataPath() {
  return path.join(app.getPath("userData"), "nowen-data");
}

// 获取后端入口路径
function getBackendEntry() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "backend", "dist", "index.js");
  }
  return path.join(__dirname, "..", "backend", "dist", "index.js");
}

// 获取前端静态文件目录
function getFrontendDist() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "frontend", "dist");
  }
  return path.join(__dirname, "..", "frontend", "dist");
}

// 启动后端服务
function startBackend() {
  return new Promise((resolve, reject) => {
    const backendEntry = getBackendEntry();
    const userDataPath = getUserDataPath();
    const dbPath = path.join(userDataPath, "nowen-note.db");

    // 后端 cwd 设为 userData，这样 process.cwd()/data/ 路径正常工作
    const backendCwd = app.isPackaged
      ? path.join(process.resourcesPath)
      : path.join(__dirname, "..");

    console.log("[Electron] Starting backend:", backendEntry);
    console.log("[Electron] DB path:", dbPath);
    console.log("[Electron] Backend CWD:", backendCwd);

    backendProcess = fork(backendEntry, [], {
      cwd: backendCwd,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(BACKEND_PORT),
        DB_PATH: dbPath,
        ELECTRON_USER_DATA: userDataPath,
        FRONTEND_DIST: getFrontendDist(),
      },
      silent: true,
    });

    backendProcess.stdout.on("data", (data) => {
      const msg = data.toString();
      console.log("[Backend]", msg);
      if (msg.includes("running on")) {
        resolve();
      }
    });

    backendProcess.stderr.on("data", (data) => {
      console.error("[Backend Error]", data.toString());
    });

    backendProcess.on("error", (err) => {
      console.error("[Backend] Failed to start:", err);
      reject(err);
    });

    backendProcess.on("exit", (code) => {
      console.log("[Backend] Exited with code:", code);
      backendProcess = null;
    });

    // 超时兜底：如果 3 秒内没收到 ready 信号，也尝试继续
    setTimeout(() => resolve(), 3000);
  });
}

// 停止后端服务
function stopBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

// 创建主窗口
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Nowen Note",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  // 加载前端页面（通过后端服务提供）
  mainWindow.loadURL(`http://localhost:${BACKEND_PORT}`);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// App 生命周期
app.whenReady().then(async () => {
  try {
    await startBackend();
    createWindow();
  } catch (err) {
    console.error("[Electron] Failed to start:", err);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopBackend();
});
