# PostgreSQL 备份 Runtime（Issue #253）

PostgreSQL Runtime 使用 `pg_dump` / `pg_restore` 建立独立备份与恢复边界，不复制数据库文件，也不调用 `better-sqlite3`。SQLite 历史 `.bak` / `.zip` 备份和恢复流程保持不变。

## 已支持

- 管理员创建 PostgreSQL `db-only` 备份：自定义格式 `.pgdump`。
- 管理员创建 PostgreSQL `full` 备份，ZIP 内包含：
  - `database.dump`；
  - `attachments/`；
  - `fonts/`；
  - `plugins/`；
  - 可用时包含 `.jwt_secret`；
  - 数据库无关的 `meta.json`。
- manifest 记录数据库类型、PostgreSQL / `pg_dump` 版本、schema migration、业务表行数、资源 checksum、应用版本、创建时间和描述。
- `pg_restore --list` 只读预检：验证备份文件总 checksum、ZIP 内外 manifest、dump checksum、附件/字体/插件 checksum 和归档目录。
- 隔离恢复演练：
  1. 先执行完整 checksum 预检；
  2. 创建随机临时数据库；
  3. 使用 `pg_restore --single-transaction --exit-on-error` 真实恢复；
  4. 校验 schema migration、公共表集合、每表行数、未验证外键和无效索引；
  5. 生成 `validationPassed` / `cutoverEligible` 报告；
  6. 无论成功失败都终止残留连接并 `DROP DATABASE ... WITH (FORCE)`。
- 同一进程一次只允许一个恢复演练，避免并发创建临时库造成资源争用。
- `DATABASE_URL` 密码只通过 `PGPASSWORD` 或连接池配置传递，不出现在命令参数、manifest 和日志中。

## API

- `GET /api/backups`：列出 PostgreSQL 备份。
- `GET /api/backups/status`：检查目录、数据库、`pg_dump` / `pg_restore` 可用性，并返回 `restoreDrillReady`。
- `POST /api/backups`：创建备份，body 为 `{ "type": "db-only" | "full", "description"?: string }`。
- `GET /api/backups/:filename/download`：流式下载备份。
- `POST /api/backups/:filename/restore?dryRun=1`：执行只读归档与 checksum 预检。
- `POST /api/backups/:filename/restore-drill`：恢复到临时数据库并执行完整校验，返回前删除临时数据库。

所有接口都要求系统管理员。真正修改当前业务数据库的恢复仍明确返回 `POSTGRES_RESTORE_APPLY_PENDING`，不会静默覆盖现有数据库。

## 恢复演练报告

`restore-drill` 返回：

- 期望和实际 schema migration；
- 每张表的期望行数、实际行数和是否一致；
- 缺失表和额外表；
- 行数不一致表；
- 未验证外键；
- 无效或未就绪索引；
- `validationPassed`；
- `cutoverEligible`；
- 临时数据库名称及 `temporaryDatabaseDropped: true`。

行数不一致不会触碰现网数据库，但会令 `cutoverEligible=false`，阻止后续正式切换。当前备份 manifest 的行数统计和 `pg_dump` 之间尚未共享同一个导出快照；高写入场景可能因此产生可诊断的行数差异，正式切换前必须进一步实现写入屏障或导出快照一致性。

## 配置

- `DATABASE_URL`：PostgreSQL 连接 URL，必填。
- `BACKUP_DIR`：备份目录；默认 `<dataDir>/backups`。
- `PG_DUMP_PATH`：可选，自定义 `pg_dump` 路径。
- `PG_RESTORE_PATH`：可选，自定义 `pg_restore` 路径。
- `PG_MAINTENANCE_DATABASE`：创建和删除临时数据库时使用的维护库，默认 `postgres`。
- `ELECTRON_USER_DATA`：数据目录，用于附件、字体、插件和 JWT 密钥。

执行恢复演练的 PostgreSQL 账号必须具有 `CREATEDB` 权限。Docker/CI 使用的实例管理员默认具备该权限；受管数据库需要由运维单独授权或提供隔离演练实例。

Docker 运行时镜像安装 `postgresql-client`，因此容器内具备 `pg_dump` 与 `pg_restore`。非 Docker 部署需安装与目标数据库兼容的 PostgreSQL 客户端工具。

## 尚未开放

- 全站维护模式和业务写入屏障；
- `pg_export_snapshot` 驱动的 dump 与行数清单同快照一致性；
- 从临时库到正式库的原子切换与失败回滚；
- 自动备份调度、保留策略和远端备份与 SQLite 功能完全对齐；
- PostgreSQL 灾难恢复演练计划及 RPO/RTO 报告。

下一阶段应优先实现“写入屏障 + 一致性快照 + 显式切换状态机”，禁止直接对当前生产库运行 `pg_restore --clean`。
