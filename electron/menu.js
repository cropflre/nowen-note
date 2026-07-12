// electron/menu.js
// 构建跨平台原生菜单；菜单项的 accelerator 即作为窗口快捷键生效。
// 通过 IPC 把动作透传给 renderer（frontend 侦听 window.nowenDesktop.on("menu:xxx", ...)）。
//
// 本文件按 Apple Human Interface Guidelines 排列 macOS 菜单顺序：
//   App → 文件 → 编辑 → 格式 → 视图 → 窗口 → 帮助
// 每个菜单内部也遵循 HIG 推荐分组（新建/打开/保存/导出 分组之间用分隔线隔开）。
// Windows/Linux 菜单栏不存在 macOS 的 App 菜单，应用级动作（偏好设置/退出）
// 落到"文件"菜单末尾，与系统惯例一致。
const { Menu, app, shell, BrowserWindow } = require("electron");

const isMac = process.platform === "darwin";
const isDev = !app.isPackaged;

/** 发送菜单事件给当前聚焦窗口 */
function send(channel, payload) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function buildMenu({
  onCheckForUpdates,
  openAboutWindow,
  mode = "full",
  liteOnly = false,
  onSwitchToLite,
  onSwitchToFull,
  onChangeServer,
} = {}) {
  const isLite = mode === "lite";

  // "模式"子菜单：根据当前模式动态显示可用项
  //   full：仅显示"切换到轻量模式…"
  //   lite：显示"更换服务器…" + "切换到本地模式"
  //   liteOnly 发行版：只显示"更换服务器…"（因为没有 backend 可回）
  // 这样 UI 不会出现"我已经在 Lite 还显示一个 Lite 选项"这种鸡肋项。
  const modeSubmenu = isLite
    ? [
        {
          label: "更换服务器…",
          click: () => onChangeServer?.(),
        },
        ...(liteOnly
          ? []
          : [
              {
                label: "切换到本地模式",
                click: () => onSwitchToFull?.(),
              },
            ]),
      ]
    : [
        {
          label: "切换到轻量模式…",
          click: () => onSwitchToLite?.(),
        },
      ];
  const modeLabel = isLite
    ? (liteOnly ? "模式：轻量发行版" : "模式：轻量（远端）")
    : "模式：本地";
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    // ========== App 菜单（仅 macOS） ==========
    // HIG：应用名为首项；About → 更新 → 偏好 → Services → Hide → Quit
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about", label: `关于 ${app.name}` },
              { type: "separator" },
              {
                label: "检查更新…",
                click: () => onCheckForUpdates?.(),
              },
              { type: "separator" },
              {
                label: "偏好设置…",
                accelerator: "Cmd+,",
                click: () => send("menu:open-settings"),
              },
              {
                label: modeLabel,
                submenu: modeSubmenu,
              },
              { type: "separator" },
              { role: "services", label: "服务", submenu: [] },
              { type: "separator" },
              { role: "hide", label: `隐藏 ${app.name}` },
              { role: "hideOthers", label: "隐藏其他" },
              { role: "unhide", label: "全部显示" },
              { type: "separator" },
              { role: "quit", label: `退出 ${app.name}` },
            ],
          },
        ]
      : []),

    // ========== 文件 ==========
    // HIG：新建 → 打开 → 最近项 → 关闭 → 保存 → 导出（分组以分隔线分隔）
    {
      label: isMac ? "文件" : "文件(&F)",
      submenu: [
        {
          label: "新建笔记",
          // HIG：New 使用 Cmd+N；保留原 Alt+N 兼容老用户
          accelerator: isMac ? "Cmd+N" : "Ctrl+N",
          click: () => send("menu:new-note"),
        },
        { type: "separator" },
        {
          label: "搜索笔记…",
          accelerator: "CmdOrCtrl+F",
          click: () => send("menu:search"),
        },
        { type: "separator" },
        ...(isMac
          ? [
              // macOS 应用菜单已有 Quit；文件菜单用 Close Window 对应关闭当前窗口
              { role: "close", label: "关闭窗口", accelerator: "Cmd+W" },
            ]
          : [
              // Windows/Linux：设置、退出放文件菜单末尾
              {
                label: "设置",
                accelerator: "Ctrl+,",
                click: () => send("menu:open-settings"),
              },
              {
                label: modeLabel,
                submenu: modeSubmenu,
              },
              { type: "separator" },
              { role: "quit", label: "退出", accelerator: "Ctrl+Q" },
            ]),
      ],
    },

    // ========== 编辑 ==========
    // HIG：Undo/Redo → Cut/Copy/Paste → SelectAll
    {
      label: isMac ? "编辑" : "编辑(&E)",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "pasteAndMatchStyle", label: "粘贴并匹配样式" },
        { role: "delete", label: "删除" },
        { type: "separator" },
        { role: "selectAll", label: "全选" },
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
      label: isMac ? "格式" : "格式(&O)",
      submenu: [
        {
          id: "fmt:bold",
          label: "加粗",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+B",
          click: () => send("menu:format", { mark: "bold" }),
        },
        {
          id: "fmt:italic",
          label: "斜体",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+I",
          click: () => send("menu:format", { mark: "italic" }),
        },
        {
          id: "fmt:underline",
          label: "下划线",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+U",
          click: () => send("menu:format", { mark: "underline" }),
        },
        {
          id: "fmt:strike",
          label: "删除线",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+Shift+X",
          click: () => send("menu:format", { mark: "strike" }),
        },
        { type: "separator" },
        {
          id: "fmt:code",
          label: "行内代码",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+E",
          click: () => send("menu:format", { mark: "code" }),
        },
        { type: "separator" },
        {
          id: "fmt:h1",
          label: "标题 1",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+Alt+1",
          click: () => send("menu:format", { node: "heading", level: 1 }),
        },
        {
          id: "fmt:h2",
          label: "标题 2",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+Alt+2",
          click: () => send("menu:format", { node: "heading", level: 2 }),
        },
        {
          id: "fmt:h3",
          label: "标题 3",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+Alt+3",
          click: () => send("menu:format", { node: "heading", level: 3 }),
        },
        {
          id: "fmt:h4",
          label: "标题 4",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+Alt+4",
          click: () => send("menu:format", { node: "heading", level: 4 }),
        },
        {
          id: "fmt:h5",
          label: "标题 5",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+Alt+5",
          click: () => send("menu:format", { node: "heading", level: 5 }),
        },
        {
          id: "fmt:h6",
          label: "标题 6",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+Alt+6",
          click: () => send("menu:format", { node: "heading", level: 6 }),
        },
        {
          id: "fmt:paragraph",
          label: "正文",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+Alt+0",
          click: () => send("menu:format", { node: "paragraph" }),
        },
      ],
    },

    // ========== 视图 ==========
    // HIG：业务视图开关在前，显示/缩放次之，开发者工具最下（打包后仅 dev 模式显示）
    {
      label: isMac ? "视图" : "视图(&V)",
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
        {
          label: "放大",
          accelerator: "CmdOrCtrl+=",
          role: "zoomIn",
        },
        {
          label: "缩小",
          accelerator: "CmdOrCtrl+-",
          role: "zoomOut",
        },
        {
          label: "实际大小",
          accelerator: "CmdOrCtrl+0",
          role: "resetZoom",
        },
        { type: "separator" },
        { role: "togglefullscreen", label: "进入全屏" },
        // 开发调试项：仅开发模式 / 用户手动启用时显示；生产包直接隐藏，
        // 避免普通用户误点 devtools 看到技术栈细节（HIG / 发行级打磨）
        ...(isDev
          ? [
              { type: "separator" },
              { role: "reload", label: "刷新" },
              { role: "forceReload", label: "强制刷新" },
              { role: "toggleDevTools", label: "开发者工具" },
            ]
          : []),
      ],
    },

    // ========== 窗口 ==========
    // HIG：Minimize → Zoom → (分隔) → Front（全部置前） → Window 列表
    {
      label: isMac ? "窗口" : "窗口(&W)",
      role: "window",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(isMac
          ? [
              { type: "separator" },
              { role: "front", label: "全部置前" },
            ]
          : [{ role: "close", label: "关闭" }]),
      ],
    },

    // ========== 帮助 ==========
    // macOS 下 role:"help" 会让系统注入 "搜索" 框；我们只追加项目链接
    {
      role: "help",
      label: isMac ? "帮助" : "帮助(&H)",
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
                label: `关于 ${app.name}`,
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

module.exports = { buildMenu, applyFormatState };
