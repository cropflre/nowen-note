// electron/updater.js
//
// Nowen Note 桌面端应用更新状态机：
//   Windows/Linux: idle -> checking -> available -> downloading -> downloaded -> installing
//   macOS:         idle -> checking -> available -> browser manual download
//
// 设计原则：
//   - 仅使用 electron-builder 固定的官方 GitHub Release provider；renderer 无法传入 URL。
//   - 禁止预发布版与降级，版本比较、平台/架构选择、SHA-512 校验交给 electron-updater。
//   - 检测到版本后先由应用内 UI 征得用户同意，再开始下载（autoDownload=false）。
//   - macOS 暂停应用内下载和静默安装：用户确认更新后，由系统浏览器打开对应 Release。
//   - 兼容旧 preload：继续复用 updater:check / updater:quit-and-install 两个 IPC。
//   - 安装前广播 preparing-install，让 renderer 有时间触发编辑器立即保存和队列落盘。
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const {
  buildReleaseDownloadUrl,
  isManualDownloadPlatform,
  withManualDownloadNotice,
} = require("./updaterPolicy");

let autoUpdater = null;
try {
  autoUpdater = require("electron-updater").autoUpdater;
} catch (error) {
  console.warn("[updater] electron-updater 未安装，更新功能已禁用。", error?.message || "");
}

let initialized = false;
let checkPromise = null;
let downloadPromise = null;
let installPromise = null;
let availableInfo = null;
let lastErrorStage = "check";
let backupPrepared = false;

let state = {
  status: "idle",
  phase: "idle",
  currentVersion: "",
  version: null,
  releaseName: "",
  releaseNotes: "",
  releaseDate: "",
  fileSize: null,
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  checkedAt: null,
  installOnQuit: false,
  manualDownload: isManualDownloadPlatform(),
  downloadUrl: "",
  message: "",
  errorStage: null,
  platform: process.platform,
  arch: process.arch,
};

let ctx = {
  getUserDataPath: () => {
    try {
      return path.join(app.getPath("userData"), "nowen-data");
    } catch {
      return null;
    }
  },
};

function setUpdaterContext(next) {
  if (next && typeof next.getUserDataPath === "function") {
    ctx.getUserDataPath = next.getUserDataPath;
  }
}

function isPortableBuild() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
}

function isUnsupportedLinuxPackage() {
  // electron-updater 对 Linux 的完整自动安装依赖 AppImage 环境变量。
  return process.platform === "linux" && !process.env.APPIMAGE;
}

function updaterDisabledReason() {
  if (!autoUpdater) return "updater-unavailable";
  if (!app.isPackaged) return "development-build";
  if (isPortableBuild()) return "portable-build";
  if (isUnsupportedLinuxPackage()) return "linux-package-not-supported";
  return null;
}

function sanitizeError(error) {
  let message = error?.message || String(error || "更新失败");
  // 日志/renderer 不暴露 URL query、GitHub token、Authorization 等敏感值。
  message = message
    .replace(/([?&](?:token|access_token|auth|signature|sig)=)[^&\s]+/gi, "$1***")
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1***")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "***")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return message.slice(0, 500) || "更新失败";
}

function normalizeReleaseNotes(value) {
  if (typeof value === "string") return value.trim().slice(0, 5000);
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry.note === "string") return entry.note;
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim()
    .slice(0, 5000);
}

function pickFileSize(info) {
  if (!info || !Array.isArray(info.files)) return null;
  const sizes = info.files
    .map((file) => Number(file?.size))
    .filter((size) => Number.isFinite(size) && size > 0);
  return sizes.length ? Math.max(...sizes) : null;
}

function publicState() {
  return { ...state };
}

function broadcast(status, patch = {}) {
  state = {
    ...state,
    ...patch,
    status,
    currentVersion: state.currentVersion || app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("updater:status", publicState());
    }
  }
  return publicState();
}

function infoPayload(info) {
  const releaseNotes = normalizeReleaseNotes(info?.releaseNotes);
  return {
    version: typeof info?.version === "string" ? info.version : null,
    releaseName: typeof info?.releaseName === "string" ? info.releaseName.slice(0, 300) : "",
    releaseNotes: isManualDownloadPlatform()
      ? withManualDownloadNotice(releaseNotes).slice(0, 5000)
      : releaseNotes,
    releaseDate: typeof info?.releaseDate === "string" ? info.releaseDate : "",
    fileSize: pickFileSize(info),
  };
}

function isStableVersion(version) {
  return typeof version === "string" && /^v?\d+\.\d+\.\d+(?:\+[^-\s]+)?$/.test(version.trim());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentDownloadUrl() {
  return buildReleaseDownloadUrl(state.version || availableInfo?.version);
}

async function openManualDownloadPage() {
  const url = currentDownloadUrl();
  try {
    await shell.openExternal(url);
    return {
      ok: true,
      external: true,
      url,
      state: broadcast("available", {
        phase: "update-available",
        manualDownload: true,
        downloadUrl: url,
        installOnQuit: false,
        message: "已打开浏览器，请下载对应芯片版本并手动安装",
        errorStage: null,
      }),
    };
  } catch (error) {
    const message = sanitizeError(error);
    console.error("[updater] open manual download page failed:", message);
    return {
      ok: false,
      reason: message,
      url,
      state: broadcast("error", {
        phase: "error",
        manualDownload: true,
        downloadUrl: url,
        installOnQuit: false,
        message: `无法打开浏览器：${message}`,
        errorStage: "download",
      }),
    };
  }
}

/**
 * 升级前备份 SQLite 主库及 WAL/SHM。每次升级放入独立目录，只保留最近 3 份。
 * 同时保存 WAL/SHM 比只复制 .db 更能覆盖尚未 checkpoint 的最新事务。
 */
function backupDatabaseBeforeUpdate() {
  if (backupPrepared) return;
  backupPrepared = true;
  try {
    const userDataPath = ctx.getUserDataPath?.();
    if (!userDataPath) return;
    const dbPath = path.join(userDataPath, "nowen-note.db");
    if (!fs.existsSync(dbPath)) return;

    const root = path.join(userDataPath, "backups-pre-update");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const targetDir = path.join(root, stamp);
    fs.mkdirSync(targetDir, { recursive: true });

    for (const suffix of ["", "-wal", "-shm"]) {
      const source = dbPath + suffix;
      if (fs.existsSync(source)) {
        fs.copyFileSync(source, path.join(targetDir, `nowen-note.db${suffix}`));
      }
    }
    fs.writeFileSync(
      path.join(targetDir, "update.json"),
      JSON.stringify(
        {
          fromVersion: app.getVersion(),
          toVersion: state.version,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    const directories = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const old of directories.slice(0, Math.max(0, directories.length - 3))) {
      fs.rmSync(path.join(root, old), { recursive: true, force: true });
    }
    console.log("[updater] 升级前数据快照已创建", targetDir);
  } catch (error) {
    // 备份失败不静默，但也不能把已验证通过的更新变成启动阻断。
    console.warn("[updater] 升级前备份失败：", sanitizeError(error));
  }
}

async function checkNow({ manual = false } = {}) {
  const disabled = updaterDisabledReason();
  if (disabled) {
    return {
      ok: false,
      reason: disabled,
      state: broadcast("error", {
        phase: "error",
        message: disabled,
        errorStage: "check",
        manual,
      }),
    };
  }
  if (checkPromise) return checkPromise;
  if (["downloading", "downloaded", "preparing-install", "installing"].includes(state.status)) {
    return { ok: true, state: publicState() };
  }

  lastErrorStage = "check";
  broadcast("checking", {
    phase: "checking",
    message: "",
    errorStage: null,
    manual,
    checkedAt: new Date().toISOString(),
  });

  checkPromise = autoUpdater
    .checkForUpdates()
    .then((result) => ({
      ok: true,
      version: result?.updateInfo?.version,
      state: publicState(),
    }))
    .catch((error) => {
      const message = sanitizeError(error);
      console.error("[updater] check failed:", message);
      return {
        ok: false,
        reason: message,
        state: broadcast("error", {
          phase: "error",
          message,
          errorStage: "check",
          manual,
        }),
      };
    })
    .finally(() => {
      checkPromise = null;
    });
  return checkPromise;
}

async function downloadAvailableUpdate() {
  if (!autoUpdater || !availableInfo) {
    return { ok: false, reason: "no-update-available", state: publicState() };
  }
  if (isManualDownloadPlatform()) return openManualDownloadPage();
  if (downloadPromise) return downloadPromise;
  if (state.status === "downloaded") return { ok: true, state: publicState() };

  lastErrorStage = "download";
  autoUpdater.autoInstallOnAppQuit = false;
  broadcast("downloading", {
    phase: "downloading",
    percent: 0,
    transferred: 0,
    total: state.fileSize || 0,
    bytesPerSecond: 0,
    message: "",
    errorStage: null,
    installOnQuit: false,
  });

  downloadPromise = autoUpdater
    .downloadUpdate()
    .then(() => ({ ok: true, state: publicState() }))
    .catch((error) => {
      const message = sanitizeError(error);
      console.error("[updater] download failed:", message);
      return {
        ok: false,
        reason: message,
        state: broadcast("error", {
          phase: "error",
          message,
          errorStage: "download",
        }),
      };
    })
    .finally(() => {
      downloadPromise = null;
    });
  return downloadPromise;
}

function armInstallOnQuit() {
  if (isManualDownloadPlatform()) {
    return {
      ok: false,
      reason: "manual-download-required",
      url: currentDownloadUrl(),
      state: publicState(),
    };
  }
  if (!autoUpdater || state.status !== "downloaded") {
    return { ok: false, reason: "update-not-downloaded", state: publicState() };
  }
  autoUpdater.autoInstallOnAppQuit = true;
  const next = broadcast("downloaded", {
    phase: "downloaded",
    installOnQuit: true,
    message: "退出应用时将自动安装更新",
  });
  return { ok: true, armed: true, state: next };
}

async function installNow(opts = {}) {
  if (isManualDownloadPlatform()) return openManualDownloadPage();
  if (!autoUpdater || state.status !== "downloaded") {
    return { ok: false, reason: "update-not-downloaded", state: publicState() };
  }
  if (installPromise) return installPromise;

  installPromise = (async () => {
    // renderer 收到此状态后会立即触发 Ctrl/Cmd+S、blur 和自定义 flush 事件。
    broadcast("preparing-install", {
      phase: "installing",
      message: "正在保存笔记和同步队列…",
      installOnQuit: false,
    });
    await delay(1800);

    backupDatabaseBeforeUpdate();
    try {
      opts.onQuitRequested?.();
    } catch (error) {
      console.warn("[updater] onQuitRequested failed:", sanitizeError(error));
    }

    broadcast("installing", {
      phase: "installing",
      message: "正在退出并安装更新…",
    });

    // 先让 invoke 返回，随后退出。isSilent=false 让 Windows 安装器在需要时能展示 UAC。
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (error) {
        const message = sanitizeError(error);
        console.error("[updater] quitAndInstall failed:", message);
        broadcast("error", {
          phase: "error",
          message,
          errorStage: "install",
        });
        installPromise = null;
      }
    }, 150);
    return { ok: true, state: publicState() };
  })();

  return installPromise;
}

function registerIpc(opts, disabled) {
  ipcMain.removeHandler("updater:check");
  ipcMain.removeHandler("updater:quit-and-install");

  ipcMain.handle("updater:check", async () => {
    if (disabled) return { ok: false, reason: disabled, state: publicState() };

    // 兼容旧 preload 的单一 checkForUpdates()：按状态推进下一步。
    // macOS 的 available 分支会打开系统浏览器，不进入 downloadUpdate/quitAndInstall。
    if (state.status === "available") return downloadAvailableUpdate();
    if (state.status === "downloaded") return armInstallOnQuit();
    if (state.status === "error" && lastErrorStage === "download" && availableInfo) {
      return downloadAvailableUpdate();
    }
    if (["checking", "downloading", "preparing-install", "installing"].includes(state.status)) {
      return { ok: true, state: publicState() };
    }
    return checkNow({ manual: true });
  });

  ipcMain.handle("updater:quit-and-install", () => installNow(opts));
}

function initAutoUpdater(opts = {}) {
  if (initialized) return;
  initialized = true;
  state.currentVersion = app.getVersion();

  const disabled = updaterDisabledReason();
  if (disabled) {
    console.log("[updater] 自动更新不可用：", disabled);
    registerIpc(opts, disabled);
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.autoRunAppAfterInstall = true;

  autoUpdater.on("checking-for-update", () => {
    if (state.status !== "checking") {
      broadcast("checking", {
        phase: "checking",
        checkedAt: new Date().toISOString(),
        message: "",
        errorStage: null,
      });
    }
  });

  autoUpdater.on("update-available", (info) => {
    // 双保险：provider 已禁止 prerelease；元数据异常时仍拒绝下载。
    if (!isStableVersion(info?.version)) {
      console.warn("[updater] 忽略非稳定或非法版本：", info?.version);
      availableInfo = null;
      broadcast("not-available", {
        phase: "up-to-date",
        version: null,
        message: "当前已是最新稳定版",
        checkedAt: new Date().toISOString(),
      });
      return;
    }
    availableInfo = info;
    backupPrepared = false;
    const manualDownload = isManualDownloadPlatform();
    const downloadUrl = manualDownload ? buildReleaseDownloadUrl(info.version) : "";
    broadcast("available", {
      phase: "update-available",
      ...infoPayload(info),
      percent: 0,
      transferred: 0,
      total: pickFileSize(info) || 0,
      bytesPerSecond: 0,
      checkedAt: new Date().toISOString(),
      installOnQuit: false,
      manualDownload,
      downloadUrl,
      message: manualDownload
        ? "发现新版本，点击更新后将打开浏览器下载安装包"
        : "发现新版本",
      errorStage: null,
    });
  });

  autoUpdater.on("update-not-available", () => {
    availableInfo = null;
    broadcast("not-available", {
      phase: "up-to-date",
      version: null,
      releaseName: "",
      releaseNotes: "",
      fileSize: null,
      checkedAt: new Date().toISOString(),
      installOnQuit: false,
      manualDownload: isManualDownloadPlatform(),
      downloadUrl: "",
      message: "已是最新版本",
      errorStage: null,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    // 理论上 macOS 不会进入该事件；保留防御，避免旧缓存/第三方调用污染状态。
    if (isManualDownloadPlatform()) return;
    broadcast("downloading", {
      phase: "downloading",
      percent: Number(progress?.percent) || 0,
      transferred: Number(progress?.transferred) || 0,
      total: Number(progress?.total) || state.total || 0,
      bytesPerSecond: Number(progress?.bytesPerSecond) || 0,
      message: "正在下载更新",
      errorStage: null,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    if (isManualDownloadPlatform()) {
      availableInfo = info || availableInfo;
      autoUpdater.autoInstallOnAppQuit = false;
      broadcast("available", {
        phase: "update-available",
        ...infoPayload(info || availableInfo),
        percent: 0,
        transferred: 0,
        installOnQuit: false,
        manualDownload: true,
        downloadUrl: currentDownloadUrl(),
        message: "macOS 暂不支持客户端内安装，请前往浏览器下载",
        errorStage: null,
      });
      return;
    }
    availableInfo = info || availableInfo;
    autoUpdater.autoInstallOnAppQuit = false;
    broadcast("downloaded", {
      phase: "downloaded",
      ...infoPayload(info || availableInfo),
      percent: 100,
      transferred: state.total || state.transferred,
      installOnQuit: false,
      message: "更新已下载完成",
      errorStage: null,
    });
  });

  autoUpdater.on("error", (error) => {
    // checkNow/downloadUpdate 自己会输出更准确的阶段；事件仅兜底未知异步错误。
    if (state.status === "error") return;
    const message = sanitizeError(error);
    broadcast("error", {
      phase: "error",
      message,
      errorStage: lastErrorStage,
    });
  });

  app.on("before-quit", () => {
    if (!isManualDownloadPlatform() && state.status === "downloaded" && state.installOnQuit) {
      backupDatabaseBeforeUpdate();
    }
  });

  registerIpc(opts, null);
  // 自动检查由 renderer 在主 UI 挂载并读取用户偏好后触发，避免启动阶段丢事件。
}

/** 系统菜单“检查更新”：只检查；macOS 已发现更新时打开浏览器下载页。 */
async function checkForUpdatesManually() {
  const disabled = updaterDisabledReason();
  if (disabled) {
    await dialog.showMessageBox({
      type: "info",
      title: "无法自动更新",
      message: disabled === "portable-build" ? "免安装版不支持自动更新" : "当前版本无法使用自动更新",
      detail:
        disabled === "development-build"
          ? "自动更新仅在打包后的正式安装版中可用。"
          : "请在“设置 → 关于”中查看当前发行包的更新说明。",
    });
    return;
  }

  if (state.status === "available") {
    if (isManualDownloadPlatform()) {
      await openManualDownloadPage();
      return;
    }
    broadcast("available", { ...state, manual: true });
    return;
  }
  if (["downloading", "downloaded", "preparing-install", "installing"].includes(state.status)) {
    broadcast(state.status, { ...state, manual: true });
    return;
  }

  const result = await checkNow({ manual: true });
  if (result.ok && result.state?.status === "not-available") {
    await dialog.showMessageBox({ type: "info", title: "检查更新", message: "当前已是最新版本" });
  }
}

module.exports = {
  initAutoUpdater,
  checkForUpdatesManually,
  setUpdaterContext,
};
