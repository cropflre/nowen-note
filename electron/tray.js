// electron/tray.js
// 托盘图标 + 右键菜单；关闭窗口改为隐藏到托盘。
const { Tray, Menu, nativeImage, app, BrowserWindow } = require("electron");
const path = require("path");
const { isChineseLocale, resolveSystemLocale } = require("./locale");

let tray = null;
let isQuitting = false;
let currentDeps = null;

function markQuitting() {
  isQuitting = true;
}
function getIsQuitting() {
  return isQuitting;
}

function buildTrayMenuTemplate(deps = {}) {
  const isLite = deps.mode === "lite";
  const liteOnly = !!deps.liteOnly;
  const resolvedLocale = deps.locale || resolveSystemLocale({ appLocale: app?.getLocale?.() });
  const zh = isChineseLocale(resolvedLocale);
  const copy = zh
    ? {
        changeServer: "更换服务器…",
        switchToFull: "切换到本地模式",
        switchToLite: "切换到轻量模式…",
        showMain: "显示主窗口",
        newNote: "新建笔记",
        currentMode: `当前模式：${isLite ? (liteOnly ? "轻量发行版" : "轻量（远端）") : "本地"}`,
        quit: "退出",
      }
    : {
        changeServer: "Change Server…",
        switchToFull: "Switch to Local Mode",
        switchToLite: "Switch to Lite Mode…",
        showMain: "Show Window",
        newNote: "New Note",
        currentMode: `Mode: ${isLite ? (liteOnly ? "Lite Edition" : "Lite (Remote)") : "Local"}`,
        quit: "Quit",
      };

  // 模式相关项：与系统菜单的"模式"子菜单保持一致
  const modeItems = isLite
    ? [
        { label: copy.changeServer, click: () => deps.onChangeServer?.() },
        ...(liteOnly
          ? []
          : [{ label: copy.switchToFull, click: () => deps.onSwitchToFull?.() }]),
      ]
    : [
        { label: copy.switchToLite, click: () => deps.onSwitchToLite?.() },
      ];

  return [
    {
      label: copy.showMain,
      click: () => showMain(deps.getMainWindow),
    },
    {
      label: copy.newNote,
      click: () => {
        showMain(deps.getMainWindow);
        deps.onNewNote?.();
      },
    },
    { type: "separator" },
    {
      label: copy.currentMode,
      submenu: modeItems,
    },
    { type: "separator" },
    {
      label: copy.quit,
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ];
}

/**
 * 创建托盘。
 * @param {{
 *   getMainWindow: () => BrowserWindow | null,
 *   onNewNote: () => void,
 *   mode?: "full" | "lite",
 *   locale?: string,
 *   onSwitchToLite?: () => void,
 *   onSwitchToFull?: () => void,
 *   onChangeServer?: () => void,
 * }} deps
 */
function createTray(deps) {
  currentDeps = deps;
  const iconPath = path.join(__dirname, "icon.png");
  const image = nativeImage.createFromPath(iconPath);
  // macOS 托盘建议用 16x16 模板图；这里简单缩放，模板色问题留给后续单独切图
  const trayImage =
    process.platform === "darwin" ? image.resize({ width: 18, height: 18 }) : image;

  tray = new Tray(trayImage);
  tray.setToolTip("Nowen Note");

  const contextMenu = Menu.buildFromTemplate(buildTrayMenuTemplate(deps));
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

function updateTrayMenu(overrides = {}) {
  if (!tray || tray.isDestroyed() || !currentDeps) return;
  currentDeps = { ...currentDeps, ...overrides };
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(currentDeps)));
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
  currentDeps = null;
}

module.exports = {
  createTray,
  updateTrayMenu,
  buildTrayMenuTemplate,
  destroyTray,
  markQuitting,
  getIsQuitting,
};
