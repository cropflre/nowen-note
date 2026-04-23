// electron/preload.js
// 通过 contextBridge 把主进程事件暴露给 renderer，保持 contextIsolation=true。
const { contextBridge, ipcRenderer } = require("electron");

const allowedChannels = new Set([
  // 主进程 → renderer 的菜单/快捷键广播
  "menu:new-note",
  "menu:search",
  "menu:open-settings",
  "menu:toggle-sidebar",
  "menu:focus-note-list",
  "menu:zoom-in",
  "menu:zoom-out",
  "menu:zoom-reset",
  // 文件关联：双击 .md 打开
  "file:open",
  // 自动更新状态
  "updater:status",
]);

contextBridge.exposeInMainWorld("nowenDesktop", {
  /**
   * 订阅主进程事件。返回反注册函数。
   * @param {string} channel 频道名（必须在 allowedChannels 白名单中）
   * @param {(payload: any) => void} listener
   */
  on(channel, listener) {
    if (!allowedChannels.has(channel)) {
      console.warn("[preload] blocked channel:", channel);
      return () => {};
    }
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  /** 主动触发更新检查 */
  checkForUpdates() {
    return ipcRenderer.invoke("updater:check");
  },

  /** 下载完成后由用户触发安装 */
  quitAndInstall() {
    return ipcRenderer.invoke("updater:quit-and-install");
  },

  /** 获取 app 基本信息（版本号等） */
  getAppInfo() {
    return ipcRenderer.invoke("app:info");
  },

  /** 打开日志目录（方便用户取日志反馈问题） */
  openLogDir() {
    return ipcRenderer.invoke("app:open-log-dir");
  },

  /** 运行在 Electron 客户端的标识（前端用来条件渲染桌面专属 UI） */
  isDesktop: true,
  platform: process.platform,
});
