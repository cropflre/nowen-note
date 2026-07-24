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
  // 格式菜单：{ mark?: "bold"|"italic"|"underline"|"strike"|"code", node?: "heading"|"paragraph", level?: number }
  "menu:format",
  // Dock Quick Action（macOS）
  "dock:new-note",
  "dock:search",
  // 文件关联：双击 .md 打开
  "file:open",
  // 自动更新状态
  "updater:status",
  // 局域网服务发现：主进程发现/丢失 mDNS 服务后向 renderer 推送最新列表
  "discovery:update",
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

  /** 打开本地数据目录，便于用户备份/定位 SQLite 与附件数据。 */
  openDataDir() {
    return ipcRenderer.invoke("app:open-data-dir");
  },

  /** 本地数据目录：查询、选择与迁移。 */
  dataDir: {
    getInfo() {
      return ipcRenderer.invoke("app:get-data-dir-info");
    },
    choose() {
      return ipcRenderer.invoke("app:choose-data-dir");
    },
    migrate(targetPath) {
      if (typeof targetPath !== "string") {
        return Promise.resolve({ ok: false, error: "INVALID_PATH" });
      }
      return ipcRenderer.invoke("app:migrate-data-dir", { targetPath: targetPath.slice(0, 4096) });
    },
  },

  /** 设置 Windows/Linux 原生菜单栏是否隐藏。 */
  setHideMenuBar(next) {
    return ipcRenderer.invoke("app:set-hide-menu-bar", Boolean(next));
  },

  /** 发送任务提醒通知（SEC-ELECTRON-01-C: 参数校验） */
  taskNotify(title, body) {
    const safeTitle = typeof title === "string" ? title.slice(0, 200) : "";
    const safeBody = typeof body === "string" ? body.slice(0, 1000) : "";
    return ipcRenderer.invoke("task:notify", { title: safeTitle, body: safeBody });
  },

  /** 检查通知权限 */
  taskNotifyPermission() {
    return ipcRenderer.invoke("task:notify-permission");
  },

  /** SEC-ELECTRON-01-C: 诊断信息接口（敏感路径等） */
  getDiagnosticsInfo() {
    return ipcRenderer.invoke("app:diagnostics-info");
  },

  /** 性能签收专用：读取当前 renderer 进程内存，不在正常业务流程自动调用。 */
  getEditorPerformanceMetrics() {
    return ipcRenderer.invoke("app:editor-performance-metrics");
  },

  /**
   * renderer → 主进程：上报当前编辑器"格式状态"，供主进程同步系统菜单栏的
   * checked 标记（HIG：菜单项应反映当前上下文状态）。
   *
   * @param {null | {
   *   bold?: boolean,
   *   italic?: boolean,
   *   underline?: boolean,
   *   strike?: boolean,
   *   code?: boolean,
   *   heading1?: boolean,
   *   heading2?: boolean,
   *   heading3?: boolean,
  *   heading4?: boolean,
  *   heading5?: boolean,
  *   heading6?: boolean,
   *   paragraph?: boolean,
   * }} state
   *   null 表示"无可用编辑器"（编辑器销毁 / 焦点离开 / MD 模式未命中），
   *   主进程应清空所有格式菜单的 checked。
   *
   * 调用端职责：**自己做节流**（建议 100ms）与 **去重**（浅比较）。此 IPC 极轻量但频繁调用仍划不来。
   */
  sendFormatState(state) {
    if (!state || typeof state !== "object") {
      ipcRenderer.send("menu:format-state", null);
      return;
    }
    const allowed = [
      "bold", "italic", "underline", "strike", "code",
      "heading1", "heading2", "heading3", "heading4", "heading5", "heading6", "paragraph",
    ];
    const safe = {};
    for (const key of allowed) {
      if (typeof state[key] === "boolean") safe[key] = state[key];
    }
    ipcRenderer.send("menu:format-state", safe);
  },

  /** 运行在 Electron 客户端的标识（前端用来条件渲染桌面专属 UI） */
  isDesktop: true,
  platform: process.platform,
  /**
   * Lite-only 发行版标识：通过 additionalArguments 传递。
   * true 表示这份安装包里没有打包 backend，无法切回 full 模式，前端应隐藏
   * "切回本地模式"等入口，登录页默认强制客户端模式。
   */
  isLiteOnly: (process.argv || []).includes("--nowen-lite-only"),

  /**
   * 发布渠道标识（AboutPanel 展示用）：
   *   - "lite"    lite-only 发行版；electron-updater 只会从 latest-lite*.yml 拉取
   *   - "latest"  默认 full 版
   * 与 builder.config.js / builder.lite.config.js 里的 publish.channel 对齐。
   * 前端可以据此在 "关于" 页展示 "发布渠道：lite"，方便排查"为什么我升不上 full"。
   */
  releaseChannel: (process.argv || []).includes("--nowen-lite-only") ? "lite" : "latest",

  /**
   * 是否运行在 portable / 免安装版下。
   *
   * electron-builder 的 Windows portable target 启动时会注入环境变量
   * `PORTABLE_EXECUTABLE_FILE`（值为 .exe 自身路径）；其它包格式（NSIS 安装版、
   * dmg、AppImage）不会有这个 env。我们在这里**仅**用它的存在性作为信号。
   *
   * 为什么需要：electron-updater 不支持 portable 包的差分自更新，autoUpdater
   * 在 portable 上调 `checkForUpdates()` 会抛 error，但用户看到的现象是关于页
   * 一直转圈或显示"更新失败"——很难排查。前端拿到 `isPortable=true` 后，应该
   * 把"检查桌面端更新"按钮替换成"前往下载页"，给出明确的人工升级路径。
   *
   * 注意：AppImage 的"无升级"也类似，但目前 release 流水线没有 AppImage 产物，
   * 暂不在这里处理；如未来加入，可在主进程里统一判定后通过额外字段下发。
   */
  isPortable: Boolean(
    process.env.PORTABLE_EXECUTABLE_FILE && process.env.PORTABLE_EXECUTABLE_FILE.length > 0,
  ),

  /**
   * 凭据存储（记住密码 / 自动登录）。
   * renderer 同步 / 异步都走这些接口；主进程用 safeStorage 加密落盘。
   *
   *   load():    { serverUrl, username, password, hasPassword, autoLogin } | null
   *   save():    { ok, encrypted, error? }
   *              payload 至少包含 { remember:boolean }，其余字段可选
   *   clear():   { ok, error? }
   *   isEncryptionAvailable(): boolean
   */
  credentials: {
    load() {
      return ipcRenderer.invoke("credentials:load");
    },
    save(payload) {
      if (!payload || typeof payload !== "object") return Promise.resolve({ ok: false, error: "INVALID_PAYLOAD" });
      const safe = {};
      if (typeof payload.remember === "boolean") safe.remember = payload.remember;
      if (typeof payload.autoLogin === "boolean") safe.autoLogin = payload.autoLogin;
      if (typeof payload.serverUrl === "string") safe.serverUrl = payload.serverUrl.slice(0, 2048);
      if (typeof payload.username === "string") safe.username = payload.username.slice(0, 256);
      if (typeof payload.password === "string") safe.password = payload.password.slice(0, 1024);
      return ipcRenderer.invoke("credentials:save", safe);
    },
    clear() {
      return ipcRenderer.invoke("credentials:clear");
    },
    isEncryptionAvailable() {
      return ipcRenderer.invoke("credentials:is-encryption-available");
    },
    loadProfile(profileId) {
      if (typeof profileId !== "string") return Promise.resolve(null);
      return ipcRenderer.invoke("credentials:profile-load", profileId.slice(0, 160));
    },
    saveProfile(payload) {
      if (!payload || typeof payload !== "object") return Promise.resolve({ ok: false, error: "INVALID_PAYLOAD" });
      const safe = {};
      if (typeof payload.profileId === "string") safe.profileId = payload.profileId.slice(0, 160);
      if (typeof payload.serverUrl === "string") safe.serverUrl = payload.serverUrl.slice(0, 2048);
      if (typeof payload.username === "string") safe.username = payload.username.slice(0, 256);
      if (typeof payload.token === "string") safe.token = payload.token.slice(0, 8192);
      if (typeof payload.password === "string") safe.password = payload.password.slice(0, 1024);
      if (typeof payload.autoLogin === "boolean") safe.autoLogin = payload.autoLogin;
      return ipcRenderer.invoke("credentials:profile-save", safe);
    },
    removeProfile(profileId) {
      if (typeof profileId !== "string") return Promise.resolve({ ok: false, error: "INVALID_PROFILE_ID" });
      return ipcRenderer.invoke("credentials:profile-remove", profileId.slice(0, 160));
    },
    listProfiles() {
      return ipcRenderer.invoke("credentials:profile-list");
    },
  },

  /**
   * 局域网服务发现（mDNS）：
   *   - start():  启动扫描 _nowen-note._tcp.local.；返回 { ok, available }
   *                available=false 表示主进程缺 bonjour-service 依赖（不会报错，前端
   *                仅显示"未发现"）
   *   - stop():   停止扫描并取消订阅
   *   - list():   主动获取当前已知服务列表（通常用不到，start 后会自动推送）
   *   - onUpdate(cb): 订阅列表变化；返回反注册函数
   *
   * 返回的 service 结构：
   *   { name, host, port, ipv4, addresses: string[], txt: Record<string,string>, lastSeen: number }
   */
  discovery: {
    start() {
      return ipcRenderer.invoke("discovery:start");
    },
    stop() {
      return ipcRenderer.invoke("discovery:stop");
    },
    list() {
      return ipcRenderer.invoke("discovery:list");
    },
    onUpdate(listener) {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on("discovery:update", wrapped);
      return () => ipcRenderer.removeListener("discovery:update", wrapped);
    },
  },

  /**
   * 模式切换：前端"设置/关于"页可以放按钮调用这些接口，等价于走系统菜单。
   * 调用任意一个都会写入 settings.json + 清登录态 + relaunch（不会立刻 resolve）。
   *
   *   switchToLite:    弹出"选择服务器"窗，用户选完后切到 lite 并重启
   *   switchToFull:    确认后切回内置本地模式并重启
   *   changeServer:    仅更换 lite 模式下的远端 URL（依然停留在 lite）
   */
  mode: {
    switchToLite() {
      return ipcRenderer.invoke("mode:switch-to-lite");
    },
    switchToFull() {
      return ipcRenderer.invoke("mode:switch-to-full");
    },
    changeServer() {
      return ipcRenderer.invoke("mode:change-server");
    },
  },

  /**
   * 单笔记导出为 PDF：renderer 构造好完整 HTML（含内联样式与图片），主进程
   * 用离屏 BrowserWindow 渲染后 printToPDF，弹保存对话框写盘。
   *
   * @param {{ html: string, suggestedName?: string }} payload
   * @returns {Promise<{ ok: boolean, path?: string, canceled?: boolean, error?: string }>}
   */
  exportNoteToPDF(payload) {
    return ipcRenderer.invoke("export:note-to-pdf", payload);
  },

  /**
   * Phase A: 桌面零登录入口。
   *
   *   getLocalAuth():   { token, user } | null
   *     启动后 renderer 第一时间调它；非 null 则直接写入 localStorage("nowen-token")
   *     并跳过登录页。lite 模式 / 失败时返回 null。
   *
   *   clearLocalAuth(): 用户在 App 内切换到云账号时调；仅清掉主进程里的内存缓存，
   *     不删 userData 下的 secret，下次重启又能自动恢复本地登录。
   */
  getLocalAuth() {
    return ipcRenderer.invoke("desktop:get-local-auth");
  },
  clearLocalAuth() {
    return ipcRenderer.invoke("desktop:clear-local-auth");
  },
  resetLocalAuth() {
    return ipcRenderer.invoke("desktop:reset-local-auth");
  },

  /**
   * 文件夹同步配置（Phase B：仅配置 CRUD，不做扫描/上传）。
   */
  /** SEC-ELECTRON-01-C: folderSync 参数校验 */
  folderSync: {
    selectFolder() {
      return ipcRenderer.invoke("folder-sync:select-folder");
    },
    getConfigs() {
      return ipcRenderer.invoke("folder-sync:get-configs");
    },
    saveConfig(config) {
      if (!config || typeof config !== "object") {
        return Promise.resolve({ ok: false, error: "INVALID_CONFIG" });
      }
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
      return ipcRenderer.invoke("folder-sync:save-config", safe);
    },
    removeConfig(folderId) {
      if (typeof folderId !== "string" || folderId.length > 128) {
        return Promise.resolve({ ok: false, error: "INVALID_FOLDER_ID" });
      }
      return ipcRenderer.invoke("folder-sync:remove-config", folderId);
    },
    getLogs(folderId) {
      if (typeof folderId !== "string" || folderId.length > 128) {
        return Promise.resolve({ ok: false, error: "INVALID_FOLDER_ID" });
      }
      return ipcRenderer.invoke("folder-sync:get-logs", folderId);
    },
    runNow(folderId) {
      if (typeof folderId !== "string" || folderId.length > 128) {
        return Promise.resolve({ ok: false, error: "INVALID_FOLDER_ID" });
      }
      return ipcRenderer.invoke("folder-sync:run-now", folderId);
    },
    getIndex(folderId) {
      if (typeof folderId !== "string" || folderId.length > 128) {
        return Promise.resolve({ ok: false, error: "INVALID_FOLDER_ID" });
      }
      return ipcRenderer.invoke("folder-sync:get-index", folderId);
    },
    getPendingUploads(folderId) {
      if (typeof folderId !== "string" || folderId.length > 128) {
        return Promise.resolve({ ok: false, error: "INVALID_FOLDER_ID" });
      }
      return ipcRenderer.invoke("folder-sync:get-pending-uploads", folderId);
    },
    markUploadResult(folderId, relativePath, result) {
      if (typeof folderId !== "string" || folderId.length > 128) {
        return Promise.resolve({ ok: false, error: "INVALID_FOLDER_ID" });
      }
      if (typeof relativePath !== "string" || relativePath.includes("..") || relativePath.length > 4096) {
        return Promise.resolve({ ok: false, error: "INVALID_PATH" });
      }
      if (!result || typeof result !== "object") {
        return Promise.resolve({ ok: false, error: "INVALID_RESULT" });
      }
      const safe = {};
      if (typeof result.success === "boolean") safe.success = result.success;
      if (typeof result.skipped === "boolean") safe.skipped = result.skipped;
      if (typeof result.noteId === "string") safe.noteId = result.noteId;
      if (typeof result.attachmentId === "string") safe.attachmentId = result.attachmentId;
      if (typeof result.error === "string") safe.error = result.error.slice(0, 1000);
      return ipcRenderer.invoke("folder-sync:mark-upload-result", folderId, relativePath, safe);
    },
    appendLog(folderId, type, message, detail) {
      if (typeof folderId !== "string" || folderId.length > 128) {
        return Promise.resolve({ ok: false, error: "INVALID_FOLDER_ID" });
      }
      const allowedTypes = ["info", "warn", "error", "sync", "upload"];
      const safeType = allowedTypes.includes(type) ? type : "info";
      const safeMsg = typeof message === "string" ? message.slice(0, 1000) : "";
      const safeDetail = typeof detail === "string" ? detail.slice(0, 2000) : "";
      return ipcRenderer.invoke("folder-sync:append-log", folderId, safeType, safeMsg, safeDetail);
    },
    getUploadFile(folderId, relativePath) {
      if (typeof folderId !== "string" || folderId.length > 128) {
        return Promise.resolve({ ok: false, error: "INVALID_FOLDER_ID" });
      }
      if (typeof relativePath !== "string" || relativePath.includes("..") || relativePath.length > 4096) {
        return Promise.resolve({ ok: false, error: "INVALID_PATH" });
      }
      return ipcRenderer.invoke("folder-sync:get-upload-file", folderId, relativePath);
    },
  },
});
