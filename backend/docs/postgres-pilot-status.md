# PostgreSQL Pilot 状态

## PG-PILOT-01-A：代码实现 ✅ 完成

### 已完成内容

1. `createSystemSettingsRepository(adapter, nowExpr)` — 可注入 adapter 的工厂函数
2. 默认 `systemSettingsRepository` 仍使用 SQLite（`SqliteAdapter(getDb())`）
3. `PostgresAdapter` 实现 `DatabaseAdapter` 接口（`queryOne/queryMany/execute/executeBatch/executeStatements`）
4. `pg-test-db.ts` 测试 helper（`hasPg/getPgPool/initPgSchema/cleanTable/closePgPool`）
5. `system-settings-repository-pg.test.ts` — 11 个 PG 测试用例
6. `postgres-adapter.test.ts` — 11 个 adapter 测试用例

### 设计约束

- 无 `DB_DRIVER` 环境变量
- 无 `DATABASE_URL` 切库逻辑
- 无 `withTransaction`
- 无 `db.transaction(async)`
- 运行时代码不引用 `TEST_PG_DATABASE_URL`

### Commit

- `8f16968` — test: add postgres pilot coverage for system settings repository (PG-PILOT-01)

---

## PG-PILOT-01-B：真实 PostgreSQL 验证 ⏳ 阻塞

### 阻塞原因

当前环境无 Docker，无法启动 PostgreSQL 容器。

### 当前状态

- `TEST_PG_DATABASE_URL` 未设置
- `system-settings-repository-pg.test.ts` — 11 个测试全部 SKIP
- `postgres-adapter.test.ts` — 11 个测试全部 SKIP
- 无法验证 PG adapter 在真实数据库上的行为

### 解除阻塞方式

以下任选其一：

| 方案 | 操作 | 适用场景 |
|------|------|----------|
| A | 安装 Docker Desktop → `docker compose -f docker-compose.postgres.yml up -d` | 推荐，与开发环境一致 |
| B | 本机安装 PostgreSQL → 创建 `nowen_note_test` 数据库 | 不想装 Docker |
| C | 远程测试库（NAS / 云服务器 / Supabase / Neon）| 最快 |

### 验证步骤

解除阻塞后执行：

```bash
# 1. 设置连接字符串
$env:TEST_PG_DATABASE_URL="postgres://nowen:nowen_dev_password@localhost:5432/nowen_note_test"

# 2. 运行 adapter 测试
npx tsx --test tests/postgres-adapter.test.ts

# 3. 运行 repository 测试
npx tsx --test tests/system-settings-repository-pg.test.ts

# 4. 确认全部通过后标记 PG-PILOT-01 完成
```

---

## PG-PILOT-02：不建议启动

在 PG-PILOT-01-B 真实验证通过前，不扩展第二个 Repository。

---

## SQLite 回归验证

| 测试 | 结果 |
|------|------|
| system-settings-repository-async | ✅ 7 pass |
| sqlite-adapter | ✅ 27 pass |
| db-dialect | ✅ 13 pass |
| task-projects-repository-async | ✅ 24 pass |
| note-links-repository-async | ✅ 21 pass |
| notebook-permissions | ✅ 3 pass |
| task-description | ✅ 6 pass |

**结论：SQLite 默认运行完全不受影响。**
