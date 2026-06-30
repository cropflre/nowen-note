# PostgreSQL 本地开发环境

## 概述

PostgreSQL 本地开发环境用于 PG-PILOT 双库测试。
**SQLite 仍是默认数据库**，PostgreSQL 仅作为可选测试环境。

## 启动

```bash
docker compose -f docker-compose.postgres.yml up -d
```

## 停止

```bash
docker compose -f docker-compose.postgres.yml down
```

## 清理数据

```bash
docker compose -f docker-compose.postgres.yml down -v
```

## 连接信息

| 参数 | 值 |
|------|-----|
| Host | localhost |
| Port | 5432 |
| Database | nowen_note_test |
| User | nowen |
| Password | nowen_dev_password |
| URL | `postgres://nowen:nowen_dev_password@localhost:5432/nowen_note_test` |

## psql 连接

```bash
psql postgres://nowen:nowen_dev_password@localhost:5432/nowen_note_test
```

## 初始化 Schema

```bash
psql postgres://nowen:nowen_dev_password@localhost:5432/nowen_note_test -f backend/src/db/postgres/schema.sql
```

## 环境变量

在 `.env` 或 `.env.local` 中添加（可选）：

```bash
# PostgreSQL test database (optional, for PG-PILOT tests)
TEST_PG_DATABASE_URL=postgres://nowen:nowen_dev_password@localhost:5432/nowen_note_test
```

**注意：** 当前运行时代码不读取此变量。它仅用于测试。

## 当前状态

- ✅ Docker PostgreSQL 配置就绪
- ✅ Schema SQL 草案就绪
- ✅ PostgresAdapter 已实现（PG-PILOT-01-A）
- ✅ PG 测试脚手架就绪（无环境时自动 skip）
- ⬜ 真实 PostgreSQL 验证（PG-PILOT-01-B，环境阻塞）
- ⬜ SQLite 仍为默认数据库
