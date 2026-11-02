# Docker 数据库版本升级与启动提示

日期：2026-10-27。分支：`release/v1.5.4`，基准提交 `54648949`。

目标：历史数据库继续通过完整迁移链升级；数据库高于程序支持范围时，在业务初始化前停止数据写入，并在原地址提示升级服务端。适用 DCC-008，不降低数据库版本、不覆盖原数据、不自动恢复备份。

## 本地验证

| 场景 | 结果 |
| --- | --- |
| 新库，以及无迁移记录、结构 40/123/131 的数据库 | 启动预检放行，预检不创建或修改数据库；业务服务继续负责迁移 |
| `v1.5.1` 历史源码生成的结构 123 测试库 | 当前源码直接升级到 138，笔记 ID、用户、笔记本、标题、正文保留，SQLite `quick_check=ok` |
| `v1.5.2` 历史源码生成的结构 131 测试库 | 当前源码直接升级到 138，同上；无需逐个安装中间应用版本 |
| 人工构造的未来结构 999999 | 在基线建表、WAL 设置及 VACUUM 前拒绝打开，数据库文件字节未变 |
| 版本不兼容提示服务 | 原地址返回升级提示；健康接口 503；版本接口返回真实结构信息；POST 被拒绝；进程持续运行；页面不泄露路径或密钥 |
| Docker 启动入口 | 正常应用继续加载 hardened 入口；版本不兼容时 exec 提示服务；其他错误正常失败；updater 不进入提示流程 |

历史升级探针从本地 Git 标签解包 `backend/src` 和 `backend/package.json`，在独立临时目录连接现有依赖生成数据库，插入合成用户、笔记本及笔记，再以当前源码打开同一库并核对内容。探针不接触用户数据；不能代表所有历史版本、生产附件、完整账号配置或所有数据状态均已验收。

使用匹配本机 better-sqlite3 ABI 的 Electron Node 运行时，逐文件隔离运行以下回归：`database-startup-compatibility`、`docker-hardened-entrypoint`、`docker-updater`、`docker-updater-jobs`、`migration-bootstrap-order`、`knowledge-tree-migration-registry`、`migration-task-version-compatibility`、`knowledge-tree-existing-data-migration`、`block-schema-repair-migration`、`backup-restore-integrity`。上述套件均通过。后端类型检查、DCC 映射检查及 Shell 语法检查通过。

## 限制与既有失败

- `encrypted-content-v2-migration.test.ts` 两例失败：测试删除 123 及以后的迁移记录后，v138 再次创建已存在的 `agent_templates`。已在未修改的 `54648949` 临时源码副本上复现相同失败；本次未修改该迁移或测试。
- 未执行真实 Docker 镜像构建、极空间或 Docker Copilot 验收；旧镜像本身不会自动获得新提示。第三方主动健康故障重启仍取决于其配置。
- 自动迁移测试使用合成数据；生产升级仍需保留完整数据库与附件备份。
