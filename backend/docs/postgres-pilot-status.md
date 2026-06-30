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

## PG-PILOT-01-B：真实 PostgreSQL 验证 ✅ 通过

### 验证环境

- PostgreSQL 18.4（本机 Windows）
- 数据库：`nowen_note_test`
- 用户：`nowen`
- 连接：`postgres://nowen:nowen_dev_password@localhost:5432/nowen_note_test`

### 验证结果

| 测试 | 结果 |
|------|------|
| postgres-adapter.test.ts | 11 pass, 0 fail |
| system-settings-repository-pg.test.ts | 11 pass, 0 fail |
| system-settings-repository-async.test.ts | 7 pass, 0 fail |
| SQLite 完整回归 | 94 pass, 0 fail |

**总计：123 pass, 0 fail**

### 发现并修复的问题

PostgreSQL 对未加引号的 camelCase 列名会折叠为小写。schema 定义 `"updatedAt"`（带双引号），但 SQL 中写 `updatedAt`（不带引号），导致列不存在错误。

修复：在 async 方法的 SQL 中对 `updatedAt` 加双引号。同步 SQLite 方法不受影响。

- Commit：`15622a2` — fix: quote postgres camelCase column in system settings pilot

---

## PG-PILOT-02：customFontsRepository 双库试点 ✅ 完全收口

### 已完成内容

1. `createCustomFontsRepository(adapter, nowExpr)` — 可注入 adapter 的工厂函数
2. 默认 `customFontsRepository` 仍使用 SQLite（`SqliteAdapter(getDb())`）
3. 9 个 async 方法全部支持 adapter 注入
4. `createAsync` 使用 `nowExpr` 参数（SQLite: `datetime('now')`, PG: `NOW()`）
5. `custom-fonts-repository-pg.test.ts` — 11 个 PG 测试用例
6. SQL 中 camelCase 列名已全部加双引号（`"fileName"`, `"fileSize"`, `"createdAt"`）

### Commit

- `766356e` — test: add postgres pilot for custom fonts repository

### 验证结果

| 测试 | 结果 |
|------|------|
| postgres-adapter.test.ts | 11 pass |
| system-settings-repository-pg.test.ts | 11 pass |
| custom-fonts-repository-pg.test.ts | 11 pass |
| custom-fonts-repository-async.test.ts | 11 pass |
| system-settings-repository-async.test.ts | 7 pass |
| sqlite-adapter.test.ts | 27 pass |
| db-dialect.test.ts | 13 pass |

**PG 总计：33 pass / 0 fail | SQLite 总计：58 pass / 0 fail**

### 经验

customFontsRepository 仅需处理两个方言差异：
1. `datetime('now')` → `NOW()`（通过 `nowExpr` 参数注入）
2. camelCase 列名加双引号（已在 PG-CAMELCASE-FIX-01-A 完成）

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

---

## PG-PILOT-01 ✅ 完全收口

### 关键 Commits

| Commit | 描述 |
|--------|------|
| `8f16968` | test: add postgres pilot coverage for system settings repository |
| `5c43575` | docs: document postgres pilot validation blocker |
| `a1d801d` | test: align postgres pilot test environment |
| `15622a2` | fix: quote postgres camelCase column in system settings pilot |

### 经验教训

**PostgreSQL camelCase 列名必须加双引号。** schema 中 `"updatedAt"` 带引号保留驼峰，SQL 中也必须写 `"updatedAt"`，否则 PG 折叠为 `updatedat` 导致列不存在。后续迁移其他 Repository 时需注意此规则。

---

## PG-PILOT-03：favoritesRepository 双库试点 ✅ 完全收口

### 已完成内容

1. `createFavoritesRepository(adapter, nowExpr, insertPrefix, conflictClause)` — 可注入 adapter 的工厂函数
2. 默认 `favoritesRepository` 仍使用 SQLite（`SqliteAdapter(getDb())`）
3. 7 个 async 方法全部支持 adapter 注入
4. `addFavoriteAsync` 使用 `insertPrefix` + `conflictClause` + `nowExpr`
5. `deleteByNoteIdAsync` / `deleteByUserIdAsync` 继续返回 `execute().changes`
6. `favorites-repository-pg.test.ts` — 10 个 PG 测试用例

### Commit

- `837b022` — test: add postgres pilot for favorites repository

### 验证结果

| 测试 | 结果 |
|------|------|
| postgres-adapter.test.ts | 11 pass |
| system-settings-repository-pg.test.ts | 11 pass |
| custom-fonts-repository-pg.test.ts | 11 pass |
| favorites-repository-pg.test.ts | 10 pass |
| favorites-repository-async.test.ts | 9 pass |
| note-tags-repository-async.test.ts | pass |
| tags-repository-async.test.ts | pass |
| system-settings-repository-async.test.ts | 7 pass |
| custom-fonts-repository-async.test.ts | 11 pass |
| sqlite-adapter.test.ts | 27 pass |
| db-dialect.test.ts | 13 pass |

**PG 总计：43 pass / 0 fail | SQLite 总计：86 pass / 0 fail**

### 经验

1. `INSERT OR IGNORE` → `INSERT` + `ON CONFLICT ("userId", "noteId") DO NOTHING`
2. `datetime('now')` → `NOW()`（通过 `nowExpr` 参数注入）
3. `result.changes` → `adapter.execute().changes`（PostgresAdapter 已兼容）
4. favorites 表 `PRIMARY KEY ("userId", "noteId")` 支持 `ON CONFLICT DO NOTHING`，无需指定 conflict target

### 附加修复

- `noteTagsRepository.ts`：camelCase 列名引号修复（commit `5d9ef9d`）
- `tagsRepository.ts`：camelCase 列名引号修复，JOIN 别名正确（commit `929efab`）
