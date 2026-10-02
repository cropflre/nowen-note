# Encrypted Notes：Electron 运行时验收

2026-10-02：macOS arm64、Electron 33.0.0、Chromium 130.0.6723.44、内置 Node 20.18.0，21 项通过。复用 18 项 Web 验收，另加原生窗口隐藏、失焦、最小化三项检查；加密目录 97 项单元/组件测试通过。

## 本次修复

真实 `BrowserWindow.hide()` 未触发编辑器依赖的 DOM 后台事件，正文仍可留在解锁编辑区。主窗口现在通过 `attachEncryptedAutoLock` 监听 `blur`、`hide`、`minimize`，发送无正文、口令或密钥的 `security:auto-lock` 通知。preload 使用原有事件白名单，前端共享观察器仅在持有秘密时订阅；锁定去重，关闭窗口和卸载观察器会移除监听。

## 验收路径

- 使用项目安装的 Electron，加载生产 preload 和同一原生锁定模块；保持 `nodeIntegration: false`、`contextIsolation: true`、`webSecurity: true`，不绕过 CSP。
- 每项测试使用独立临时 `userData` / `sessionData`，后端使用原有隔离 notes API 与临时数据库，不启动产品后端、不读取产品账号或用户目录。
- 真实 Worker、Web Crypto、Argon2id WASM、实际 Markdown/Tiptap 编辑器、密文保存、改口令、离线恢复、冲突与格式转换复用同一套验收。
- 原生事件由主进程调用窗口 API 产生；验证移除明文编辑器、清空口令、保留未保存密文草稿、原服务器正文不变，并能重新解锁后手动保存。
- 检查请求、浏览器存储、数据库全表与 DB/WAL；关闭 Electron 后递归扫描临时用户目录，检查测试正文和口令标记，随后删除该目录。

## 复验

从仓库根目录恢复 Electron ABI，再运行前端命令：

```sh
npm run rebuild:native
cd frontend
npm run test:encrypted-notes:electron
```

需要图形桌面环境。5176 / 5177 由专用夹具占用，不复用已有服务。Electron 后端夹具通过 `ELECTRON_RUN_AS_NODE=1` 运行，使用 ABI 130；普通 Web 测试需要 Node ABI，切换时须重新编译 `better-sqlite3`，结束后恢复 Electron ABI。CI 的 Node runtime/headers 固定说明见 [M3](./encrypted-notes-m3.md)。

## 验收边界

这是源码 Electron 运行时与组件/存储链路验收，页面从隔离 loopback 预览服务加载。尚未覆盖完整 AppShell、安装包 `file://` 资源路径、真实账号切换/注销、操作系统休眠恢复、双设备和移动真机。当前 GitHub 加密 CI 运行 Web/存储测试与原生桥接语法检查；尚未运行这些原生 GUI 测试。M2/M3/M5 继续保持未勾选，既有明文转换与历史清理仍属于 M4。
