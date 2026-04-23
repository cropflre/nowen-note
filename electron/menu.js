// electron/menu.js
// 构建跨平台原生菜单；菜单项的 accelerator 即作为窗口快捷键生效。
// 通过 IPC 把动作透传给 renderer（frontend 侦听 window.nowenDesktop.on("menu:xxx", ...)）。
const { Menu, app, shell, BrowserWindow } = require("electron");

const isMac = process.platform === "darwin";

/** 发送菜单事件给当前聚焦窗口 */
function send(channel, payload) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function buildMenu({ onCheckForUpdates, openAboutWindow } = {}) {
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    // macOS 第一项必须是 app 名
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "检查更新…",
                click: () => onCheckForUpdates?.(),
              },
              {
                label: "偏好设置…",
                accelerator: "CmdOrCtrl+,",
                click: () => send("menu:open-settings"),
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),

    // 文件
    {
      label: "文件(&F)",
      submenu: [
        {
          label: "新建笔记",
          accelerator: "Alt+N",
          click: () => send("menu:new-note"),
        },
        { type: "separator" },
        {
          label: "搜索笔记",
          accelerator: "CmdOrCtrl+F",
          click: () => send("menu:search"),
        },
        { type: "separator" },
        ...(!isMac
          ? [
              {
                label: "设置",
                accelerator: "CmdOrCtrl+,",
                click: () => send("menu:open-settings"),
              },
              { type: "separator" },
              { role: "quit", label: "退出" },
            ]
          : [{ role: "close", label: "关闭窗口" }]),
      ],
    },

    // 编辑
    {
      label: "编辑(&E)",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "pasteAndMatchStyle", label: "粘贴并匹配样式" },
        { role: "delete", label: "删除" },
        { role: "selectAll", label: "全选" },
      ],
    },

    // 视图
    {
      label: "视图(&V)",
      submenu: [
        {
          label: "切换侧边栏",
          accelerator: "CmdOrCtrl+B",
          click: () => send("menu:toggle-sidebar"),
        },
        {
          label: "聚焦笔记列表",
          accelerator: "CmdOrCtrl+L",
          click: () => send("menu:focus-note-list"),
        },
        { type: "separator" },
        { role: "reload", label: "刷新" },
        { role: "forceReload", label: "强制刷新" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        {
          label: "放大",
          accelerator: "CmdOrCtrl+=",
          click: () => send("menu:zoom-in"),
          role: "zoomIn",
        },
        {
          label: "缩小",
          accelerator: "CmdOrCtrl+-",
          click: () => send("menu:zoom-out"),
          role: "zoomOut",
        },
        {
          label: "重置缩放",
          accelerator: "CmdOrCtrl+0",
          click: () => send("menu:zoom-reset"),
          role: "resetZoom",
        },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },

    // 窗口
    {
      label: "窗口(&W)",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(isMac
          ? [
              { type: "separator" },
              { role: "front", label: "全部置前" },
              { type: "separator" },
              { role: "window" },
            ]
          : [{ role: "close", label: "关闭" }]),
      ],
    },

    // 帮助
    {
      role: "help",
      label: "帮助(&H)",
      submenu: [
        {
          label: "项目主页",
          click: () => shell.openExternal("https://github.com/"),
        },
        {
          label: "报告问题",
          click: () => shell.openExternal("https://github.com/"),
        },
        { type: "separator" },
        {
          label: "检查更新…",
          click: () => onCheckForUpdates?.(),
        },
        ...(!isMac
          ? [
              { type: "separator" },
              {
                label: "关于 Nowen Note",
                click: () => openAboutWindow?.(),
              },
            ]
          : []),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { buildMenu };
