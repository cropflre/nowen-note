# Personal Dashboard

Nowen 1.5.3 的独立应用示例：个人事项、分组、状态、分页、关联现有笔记/任务和五种工作台卡片。通过 `window.NowenApp` 的 `data.*` API 持久化；关联不会复制 Nowen 任务系统。没有远程依赖或构建步骤。

Standalone Nowen 1.5.3 app: personal items, groups, status, pagination, links to existing notes/tasks, and five dashboard widget types. Persists through `window.NowenApp` data APIs; links reuse the existing Nowen task system. No remote dependencies or build step.

```sh
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs doctor
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
```

管理员在应用→应用管理安装 `dist/nowenlab.personal-dashboard-0.1.0.nowen-plugin`，确认存储读写、笔记读取、任务读取权限。到“应用”启动，或在“工作台→编辑布局”添加卡片。事项数据按插件/用户/工作区隔离；布局仅保存本机。修改 UI 后更新 Manifest SHA-256，并保留 LF 换行。

An administrator installs the package from `dist/` in Apps → Manage apps and grants storage read/write, notes read and tasks read. Open it in Apps or add cards in Dashboard → Edit layout. Data is isolated by plugin/user/workspace; layouts are device-local. Update manifest SHA-256 after UI edits and preserve LF line endings.

写入需要在线连接。冲突或响应丢失时，先刷新读取再决定是否重试。删除事项需二次点击确认。应用目录提供当前空间的数据导出与显式文件恢复；设置中可保留数据卸载或明确删除数据。

Writes require the server. After a conflict or lost response, refresh and read before retrying. Item deletion requires a second confirmation click. Apps provides scoped export and explicit file restore; uninstall can retain data or explicitly delete it.

容量、迁移、恢复和安全边界见 [Phase 2 文档](../../../docs/plugin-platform/extension-platform-v3-dashboard-data.md)。See the Phase 2 document for quotas, migration, recovery and security limits.
