# Encrypted Notes：Electron 运行时验收

2026-10-02：macOS arm64、Electron 33.0.0、Chromium 130.0.6723.44、内置 Node 20.18.0，21 项通过。复用 18 项 Web 验收，另加原生窗口隐藏、失焦、最小化三项检查；加密目录 97 项单元/组件测试通过。

同日补充 `file://` / ASAR 资源验收：两种部署模式各 5 项，共 10 项通过。使用相对资源 base 与生产 `index.html` 的 CSP，直接从磁盘或临时 `renderer.asar` 加载；没有启动 HTTP 前端预览服务。验证页面及 5 个加密 Worker 都从相应文件/归档路径加载。

## 本次修复

真实 `BrowserWindow.hide()` 未触发编辑器依赖的 DOM 后台事件，正文仍可留在解锁编辑区。主窗口现在通过 `attachEncryptedAutoLock` 监听 `blur`、`hide`、`minimize`，发送无正文、口令或密钥的 `security:auto-lock` 通知。preload 使用原有事件白名单，前端共享观察器仅在持有秘密时订阅；锁定去重，关闭窗口和卸载观察器会移除监听。

## 验收路径

- 使用项目安装的 Electron，加载生产 preload 和同一原生锁定模块；保持 `nodeIntegration: false`、`contextIsolation: true`、`webSecurity: true`，不绕过 CSP。
- 每项测试使用独立临时 `userData` / `sessionData`，后端使用原有隔离 notes API 与临时数据库，不启动产品后端、不读取产品账号或用户目录。
- 真实 Worker、Web Crypto、Argon2id WASM、实际 Markdown/Tiptap 编辑器、密文保存、改口令、离线恢复、冲突与格式转换复用同一套验收。
- 原生事件由主进程调用窗口 API 产生；验证移除明文编辑器、清空口令、保留未保存密文草稿、原服务器正文不变，并能重新解锁后手动保存。
- 检查请求、浏览器存储、数据库全表与 DB/WAL；关闭 Electron 后递归扫描临时用户目录，检查测试正文和口令标记，随后删除该目录。

文件/ASAR 模式使用生产 preload、`installDesktopNativeHttpBridge` 和 Electron `session.fetch`；夹具 IPC 只允许测试窗口访问 `127.0.0.1:5177/api/`，不启动产品 IPC 与用户账号。扫描这些 IPC 请求、浏览器存储、数据库/WAL 及临时用户目录，未发现测试正文或口令标记。整篇 Markdown/富文本覆盖创建、手动保存、原生隐藏后的内存草稿锁定、错误口令、恢复、再次保存及页面重载后从服务器密文解锁；实际 Markdown/Tiptap 编辑器覆盖局部加密、格式互转与写回。服务器恢复按钮只在独立验收夹具中存在，仅持久化测试 note ID。

## 复验

从仓库根目录恢复 Electron ABI，再运行前端命令：

```sh
npm run rebuild:native
cd frontend
npm run test:encrypted-notes:electron
npm run test:encrypted-notes:file
```

需要仓库根目录的 Electron/打包依赖和图形桌面环境。HTTP 模式占用 5176 / 5177，文件/ASAR 模式只占用 5177，不复用已有服务。ASAR 由已有 `@electron/asar` 在每项测试的临时目录中生成并清理。Electron 后端夹具通过 `ELECTRON_RUN_AS_NODE=1` 运行，使用 ABI 130；普通 Web 测试需要 Node ABI，切换时须重新编译 `better-sqlite3`，结束后恢复 Electron ABI。CI 的 Node runtime/headers 固定说明见 [M3](./encrypted-notes-m3.md)。

夹具等待页面加载与原生窗口初始激活后才进入测试。运行时切到其他应用仍会触发真实自动锁定，可能关闭正在填写口令的创建弹窗；测试期间应让其窗口保持前台，原生后台专项由测试自行驱动。

## 验收边界

后续补充的 [完整工作台验收](./encrypted-notes-app-acceptance.md) 使用生产主进程/IPC、完整 AppShell 和隔离真实账号，覆盖 5 项产品链路；下文仍描述本文件的组件/资源夹具边界。

这是源码 Electron 运行时、组件/存储链路和 `file://` / ASAR 资源验收。ASAR 仅包含独立构建的验收资源，不是整个应用的发布安装包。尚未覆盖完整 AppShell、产品 IPC 的真实账号鉴权/请求过滤、安装与更新流程、真实账号切换/注销、操作系统休眠恢复、双设备和移动真机。生产 CSP 不做放宽；文件 Worker 的策略行为不能等同于 HTTP Worker 响应头 CSP 验收。当前 GitHub 加密 CI 运行 Web/存储测试与原生桥接语法检查；尚未运行这些原生 GUI 测试。M2/M3/M5 继续保持未勾选，既有明文转换与历史清理仍属于 M4。
