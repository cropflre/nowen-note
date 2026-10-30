# 开发参考

搜索标题后只读相关段落；路径、命令和能力以当前代码 / CI 为准。

## 产品定位与现状

开源自托管知识库、记录与任务工作台，含 Web、Electron、Android 及 iOS / HarmonyOS 工程；不从 Web / Desktop 推断其他平台能力。SQLite 是生产默认，不假设 PostgreSQL 已正式可切换。版本与上线状态查当前代码、Release、CHANGELOG、CI。

## 仓库地图

| 领域 | 入口 |
| --- | --- |
| UI / 编辑器 | `frontend/src/components/`、`frontend/src/lib/`、`frontend/src/types/` |
| 离线 / 附件读取 | `frontend/src/lib/offlineRead.ts`、`noteAttachmentAccessBridge.ts` |
| API / DB | `frontend/src/lib/api.impl.ts`、`backend/src/routes/`、`backend/src/db/`、`backend/src/index.hardened.ts`；检查 runtime 注册与迁移加载 |
| Sync V2 / Native | `backend/src/routes/sync-v2.ts`、`backend/src/sync/`；`frontend/src/lib/` 下 `mobileLocalFirstBridge.ts`、`mobileSyncEngine.ts`、`nativeDatabase.ts`、`nativeKnowledgeTreeSync.ts` |
| Web 同步 / 回执 | `frontend/src/lib/syncEngine.ts`、`noteSyncReceipt.ts`、`mobileNoteSyncReceipt.ts` |
| 插件 / 开放接口 | `backend/src/plugins/`、`packages/create-nowen-plugin/`、`packages/nowen-mcp/`、`packages/nowen-cli/`、`packages/nowen-sdk/` |
| 客户端 / 构建 | `electron/`、`frontend/` 的 Capacitor 与原生工程、`nowen-harmony/`；`scripts/`、`.github/workflows/`、`Dockerfile`、`docker-compose.yml` |

## 领域边界

- **同步**：确认平台 / 模式的权威源；覆盖离线编辑→重连→服务端确认→第二设备读取，区分记录缺失、正文空 / 陈旧、未同步修改与冲突；遵守 DCC，不另建同步链路。
- **权限**：ACL、共享空间、继承、restricted Token 与公开分享分别验证，包含 401/403 和越权负例。
- **附件 / 恢复**：保持 noteId、attachmentId、引用与存储一致；备份 / 迁移 / 恢复验证完整性和失败保护。新增数据类型检查适用生命周期，TXT 等不能经过有损解析。
- **编辑 / 加密**：格式转换、选区异步写回、Yjs 保存 / 撤销、版本恢复和索引保持内容与权限语义。加密新内容不代表旧历史、备份或导出明文已清除。
- **任务 / 日期**：全天、重复、时区与通知使用一致语义；计数、筛选和展示共用本地日期规则，不直接截取 UTC 日期。
- **插件**：分别验证 sandbox-js / node-action 的权限、密钥、请求白名单和隔离；Docker 包含 `dist/plugins/runner-child.mjs` 与 `sandbox-child.mjs`。
- **UI**：复用信息架构，检查 i18n、无障碍。布局问题在对应视口实际检查溢出、滚动、弹层、键盘遮挡和触控，例如 [#834](https://github.com/cropflre/nowen-note/issues/834)；编辑交互按需覆盖 IME、选区、撤销和触屏，构建 / 组件测试不代替浏览器布局证据。
- **附件 URL**：区分展示与主动下载、本地 / 内网 / 公网及代理前缀；核查配置的实际消费端，重写不丢签名和作用域，例如 [#740](https://github.com/cropflre/nowen-note/issues/740)。
- **日志**：记录请求关联、耗时、状态和错误码，不记录正文、Token、密码或附件二进制。

## 测试与运行命令

先查目标测试、package scripts 与 CI；前端定向 Vitest 使用 `cd frontend && npm run test:run -- <测试路径>`。后端遵守当前 runner 的数据库隔离和运行时要求，不能假设 `npm test -- <路径>` 会筛选文件。

| 用途 | 根目录执行 |
| --- | --- |
| 开发 / 全量构建 | `npm run dev` / `npm run build:all` |
| 后端串行全量 | `npm --prefix backend test` |
| 前端全量 / lint 基线 | `npm --prefix frontend run test:run` / `npm --prefix frontend run lint:baseline` |
| DCC 映射 / 行为回归 | `node scripts/data-consistency-contract.mjs --verify`，按范围选 `--backend` / `--frontend` |
| 插件产物 | 构建后运行 `node backend/scripts/smoke-plugin-artifacts.cjs` |

- 前端行为改动：目标测试 + 对应类型 / 构建检查；布局再做相关桌面 / 窄屏浏览器检查。
- API / 权限 / 同步：目标回归 + 拒绝用例 + 持久化后重读；迁移 / 恢复用临时库和模拟附件往返验证。
- 打包 / 平台：查[发布验收](maintainer-workflows.md) §5；环境缺失标明未验证，不能从本机通过推断其他 OS / 架构。
- 文档 / Skill：检查 frontmatter、结构、本地链接与镜像，新增脚本实际运行；不为纯文档修改跑产品全套测试。README 中英语义一致。

## 原生依赖排障

先确认 worktree、运行时、OS / 架构和模块错误。ABI 不匹配时，Node 后端可在 `backend/` 运行 `npm run rebuild:node`；Electron 用根目录 `npm run rebuild:native`。重建影响当前依赖，切换运行时需重新核查。

`sharp` 等模块加载失败还应检查目标平台 optional dependencies、动态库和最终包内容；重建 better-sqlite3 不能解决其他模块的缺失。可降级功能按现有语义保护启动，不能以吞错掩盖数据库等核心依赖失败。

## 参考入口

[部署](../../../../docs/deployment.md) · [Docker 恢复](../../../../docs/docker-online-update.md) · [MCP](../../../../docs/tutorials/mcp.md) · [CLI](../../../../docs/tutorials/cli.md)
