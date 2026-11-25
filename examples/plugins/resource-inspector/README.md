# Resource Inspector

V3 检查器示例，读取当前笔记、任务或附件的只读元数据，不读取正文、文件字节、下载地址或凭据。

1. 在服务端设置 `NOWEN_EXTENSION_V3_INSPECTORS=1` 并重启。V3 Core / App Pages 的关闭覆盖仍有效。
2. 在本目录运行 `node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack`。
3. 管理员在应用→应用管理安装生成的 `.nowen-plugin`，授予笔记、任务、附件读取权限并启用。
4. 在笔记工具栏、任务详情或附件详情点击“插件检查器”，选择 Resource Inspector。

切换资源、账号、工作区或关闭检查器会回收旧界面。加密笔记及其附件不开放检查。需要刷新已保存的元数据时点击示例中的刷新按钮；本地未保存内容不在此 API 范围内。Web 与同源 DesktopFull 可用；原生客户端和 ElectronLite 不在首期范围内。

Read-only metadata inspector for the selected note, task or attachment. Enable `NOWEN_EXTENSION_V3_INSPECTORS=1`, pack with the existing CLI, install and grant read permissions, then open **Plugin inspector** from a resource detail. No note bodies, attachment bytes, file URLs or credentials are exposed. Selection and identity changes retire the old frame. See [the host contract](../../../docs/plugin-platform/extension-platform-v3-inspector.md).
