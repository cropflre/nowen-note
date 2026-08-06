# PostgreSQL 备份 Runtime（Issue #253）

本阶段为 PostgreSQL Runtime 建立独立备份边界，不修改成熟的 SQLite `BackupManager`。SQLite 历史 `.bak` / `.zip` 格式和恢复流程保持原样；PostgreSQL 使用 `pg_dump` / `pg_restore`，避免复制数据库文件或调用 `better-sqlite3`。

## 已支持

- 管理员创建 PostgreSQL `db-only` 备份：自定义格式 `.pgdump`。
- 管理员创建 PostgreSQL `full` 备份：ZIP 内含：
  - `database.dump`；
  - `attachments/`；
  - `fonts/`；
  - `plugins/`；
  - 可用时包含 `.jwt_secret`；
  - 数据库无关的 `meta.json`。
- manifest 记录：
  - 数据库类型；
  - PostgreSQL / `pg_dump` 版本；
  - 已应用 schema migration；
  - 每张业务表的精确行数；
  - dump、附件、字体和插件 checksum；
  - 应用版本、创建时间和描述。
- `pg_restore --list` 恢复 dry-run：验证备份文件总 checksum、ZIP 内外 manifest、dump checksum、附件/字体/插件 checksum 和归档目录，不连接目标数据库、不执行 DDL/DML。
- 管理员列表、状态、创建、下载和 dry-run 路由。
- `DATABASE_URL` 密码只通过 `PGPASSWORD` 环境变量传递，不出现在命令参数、manifest 或日志中。

## API

- `GET /api/backups`：列出 PostgreSQL 备份。
- `GET /api/backups/status`：检查目录、数据库和 `pg_dump` / `pg_restore` 可用性。
- `POST /api/backups`：创建备份，body 为 `{ "type": "db-only" | "full", "description"?: string }`。
- `GET /api/backups/:filename/download`：下载备份。
- `POST /api/backups/:filename/restore?dryRun=1`：执行只读恢复预检。

所有接口都要求系统管理员。破坏性恢复当前明确返回 `POSTGRES_RESTORE_APPLY_PENDING`，不会静默覆盖现有数据库。

## 配置

- `DATABASE_URL`：PostgreSQL 连接 URL，必填。
- `BACKUP_DIR`：备份目录；默认 `<dataDir>/backups`。
- `PG_DUMP_PATH`：可选，自定义 `pg_dump` 路径。
- `PG_RESTORE_PATH`：可选，自定义 `pg_restore` 路径。
- `ELECTRON_USER_DATA`：数据目录，用于附件、字体、插件和 JWT 密钥。

Docker 运行时镜像安装 `postgresql-client`，因此容器内具备 `pg_dump` 与 `pg_restore`。非 Docker 部署需由管理员安装兼容目标数据库版本的 PostgreSQL 客户端工具。

支持从 `DATABASE_URL` 映射 `PGHOST`、`PGPORT`、`PGUSER`、`PGDATABASE`、`PGPASSWORD` 和 `PGSSLMODE`。连接 URL 不会作为子进程参数传递。

## 尚未开放

- 恢复写入锁和全站维护模式；
- 恢复到临时数据库后的业务校验与原子切换；
- 自动备份调度、保留策略和远端备份与 SQLite 功能完全对齐；
- PostgreSQL 灾难恢复演练及 RPO/RTO 报告。

下一阶段应先实现“临时数据库恢复 → schema/行数/业务健康检查 → 显式切换”，禁止直接对当前生产库运行 `pg_restore --clean`。
