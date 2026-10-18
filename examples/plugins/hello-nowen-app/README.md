# Hello Nowen App

实验性 V3 独立应用示例：安装包内 HTML/JS/CSS，通过注入的 `window.NowenApp` 读取和保存插件专属消息，响应主题/可见性变化，并返回笔记视图。没有远程依赖或构建工具。

Experimental V3 app using packaged HTML/JS/CSS and injected `window.NowenApp`: read/save a private message, follow theme/visibility events, and return to notes. No remote dependencies or build tools.

```sh
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs doctor
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
```

产物在 `dist/`。修改 `ui/` 文件后，必须更新 `manifest.json` 的 SHA-256；请保留 LF 换行。Nowen 1.5.3 默认开放 V3 应用，1.5.2 及更早版本不支持。由管理员在设置→插件上传包，确认 storage 读写权限并启用，再从应用目录固定到侧栏。

Output is under `dist/`. After editing `ui/`, update manifest SHA-256 values and preserve LF line endings. Nowen 1.5.3 enables V3 apps by default; 1.5.2 and earlier are unsupported. An administrator uploads the package in Settings → Plugins, grants storage read/write and enables it, then pins it from Apps.

个人空间按插件/用户隔离，工作区按插件/工作区隔离；禁用及重启保留数据。存储需在线连接服务器，不是离线或跨端同步示例。写入超时请先重新打开并读取核对。卸载删除所有用户和工作区的应用数据，取消并禁用可保留。

Personal data is isolated by plugin/user; workspace data by plugin/workspace. Disable and restart retain data. Storage requires the server; this is not an offline or cross-device sync example. If a save times out, reopen and read before retrying. Uninstall deletes the app data of all users/workspaces; cancel and disable to retain it.

安全边界、真实 1.5.3 宿主测试与未验收平台见 [运行文档](../../../docs/plugin-platform/extension-platform-v3-app-runtime.md)。See the runtime document for security limits, real 1.5.3 host tests and unverified platforms.

Phase 2 新增快捷卡片和手动启动的交互卡片，可在“工作台→编辑布局”添加。Phase 2 adds a shortcut widget and a manually activated app widget, available in Dashboard → Edit layout.
