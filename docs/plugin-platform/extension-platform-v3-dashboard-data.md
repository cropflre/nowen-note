# V3 Phase 2：Dashboard 与插件数据

本增量继续面向 `release/v1.5.3`，默认开放 Dashboard 和结构化插件数据。基础应用运行、资源校验与权限规则见 [应用运行文档](./extension-platform-v3-app-runtime.md)。这是有边界的首期实现，不代表跨平台或恶意代码的完整安全验收。

## 使用

1. 管理员在设置→插件上传 `.nowen-plugin`，确认权限并启用。
2. 从“应用”打开 Personal Dashboard，添加个人事项、分组和状态，关联已有笔记/任务。事项不会创建另一套 Nowen 任务；笔记跳转复用现有核心入口。
3. 打开“工作台”。点击“编辑布局”添加、隐藏、移除、拖拽或用前移/后移按钮排序；尺寸支持小、中、大。最多 12 张卡片、5 个命名布局，可恢复当前布局默认值或删除布局。
4. 完成编辑后，隐藏卡片不占工作台空间。布局只保存在本设备，按服务器、账号、工作区、桌面/窄屏分别隔离，不写入 Sync V2。
5. 应用目录可导出当前账号/工作区的该应用数据，或从 JSON 文件恢复。恢复会替换此范围的数据，需先确认；若文件与当前数据冲突则拒绝，不自动覆盖。

卸载现在有两个明确入口：“卸载并保留数据”和“删除数据并卸载”。保留涵盖所有用户/工作区的插件 KV 和集合数据；重新手动安装相同 ID 和 Publisher 的 V3 包后恢复，权限仍需重新授予。默认不把保留区交给不同 Publisher，不覆盖已有活动数据。若需导出后卸载，先从应用目录导出当前空间，再选择保留卸载。当前没有独立的“已卸载数据管理”页面，可重装后导出/删除。

## Widget 合同与运行

V3 Manifest 可选 `contributes.widgets`，每插件最多 8 个：

```json
{
  "id": "recent",
  "title": "最近事项",
  "type": "list",
  "pageId": "home",
  "collection": "items",
  "defaultSize": "medium"
}
```

类型包括 `shortcut`、`statistic`、`status`、`list`、`app`。`pageId` 必须引用同一插件的真实页面；数据卡片必须声明集合并拥有 `plugin-storage:read`。统计显示集合记录数；状态卡统计 `status=done` 与其他状态（可用 `field` 指定状态字段）；列表最多展示 5 条标题。所有简单卡片由宿主以文本渲染，没有插件 HTML、脚本或后台定时器。

`app` 卡片由用户点击后启动，复用原有 iframe/MessageChannel/Host Broker；每个工作台同时最多一个交互卡片，切换布局、隐藏卡片或停用应用会回收。插件停用、卸载、授权或策略变化通过一个工作台级 SSE 连接通知重新加载；服务端每秒检查一次生命周期，连接最多 20 分钟，同一凭据最多 4 条，最多 128 个凭据。断流清空卡片并提示重试。刷新只触发一批查询，手动刷新间隔至少 2 秒，不为各卡片建立轮询。注册结果最多 32 个组件。

API：认证的 `GET /api/plugins/widgets?platform=web|desktop&workspaceId=personal|<id>` 和 `POST /api/plugins/widget-events`。工作区必须是当前成员；查询和数据读取继续经过插件策略、授权和 Broker ACL。

## 结构化数据 API

源合同为 `packages/nowen-plugin-sdk/host-api-contract.json`，Host API 合同版本升为 5，新增方法要求 API V3；通过 `scripts/generate-plugin-host-api.mjs` 生成后端合同、SDK、Mock 和开发者文档。V1/V2 不能调用 V3 data 方法。

| 方法 | 行为 |
| --- | --- |
| `data.query` | 集合查询，基础字段相等过滤、单字段排序、offset 分页 |
| `data.get` | 获取记录及集合版本 |
| `data.put` | 创建或完整替换单条记录；必须给 `schemaVersion`、`expectedRevision`（创建为 0） |
| `data.delete` | 明确删除；必须匹配 schema 和记录修订 |
| `data.migrate` | 匹配集合修订和旧 schema，schema 只能加 1；为缺失字段添加声明式默认值，保存迁移前快照 |
| `data.restore` | 显式恢复最后一个集合快照；修订继续增加，旧客户端不能重复覆盖 |
| `data.export/import` | 当前插件/当前 scope 的快照；导入必须匹配 `expectedDigest`，事务内替换 |

集合沿用 `plugin_storage`，使用保留键 `__nowen_collection__:<collection>`；V3 旧 KV 接口禁止访问这些内部键。插件 ID、用户和工作区由宿主上下文决定，拒绝通过参数指定其他 scope；工作区 viewer 只读。V1/V2 KV 行为不变。

首期容量：每插件/每 scope 192 KiB（含 KV）、最多 1000 个存储键；每集合含迁移备份 48 KiB；单条值 4 KiB；每集合最多 100 条；查询每页最多 10 条。48 KiB 可能早于记录数限制生效，数据写入前拒绝超限。插件不能通过旧 V3 KV 绕过总配额。UI Bridge 保持 64 KiB 消息上限，仅开放六个集合方法；整个 scope 的 `data.export/import` 由宿主应用目录的认证管理接口调用，导入成功后撤销旧实例。

查询返回 `{schemaVersion, revision, total, items}`；记录包含 `{id,value,revision,updatedAt}`。同一记录并发写入发生 `PLUGIN_DATA_CONFLICT`，HTTP 管理接口使用 409。迁移、恢复和导入都使用 SQLite 事务；失败时保留原数据。迁移仅为现有记录添加默认字段，后续新记录的字段仍由插件提供；不执行迁移脚本或任意 SQL，不提供通用重命名/删除字段的代码迁移。

应用管理接口：`GET /api/plugins/data/:id/export?workspaceId=...` 与 `POST /api/plugins/data/:id/import`，恢复请求体 `{workspaceId,snapshot,expectedDigest}`。它们不会导出全服务器所有人的数据，恢复成功后撤销该插件运行实例。账号/工作区在异步操作期间变化时，前端停止导出或恢复。

UI 同时增加 `notes.list`、`tasks.list` 的受限只读适配，只返回当前 scope 可访问的 ID、标题、更新时间和任务状态；不把笔记正文、任务详情或 Token 传入 iframe。笔记跳转还会核验资源 ACL 和 scope。

## 升级、备份与恢复

数据库迁移 v132 仅新增 `plugin_retained_storage`，不改写原有业务表。它没有指向插件注册表的级联删除关系，因此保留卸载不会销毁数据；存储仍带 pluginId/publisher/scope 信息。迁移可重复执行，并已验证 SQLite backup/restoration 包含保留区。

部署前应保留数据库备份。升级后数据库版本为 132；既有版本保护会阻止支持版本更低的旧程序继续写入。需要回退旧程序时使用升级前备份，不能只替换二进制。插件集合迁移的单集合快照与整个应用数据库备份是两种恢复机制。

当前权威数据库由 `backend/src/db/schema.ts` 的 better-sqlite3 提供。此增量没有 PostgreSQL 运行时实现或验收，也没有新增离线 Outbox/跨设备同步。

## 验证与未覆盖范围

本地结果：后端相关回归 14 文件 / 56 项通过；前端专项 6 文件 / 109 项通过；前端 DCC 30 文件 / 245 项通过；DCC 映射、前后端生产构建、后端 TypeScript、SDK 构建及生成合同检查通过。浏览器真实安装运行闭环通过，保留桌面和 390px 窄屏截图；远端 CI 需对应提交另行核实。

新增后端回归覆盖隔离、旧修订拒绝、JSON/配额、迁移与恢复、写入失败回滚、导入 ACL、错误导入不撤销他人实例、保留卸载重装、迁移幂等和 SQLite 备份恢复。前端测试覆盖本地布局隔离、损坏布局、排序和反向代理路由。

真实浏览器使用 CLI 打包的 Hello Nowen App 和 Personal Dashboard，通过生产认证/安装路由测试安装授权、事项写入、服务器进程重启、状态统计、布局尺寸/隐藏/命名、桌面与 390px 窄屏、单个交互 iframe、停用回收、导出文件/确认恢复，以及保留卸载后重装。所有数据位于临时数据库与目录。

旧的后端全量 DCC 存在已在未修改基线复现的 Native 多设备测试失败；本轮不会据此宣称全量后端回归通过。Electron 成品、Docker/NAS、真实移动设备仍需验收。

沙箱 iframe 仍不提供 CPU/内存硬配额，也不能完整阻止自身导航发出的首个网络请求。交互 Widget 的手动激活和单实例限制降低并发负担，不等于完成恶意代码资源隔离；已知安全边界继续沿用上一阶段文档。

## 示例与复测

`examples/plugins/personal-dashboard` 提供独立的 UI 与 Manifest，无需修改 Nowen 笔记或任务业务页面即可安装使用；Hello 示例也新增快捷与交互卡片声明。

示例使用脚本按钮处理保存、删除和二次确认，不依赖沙箱未开放的原生表单提交或 `window.confirm`。较大的界面应预构建为独立包内脚本，继续遵守入口文档的资源合同。

```sh
cd examples/plugins/hello-nowen-app
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
cd ../personal-dashboard
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
cd ../../../frontend
npm run build
npx playwright test --config playwright.plugin-apps.config.ts --reporter=line
```

`NOWEN_EXTENSION_V3_DASHBOARD_WIDGETS=0` 关闭工作台，`NOWEN_EXTENSION_V3_PLUGIN_DATA=0` 关闭集合 API；原有 core/appPages 及显式旧版关闭覆盖仍有效。
