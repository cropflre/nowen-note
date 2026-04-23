// electron/updater.js
// electron-updater 包装：自动检查 + 手动触发 + 事件广播给 renderer。
// publish 配置在 builder.config.js（GitHub Releases 作为 feed）。
const { app, BrowserWindow, dialog, ipcMain } = require("electron");

let autoUpdater = null;
try {
  // electron-updater 是运行时依赖，构建环境可能未安装；开发环境降级为 noop
  autoUpdater = require("electron-updater").autoUpdater;
} catch (e) {
  console.warn("[updater] electron-updater 未安装，更新功能已禁用。");
}

let initialized = false;

function broadcast(status, payload) {
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    if (!w.isDestroyed()) {
      w.webContents.send("updater:status", { status, ...payload });
    }
  }
}

/**
 * 初始化自动更新。仅在打包后的生产环境生效。
 * @param {{ onQuitRequested?: () => void }} [opts]
 */
function initAutoUpdater(opts = {}) {
  if (initialized) return;
  initialized = true;

  if (!autoUpdater || !app.isPackaged) {
    console.log("[updater] 跳过自动更新（dev 或 electron-updater 缺失）");
    // 仍注册 IPC，以便 UI 层调用时给出明确反馈
    registerIpc({ manualTrigger: true, disabled: true });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => broadcast("checking"));
  autoUpdater.on("update-available", (info) =>
    broadcast("available", { version: info?.version })
  );
  autoUpdater.on("update-not-available", () => broadcast("not-available"));
  autoUpdater.on("download-progress", (p) =>
    broadcast("downloading", {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    })
  );
  autoUpdater.on("update-downloaded", (info) => {
    broadcast("downloaded", { version: info?.version });
    // 提示用户立即重启安装
    dialog
      .showMessageBox({
        type: "info",
        buttons: ["立即重启并安装", "稍后"],
        defaultId: 0,
        cancelId: 1,
        title: "更新已下载",
        message: `Nowen Note ${info?.version} 已下载完成`,
        detail: "重启后将自动安装新版本。",
      })
      .then((r) => {
        if (r.response === 0) {
          opts.onQuitRequested?.();
          autoUpdater.quitAndInstall();
        }
      });
  });
  autoUpdater.on("error", (err) =>
    broadcast("error", { message: err?.message || String(err) })
  );

  // 启动 5 秒后静默检查一次
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => console.error("[updater]", e));
  }, 5000);

  registerIpc({ manualTrigger: true, disabled: false });
}

function registerIpc({ disabled } = {}) {
  // 避免重复注册
  ipcMain.removeHandler("updater:check");
  ipcMain.removeHandler("updater:quit-and-install");

  ipcMain.handle("updater:check", async () => {
    if (disabled || !autoUpdater) {
      return { ok: false, reason: "updater-disabled" };
    }
    try {
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, version: r?.updateInfo?.version };
    } catch (e) {
      return { ok: false, reason: e?.message || "check-failed" };
    }
  });

  ipcMain.handle("updater:quit-and-install", () => {
    if (disabled || !autoUpdater) return { ok: false };
    autoUpdater.quitAndInstall();
    return { ok: true };
  });
}

/** 供菜单"检查更新"调用 */
async function checkForUpdatesManually() {
  if (!autoUpdater || !app.isPackaged) {
    await dialog.showMessageBox({
      type: "info",
      message: "当前为开发模式",
      detail: "自动更新仅在打包后的正式版本中可用。",
    });
    return;
  }
  try {
    broadcast("checking");
    const r = await autoUpdater.checkForUpdates();
    if (!r || !r.updateInfo) {
      await dialog.showMessageBox({ type: "info", message: "已是最新版本" });
    }
  } catch (e) {
    await dialog.showErrorBox("检查更新失败", e?.message || String(e));
  }
}

module.exports = { initAutoUpdater, checkForUpdatesManually };
