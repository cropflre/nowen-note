# PostgreSQL 本地开发与运行时验证

## 概述

SQLite 仍是 Nowen Note 的默认数据库和完整业务运行模式。

`PG-RUNTIME-01` 新增了正式的数据库运行时选择和 PostgreSQL 连接生命周期，但在 #248 / #249 完成业务层直连清理与全量 Repository 迁移前，PostgreSQL 模式仅提供数据库健康检查，不开放业务接口，也不会静默回退到 SQLite。

## 启动本地 PostgreSQL

```bash
docker compose -f docker-compose.postgres.yml up -d
```

停止：

```bash
docker compose -f docker-compose.postgres.yml down
```

清理测试数据卷：

```bash
docker compose -f docker-compose.postgres.yml down -v
```

## 默认连接信息

| 参数 | 值 |
|------|-----|
| Host | localhost |
| Port | 5432 |
| Database | nowen_note_test |
| User | nowen |
| Password | nowen_dev_password |
| URL | `postgres://nowen:nowen_dev_password@localhost:5432/nowen_note_test` |

## 初始化 Schema

```bash
psql postgres://nowen:nowen_dev_password@localhost:5432/nowen_note_test \
  -f backend/src/db/postgres/schema.sql
```

## 双库测试环境变量

PG-PILOT 测试继续使用测试专用变量：

```bash
TEST_PG_DATABASE_URL=postgres://nowen:nowen_dev_password@localhost:5432/nowen_note_test
```

生产运行时代码不会读取 `TEST_PG_DATABASE_URL`。

## 正式运行时环境变量

SQLite 默认模式不需要设置 `DB_DRIVER`：

```bash
DB_DRIVER=sqlite
DB_PATH=./data/nowen-note.db
```

PostgreSQL runtime-only 模式：

```bash
DB_DRIVER=postgres
DATABASE_URL=postgres://nowen:nowen_dev_password@localhost:5432/nowen_note_test
PG_POOL_MAX=10
PG_CONNECTION_TIMEOUT_MS=5000
PG_IDLE_TIMEOUT_MS=30000
```

参数规则：

| 变量 | 默认值 | 范围/说明 |
|------|--------|-----------|
| `DB_DRIVER` | `sqlite` | 仅支持 `sqlite` / `postgres` |
| `DATABASE_URL` | 无 | `DB_DRIVER=postgres` 时必填 |
| `PG_POOL_MAX` | `10` | 1～100 |
| `PG_CONNECTION_TIMEOUT_MS` | `5000` | 100～120000 ms |
| `PG_IDLE_TIMEOUT_MS` | `30000` | 1000～600000 ms |

PostgreSQL 连接失败或配置缺失时，进程会明确失败并拒绝启动，不会回退到 SQLite。启动日志只显示主机、端口和数据库名，不输出用户名或密码。

## 验证 runtime-only 模式

启动后访问：

```text
GET /api/health
```

连接正常时会返回：

```json
{
  "status": "ok",
  "database": {
    "ok": true,
    "driver": "postgres"
  },
  "runtime": {
    "mode": "postgres-runtime-only",
    "businessRoutesReady": false
  }
}
```

在 #248 / #249 完成前，其余业务路由统一返回 HTTP 503：

```json
{
  "code": "POSTGRES_RUNTIME_MIGRATION_PENDING",
  "issue": 247
}
```

该限制用于防止未迁移代码继续直接调用 SQLite，不能通过静默降级绕过。

## 当前状态

- ✅ Docker PostgreSQL 测试配置就绪
- ✅ PostgreSQL Schema 基线就绪
- ✅ PostgresAdapter 与真实 PG 试点测试已存在
- ✅ `DB_DRIVER` / `DATABASE_URL` 配置校验
- ✅ PostgreSQL Pool 初始化、健康检查和优雅关闭
- ✅ PostgreSQL 启动不加载 SQLite 原生驱动和 SQLite 业务入口
- ✅ 当前双库试点 Repository 的异步方法可从运行时获取 Adapter
- ⏳ 业务层直接 SQLite 访问清理：#248
- ⏳ 全量 Repository PostgreSQL 迁移：#249
- ⏳ 正式业务路由 PostgreSQL 可用：后续阶段
