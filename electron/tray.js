// electron/tray.js
// 托盘图标 + 右键菜单；关闭窗口改为隐藏到托盘。
const { Tray, Menu, nativeImage, app, BrowserWindow } = require("electron");
const path = require("path");

let tray = null;
let isQuitting = false;

function markQuitting() {
  isQuitting = true;
}
function getIsQuitting() {
  return isQuitting;
}

/**
 * 创建托盘。
 * @param {{ getMainWindow: () => BrowserWindow | null, onNewNote: () => void }} deps
 */
function createTray(deps) {
  const iconPath = path.join(__dirname, "icon.png");
  const image = nativeImage.createFromPath(iconPath);
  // macOS 托盘建议用 16x16 模板图；这里简单缩放，模板色问题留给后续单独切图
  const trayImage =
    process.platform === "darwin" ? image.resize({ width: 18, height: 18 }) : image;

  tray = new Tray(trayImage);
  tray.setToolTip("Nowen Note");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "显示主窗口",
      click: () => showMain(deps.getMainWindow),
    },
    {
      label: "新建笔记",
      click: () => {
        showMain(deps.getMainWindow);
        deps.onNewNote?.();
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);

  // 左键点击：Windows/Linux 切换主窗口显示；macOS 只做显示
  tray.on("click", () => {
    const win = deps.getMainWindow();
    if (!win) return;
    if (process.platform === "darwin") {
      showMain(deps.getMainWindow);
      return;
    }
    if (win.isVisible() && !win.isMinimized()) {
      win.hide();
    } else {
      showMain(deps.getMainWindow);
    }
  });

  return tray;
}

function showMain(getMainWindow) {
  const win = getMainWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function destroyTray() {
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = null;
}

module.exports = { createTray, destroyTray, markQuitting, getIsQuitting };
