// electron/menu.js
// 构建跨平台原生菜单；可自定义命令由 renderer 注册表处理，菜单项保留点击入口。
// 通过 IPC 把动作透传给 renderer（frontend 侦听 window.nowenDesktop.on("menu:xxx", ...)）。
//
// 本文件按 Apple Human Interface Guidelines 排列 macOS 菜单顺序：
//   App → 文件 → 编辑 → 格式 → 视图 → 窗口 → 帮助
// 每个菜单内部也遵循 HIG 推荐分组（新建/打开/保存/导出 分组之间用分隔线隔开）。
// Windows/Linux 菜单栏不存在 macOS 的 App 菜单，应用级动作（偏好设置/退出）
// 落到"文件"菜单末尾，与系统惯例一致。
const { Menu, app, shell, BrowserWindow } = require("electron");
const { isChineseLocale, resolveSystemLocale } = require("./locale");

const isMac = process.platform === "darwin";

/** 发送菜单事件给当前聚焦窗口 */
function send(channel, payload) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function getMenuCopy(locale, appName) {
  const zh = isChineseLocale(locale);
  return zh
    ? {
        about: `关于 ${appName}`,
        checkUpdates: "检查更新…",
        preferences: "偏好设置…",
        settings: "设置",
        services: "服务",
        hide: `隐藏 ${appName}`,
        hideOthers: "隐藏其他",
        unhide: "全部显示",
        quitApp: `退出 ${appName}`,
        quit: "退出",
        changeServer: "更换服务器…",
        switchToFull: "切换到本地模式",
        switchToLite: "切换到轻量模式…",
        modeLiteOnly: "模式：轻量发行版",
        modeLite: "模式：轻量（远端）",
        modeLocal: "模式：本地",
        file: isMac ? "文件" : "文件(&F)",
        newNote: "新建笔记",
        searchNotes: "搜索笔记…",
        closeWindow: "关闭窗口",
        edit: isMac ? "编辑" : "编辑(&E)",
        undo: "撤销",
        redo: "重做",
        cut: "剪切",
        copy: "复制",
        paste: "粘贴",
        pasteAndMatchStyle: "粘贴并匹配样式",
        del: "删除",
        selectAll: "全选",
        format: isMac ? "格式" : "格式(&O)",
        bold: "加粗",
        italic: "斜体",
        underline: "下划线",
        strike: "删除线",
        inlineCode: "行内代码",
        heading: (n) => `标题 ${n}`,
        paragraph: "正文",
        view: isMac ? "视图" : "视图(&V)",
        toggleSidebar: "切换侧边栏",
        focusNoteList: "聚焦笔记列表",
        zoomIn: "放大",
        zoomOut: "缩小",
        resetZoom: "实际大小",
        toggleFullScreen: "进入全屏",
        reload: "刷新",
        forceReload: "强制刷新",
        toggleDevTools: "开发者工具",
        window: isMac ? "窗口" : "窗口(&W)",
        minimize: "最小化",
        zoom: "缩放",
        front: "全部置前",
        close: "关闭",
        help: isMac ? "帮助" : "帮助(&H)",
        shortcuts: "键盘快捷键",
        homepage: "项目主页",
        reportIssue: "报告问题",
      }
    : {
        about: `About ${appName}`,
        checkUpdates: "Check for Updates…",
        preferences: "Settings…",
        settings: "Settings",
        services: "Services",
        hide: `Hide ${appName}`,
        hideOthers: "Hide Others",
        unhide: "Show All",
        quitApp: `Quit ${appName}`,
        quit: "Quit",
        changeServer: "Change Server…",
        switchToFull: "Switch to Local Mode",
        switchToLite: "Switch to Lite Mode…",
        modeLiteOnly: "Mode: Lite Edition",
        modeLite: "Mode: Lite (Remote)",
        modeLocal: "Mode: Local",
        file: isMac ? "File" : "&File",
        newNote: "New Note",
        searchNotes: "Search Notes…",
        closeWindow: "Close Window",
        edit: isMac ? "Edit" : "&Edit",
        undo: "Undo",
        redo: "Redo",
        cut: "Cut",
        copy: "Copy",
        paste: "Paste",
        pasteAndMatchStyle: "Paste and Match Style",
        del: "Delete",
        selectAll: "Select All",
        format: isMac ? "Format" : "F&ormat",
        bold: "Bold",
        italic: "Italic",
        underline: "Underline",
        strike: "Strikethrough",
        inlineCode: "Inline Code",
        heading: (n) => `Heading ${n}`,
        paragraph: "Paragraph",
        view: isMac ? "View" : "&View",
        toggleSidebar: "Toggle Sidebar",
        focusNoteList: "Focus Note List",
        zoomIn: "Zoom In",
        zoomOut: "Zoom Out",
        resetZoom: "Actual Size",
        toggleFullScreen: "Toggle Full Screen",
        reload: "Reload",
        forceReload: "Force Reload",
        toggleDevTools: "Toggle Developer Tools",
        window: isMac ? "Window" : "&Window",
        minimize: "Minimize",
        zoom: "Zoom",
        front: "Bring All to Front",
        close: "Close",
        help: isMac ? "Help" : "&Help",
        shortcuts: "Keyboard Shortcuts",
        homepage: "Project Homepage",
        reportIssue: "Report an Issue",
      };
}

function buildMenuTemplate({
  onCheckForUpdates,
  openAboutWindow,
  mode = "full",
  liteOnly = false,
  onSwitchToLite,
  onSwitchToFull,
  onChangeServer,
  locale,
  appName,
  isDev: isDevOption,
} = {}) {
  const resolvedLocale = locale || resolveSystemLocale({ appLocale: app?.getLocale?.() });
  const resolvedAppName = appName || app?.name || "Nowen Note";
  const isDev = typeof isDevOption === "boolean" ? isDevOption : !app?.isPackaged;
  const isLite = mode === "lite";
  const copy = getMenuCopy(resolvedLocale, resolvedAppName);

  // "模式"子菜单：根据当前模式动态显示可用项
  //   full：仅显示"切换到轻量模式…"
  //   lite：显示"更换服务器…" + "切换到本地模式"
  //   liteOnly 发行版：只显示"更换服务器…"（因为没有 backend 可回）
  // 这样 UI 不会出现"我已经在 Lite 还显示一个 Lite 选项"这种鸡肋项。
  const modeSubmenu = isLite
    ? [
        {
          label: copy.changeServer,
          click: () => onChangeServer?.(),
        },
        ...(liteOnly
          ? []
          : [
              {
                label: copy.switchToFull,
                click: () => onSwitchToFull?.(),
              },
            ]),
      ]
    : [
        {
          label: copy.switchToLite,
          click: () => onSwitchToLite?.(),
        },
      ];
  const modeLabel = isLite
    ? (liteOnly ? copy.modeLiteOnly : copy.modeLite)
    : copy.modeLocal;
  /** @type {Electron.MenuItemConstructorOptions[]} */
  return [
    // ========== App 菜单（仅 macOS） ==========
    // HIG：应用名为首项；About → 更新 → 偏好 → Services → Hide → Quit
    ...(isMac
      ? [
          {
            label: resolvedAppName,
            submenu: [
              { role: "about", label: copy.about },
              { type: "separator" },
              {
                label: copy.checkUpdates,
                click: () => onCheckForUpdates?.(),
              },
              { type: "separator" },
              {
                label: copy.preferences,
                accelerator: "Cmd+,",
                click: () => send("menu:open-settings"),
              },
              {
                label: modeLabel,
                submenu: modeSubmenu,
              },
              { type: "separator" },
              { role: "services", label: copy.services, submenu: [] },
              { type: "separator" },
              { role: "hide", label: copy.hide },
              { role: "hideOthers", label: copy.hideOthers },
              { role: "unhide", label: copy.unhide },
              { type: "separator" },
              { role: "quit", label: copy.quitApp },
            ],
          },
        ]
      : []),

    // ========== 文件 ==========
    // HIG：新建 → 打开 → 最近项 → 关闭 → 保存 → 导出（分组以分隔线分隔）
    {
      label: copy.file,
      submenu: [
        {
          label: copy.newNote,
          // HIG：New 使用 Cmd+N；保留原 Alt+N 兼容老用户
          click: () => send("menu:new-note"),
        },
        { type: "separator" },
        {
          label: copy.searchNotes,
          accelerator: "CmdOrCtrl+F",
          click: () => send("menu:search"),
        },
        { type: "separator" },
        ...(isMac
          ? [
              // macOS 应用菜单已有 Quit；文件菜单用 Close Window 对应关闭当前窗口
              { role: "close", label: copy.closeWindow, accelerator: "Cmd+W" },
            ]
          : [
              // Windows/Linux：设置、退出放文件菜单末尾
              {
                label: copy.settings,
                accelerator: "Ctrl+,",
                click: () => send("menu:open-settings"),
              },
              {
                label: modeLabel,
                submenu: modeSubmenu,
              },
              { type: "separator" },
              { role: "quit", label: copy.quit, accelerator: "Ctrl+Q" },
            ]),
      ],
    },

    // ========== 编辑 ==========
    // HIG：Undo/Redo → Cut/Copy/Paste → SelectAll
    {
      label: copy.edit,
      submenu: [
        { role: "undo", label: copy.undo },
        { role: "redo", label: copy.redo },
        { type: "separator" },
        { role: "cut", label: copy.cut },
        { role: "copy", label: copy.copy },
        { role: "paste", label: copy.paste },
        { role: "pasteAndMatchStyle", label: copy.pasteAndMatchStyle },
        { role: "delete", label: copy.del },
        { type: "separator" },
        { role: "selectAll", label: copy.selectAll },
      ],
    },

    // ========== 格式 ==========
    // HIG 推荐：Text / Font / Paragraph 分组。Tiptap 侧监听对应 menu:format:* 事件
    // 触发 schema.marks.toggleBold 等。accelerator 与编辑器内的 Mod-B/I/U 保持一致，
    // 让系统菜单成为键位发现入口，但键盘快捷键仍由编辑器实现。
    //
    // 每一项都带稳定 id，供 applyFormatState() 按 id 精准更新 checked 标记
    // （HIG：菜单项应反映当前上下文状态，比如选中的文字已加粗则"加粗"项显示 ✓）。
    {
      label: copy.format,
      submenu: [
        {
          id: "fmt:bold",
          label: copy.bold,
          type: "checkbox",
          checked: false,
          click: () => send("menu:format", { mark: "bold" }),
        },
        {
          id: "fmt:italic",
          label: copy.italic,
          type: "checkbox",
          checked: false,
          click: () => send("menu:format", { mark: "italic" }),
        },
        {
          id: "fmt:underline",
          label: copy.underline,
          type: "checkbox",
          checked: false,
          click: () => send("menu:format", { mark: "underline" }),
        },
        {
          id: "fmt:strike",
          label: copy.strike,
          type: "checkbox",
          checked: false,
          click: () => send("menu:format", { mark: "strike" }),
        },
        { type: "separator" },
        {
          id: "fmt:code",
          label: copy.inlineCode,
          type: "checkbox",
          checked: false,
          click: () => send("menu:format", { mark: "code" }),
        },
        { type: "separator" },
        {
          id: "fmt:h1",
          label: copy.heading(1),
          type: "checkbox",
          checked: false,
          click: () => send("menu:format", { node: "heading", level: 1 }),
        },
        {
          id: "fmt:h2",
          label: copy.heading(2),
          type: "checkbox",
          checked: false,
          click: () => send("menu:format", { node: "heading", level: 2 }),
        },
        {
          id: "fmt:h3",
          label: copy.heading(3),
          type: "checkbox",
          checked: false,
          click: () => send("menu:format", { node: "heading", level: 3 }),
        },
        {
          id: "fmt:h4",
          label: copy.heading(4),
          type: "checkbox",
          checked: false,
          click: () => send("menu:format", { node: "heading", level: 4 }),
        },
        {
          id: "fmt:h5",
          label: copy.heading(5),
          type: "checkbox",
          checked: false,
          click: () => send("menu:format", { node: "heading", level: 5 }),
        },
        {
          id: "fmt:h6",
          label: copy.heading(6),
          type: "checkbox",
          checked: false,
          click: () => send("menu:format", { node: "heading", level: 6 }),
        },
        {
          id: "fmt:paragraph",
          label: copy.paragraph,
          type: "checkbox",
          checked: false,
          click: () => send("menu:format", { node: "paragraph" }),
        },
      ],
    },

    // ========== 视图 ==========
    // HIG：业务视图开关在前，显示/缩放次之，开发者工具最下（打包后仅 dev 模式显示）
    {
      label: copy.view,
      submenu: [
        {
          label: copy.toggleSidebar,
          click: () => send("menu:toggle-sidebar"),
        },
        {
          label: copy.focusNoteList,
          // 不设快捷键：Ctrl/Cmd+L 是编辑器的左对齐（Issue #915），菜单加速键可能先于页面拿到按键。
          click: () => send("menu:focus-note-list"),
        },
        { type: "separator" },
        {
          label: copy.zoomIn,
          accelerator: "CmdOrCtrl+=",
          role: "zoomIn",
        },
        {
          label: copy.zoomOut,
          accelerator: "CmdOrCtrl+-",
          role: "zoomOut",
        },
        {
          label: copy.resetZoom,
          accelerator: "CmdOrCtrl+0",
          role: "resetZoom",
        },
        { type: "separator" },
        { role: "togglefullscreen", label: copy.toggleFullScreen },
        // 开发调试项：仅开发模式 / 用户手动启用时显示；生产包直接隐藏，
        // 避免普通用户误点 devtools 看到技术栈细节（HIG / 发行级打磨）
        ...(isDev
          ? [
              { type: "separator" },
              { role: "reload", label: copy.reload },
              { role: "forceReload", label: copy.forceReload },
              { role: "toggleDevTools", label: copy.toggleDevTools },
            ]
          : []),
      ],
    },

    // ========== 窗口 ==========
    // HIG：Minimize → Zoom → (分隔) → Front（全部置前） → Window 列表
    {
      label: copy.window,
      role: "window",
      submenu: [
        { role: "minimize", label: copy.minimize },
        { role: "zoom", label: copy.zoom },
        ...(isMac
          ? [
              { type: "separator" },
              { role: "front", label: copy.front },
            ]
          : [{ role: "close", label: copy.close }]),
      ],
    },

    // ========== 帮助 ==========
    // macOS 下 role:"help" 会让系统注入 "搜索" 框；我们追加快捷键与项目入口。
    {
      role: "help",
      label: copy.help,
      submenu: [
        {
          label: copy.shortcuts,
          click: () => send("menu:open-shortcuts"),
        },
        { type: "separator" },
        {
          label: copy.homepage,
          click: () => shell.openExternal("https://github.com/cropflre/nowen-note"),
        },
        {
          label: copy.reportIssue,
          click: () => shell.openExternal("https://github.com/cropflre/nowen-note/issues"),
        },
        { type: "separator" },
        {
          label: copy.checkUpdates,
          click: () => onCheckForUpdates?.(),
        },
        ...(!isMac
          ? [
              { type: "separator" },
              {
                label: copy.about,
                click: () => openAboutWindow?.(),
              },
            ]
          : []),
      ],
    },
  ];
}

function buildMenu(options = {}) {
  const template = buildMenuTemplate(options);
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

/**
 * 按 renderer 上报的格式状态同步系统菜单栏的 checked 标记（HIG 一致性）。
 *
 * 映射关系：
 *   fmt:bold       ← state.bold
 *   fmt:italic     ← state.italic
 *   fmt:underline  ← state.underline
 *   fmt:strike     ← state.strike
 *   fmt:code       ← state.code
 *   fmt:h1..h6     ← state.heading1..heading6
 *   fmt:paragraph  ← state.paragraph
 *
 * @param {null | Record<string, boolean>} state
 *   传 null 视为"清空所有"（编辑器销毁 / 失焦 / 非 Tiptap 模式等情况）。
 *   任何 id 找不到即跳过（例如该平台没装 Format 菜单；理论上不会发生但保险）。
 */
function applyFormatState(state) {
  const appMenu = Menu.getApplicationMenu();
  if (!appMenu) return;

  const mapping = [
    ["fmt:bold", "bold"],
    ["fmt:italic", "italic"],
    ["fmt:underline", "underline"],
    ["fmt:strike", "strike"],
    ["fmt:code", "code"],
    ["fmt:h1", "heading1"],
    ["fmt:h2", "heading2"],
    ["fmt:h3", "heading3"],
    ["fmt:h4", "heading4"],
    ["fmt:h5", "heading5"],
    ["fmt:h6", "heading6"],
    ["fmt:paragraph", "paragraph"],
  ];

  for (const [id, key] of mapping) {
    const item = appMenu.getMenuItemById(id);
    if (!item) continue;
    item.checked = !!(state && state[key]);
  }
}

module.exports = { buildMenu, buildMenuTemplate, applyFormatState };
