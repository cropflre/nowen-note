# 用户 AI 配置完全隔离实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将全部 AI 配置从全局 `system_settings` 迁移为按登录用户隔离的配置，任何设置与 AI 调用都不能跨用户读取或覆盖。

**架构：** 新增以 `(userId, key)` 为主键的 `user_ai_settings` 表和统一访问服务。路由、任务 AI 与 Embedding 只通过显式 `userId` 获取配置；旧全局 AI 配置仅迁移给现有管理员后删除。

**技术栈：** TypeScript、Hono、better-sqlite3、PostgreSQL schema、Node.js test runner

---

## 文件结构

- 创建 `backend/src/repositories/userAISettingsRepository.ts`：封装用户 AI KV 的同步和 adapter 异步操作。
- 创建 `backend/src/services/user-ai-settings.ts`：定义允许的 AI key、默认值、有效设置读取、按用户写入和手动开关保护。
- 创建 `backend/tests/user-ai-settings-migration.test.ts`：验证旧全局配置只迁移给管理员。
- 创建 `backend/tests/user-ai-settings-isolation.test.ts`：验证数据层、设置接口和配置方案的双用户隔离。
- 创建 `backend/tests/embedding-user-ai-settings.test.ts`：验证查询向量化使用指定用户配置。
- 创建 `backend/tests/task-ai-settings-isolation.test.ts`：验证任务拆解使用请求用户配置。
- 修改 `backend/src/db/schema.ts`：初始 SQLite schema 增加 `user_ai_settings`。
- 修改 `backend/src/db/migrations.ts`：增加 v47 迁移、管理员复制和旧全局 key 清理。
- 修改 `backend/src/db/postgres/schema.base.sql`：增加相同 PostgreSQL 表与索引。
- 修改 `backend/src/repositories/index.ts`：导出新仓库。
- 修改 `backend/src/routes/ai.ts`：全部 AI 设置与调用按请求用户读取。
- 修改 `backend/src/routes/user-preferences-legacy.ts`：AI 配置方案按请求用户读写。
- 修改 `backend/src/routes/ai-reliable.ts`：状态、启用开关和问答按请求用户处理。
- 修改 `backend/src/routes/tasks.ts`：任务拆解使用请求用户配置。
- 修改 `backend/src/services/embedding-worker.ts`：查询和后台任务使用对应用户配置。
- 修改相关现有测试：把全局 AI KV 辅助函数改为带 `userId` 的用户设置辅助函数。

### 任务 1：建立用户 AI 配置表、迁移和仓库

**文件：**
- 创建：`backend/src/repositories/userAISettingsRepository.ts`
- 创建：`backend/tests/user-ai-settings-migration.test.ts`
- 创建：`backend/tests/user-ai-settings-isolation.test.ts`
- 修改：`backend/src/db/schema.ts`
- 修改：`backend/src/db/migrations.ts`
- 修改：`backend/src/db/postgres/schema.base.sql`
- 修改：`backend/src/repositories/index.ts`

- [ ] **步骤 1：编写失败的迁移测试**

构造包含两个管理员和一个普通用户的旧库，写入旧 AI key，执行名为 `user-ai-settings` 的迁移：

```ts
const migration = MIGRATIONS.find((item) => item.name === "user-ai-settings");
assert.ok(migration);
migration.up(db);

const rows = db.prepare(`
  SELECT userId, key, value
  FROM user_ai_settings
  ORDER BY userId, key
`).all() as Array<{ userId: string; key: string; value: string }>;

assert.ok(rows.some((row) => row.userId === "admin-a" && row.key === "ai_api_key" && row.value === "legacy-secret"));
assert.ok(rows.some((row) => row.userId === "admin-b" && row.key === "ai_api_key" && row.value === "legacy-secret"));
assert.equal(rows.some((row) => row.userId === "normal-user"), false);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM system_settings WHERE key LIKE 'ai_%'").get().count, 0);
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
cd backend
node --import tsx --test tests/user-ai-settings-migration.test.ts
```

预期：FAIL，找不到 `user-ai-settings` 迁移。

- [ ] **步骤 3：实现 schema 与 v47 迁移**

SQLite 表结构：

```sql
CREATE TABLE IF NOT EXISTS user_ai_settings (
  userId TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (userId, key),
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_ai_settings_user ON user_ai_settings(userId);
```

迁移使用明确白名单复制 `ai_provider`、`ai_api_url`、`ai_api_key`、`ai_model`、三个 `ai_embedding_*`、`ai_profiles_v1`、`ai_active_profile_id`、`ai_manual_enabled` 及 `ai_disabled_backup_%`。只复制给 `role = 'admin'` 的现有用户，随后删除这些全局 key，并删除旧的 `ai_manual_config_guard_insert` / `ai_manual_config_guard_update` 触发器。PostgreSQL schema 使用 `TIMESTAMPTZ NOT NULL DEFAULT NOW()`。

- [ ] **步骤 4：实现仓库并补数据隔离断言**

仓库接口固定为：

```ts
export interface UserAISetting {
  userId: string;
  key: string;
  value: string;
  updatedAt: string;
}

export interface UserAISettingEntry {
  key: string;
  value: string;
}

export function createUserAISettingsRepository(adapter?: DatabaseAdapter, nowExpr?: string) {
  return {
    get(userId: string, key: string): UserAISetting | undefined,
    getMany(userId: string, keys: string[]): UserAISetting[],
    getByPrefix(userId: string, prefix: string): UserAISetting[],
    set(userId: string, key: string, value: string): void,
    setMany(userId: string, entries: UserAISettingEntry[]): void,
    deleteMany(userId: string, keys: string[]): void,
    getAsync(userId: string, key: string): Promise<UserAISetting | undefined>,
    setManyAsync(userId: string, entries: UserAISettingEntry[]): Promise<void>,
  };
}
```

每条 SQL 的 `WHERE` 和冲突键都必须包含 `userId`。

- [ ] **步骤 5：运行迁移与仓库测试**

```powershell
cd backend
node --import tsx --test tests/user-ai-settings-migration.test.ts tests/user-ai-settings-isolation.test.ts
```

预期：迁移及仓库双用户读写测试全部 PASS。

- [ ] **步骤 6：提交数据层**

```powershell
git add backend/src/db/schema.ts backend/src/db/migrations.ts backend/src/db/postgres/schema.base.sql backend/src/repositories/userAISettingsRepository.ts backend/src/repositories/index.ts backend/tests/user-ai-settings-migration.test.ts backend/tests/user-ai-settings-isolation.test.ts
git commit -m "feat(ai): add per-user AI settings storage"
```

### 任务 2：统一用户 AI 配置服务

**文件：**
- 创建：`backend/src/services/user-ai-settings.ts`
- 修改：`backend/tests/user-ai-settings-isolation.test.ts`

- [ ] **步骤 1：先写服务层失败测试**

测试两个用户使用不同的 Provider、Key、模型和 Embedding 设置：

```ts
setUserAISettings("user-a", [
  { key: "ai_provider", value: "openai" },
  { key: "ai_api_key", value: "key-a" },
  { key: "ai_model", value: "model-a" },
]);
setUserAISettings("user-b", [
  { key: "ai_provider", value: "deepseek" },
  { key: "ai_api_key", value: "key-b" },
  { key: "ai_model", value: "model-b" },
]);

assert.equal(getUserAISettings("user-a").ai_api_key, "key-a");
assert.equal(getUserAISettings("user-b").ai_api_key, "key-b");
assert.throws(() => getUserAISettings(""), /userId/);
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd backend
node --import tsx --test tests/user-ai-settings-isolation.test.ts
```

预期：FAIL，用户 AI 配置服务尚不存在。

- [ ] **步骤 3：实现服务最小接口**

```ts
export function getUserAISettings(userId: string): AISettings;
export function getUserAISetting(userId: string, key: string): string;
export function setUserAISetting(userId: string, key: string, value: string): void;
export function setUserAISettings(userId: string, entries: UserAISettingEntry[]): void;
export function setGuardedUserAISettings(userId: string, entries: UserAISettingEntry[]): void;
export function isManualAIEnabled(userId: string): boolean;
```

`setGuardedUserAISettings` 在该用户的 `ai_manual_enabled` 为 `false` 时忽略有效配置写入；备份和重新启用流程使用非 guarded 写入。默认 Provider 与模型保持现有 `openai` / `gpt-4o-mini`，绝不读取 `system_settings`。

- [ ] **步骤 4：运行服务测试**

```powershell
cd backend
node --import tsx --test tests/user-ai-settings-isolation.test.ts
```

预期：双用户读取、空 userId 拒绝和手动开关保护测试全部 PASS。

- [ ] **步骤 5：提交服务层**

```powershell
git add backend/src/services/user-ai-settings.ts backend/tests/user-ai-settings-isolation.test.ts
git commit -m "feat(ai): resolve AI settings by user"
```

### 任务 3：隔离设置接口与 AI 配置方案

**文件：**
- 修改：`backend/src/routes/ai.ts`
- 修改：`backend/src/routes/user-preferences-legacy.ts`
- 修改：`backend/src/routes/ai-reliable.ts`
- 修改：`backend/tests/user-preferences.test.ts`
- 修改：`backend/tests/ai-config-toggle.test.ts`
- 修改：`backend/tests/ai-connection-test.test.ts`
- 修改：`backend/tests/user-ai-settings-isolation.test.ts`

- [ ] **步骤 1：添加双用户接口失败测试**

```ts
await requestJson("PUT", "/ai/settings", {
  ai_provider: "openai",
  ai_api_url: "https://a.example/v1",
  ai_api_key: "secret-a",
  ai_model: "model-a",
}, "user-a");

const userB = await requestJson("GET", "/ai/settings", undefined, "user-b");
assert.equal(userB.json.ai_api_key_set, false);
assert.notEqual(userB.json.ai_api_url, "https://a.example/v1");

const missingUser = await app.request("/ai/settings");
assert.equal(missingUser.status, 401);
```

配置方案测试由 A 创建并激活方案，断言 B 的列表不包含该方案，B 的有效设置未变化。

- [ ] **步骤 2：运行接口测试验证失败**

```powershell
cd backend
node --import tsx --test tests/user-ai-settings-isolation.test.ts tests/user-preferences.test.ts tests/ai-config-toggle.test.ts tests/ai-connection-test.test.ts
```

预期：FAIL，当前接口仍读写全局 `system_settings`。

- [ ] **步骤 3：改造 `/api/ai`**

为 `ai` 路由增加统一认证守卫：

```ts
ai.use("*", async (c, next) => {
  if (!c.req.header("X-User-Id")) return c.json({ error: "Unauthorized" }, 401);
  await next();
});
```

所有 `getAISettings()` 调用改为 `getUserAISettings(c.req.header("X-User-Id")!)`。`PUT /settings` 仅写当前用户；模型发现、连接测试、对话和所有 AI 功能使用同一个当前用户配置对象。

- [ ] **步骤 4：改造配置方案**

以下函数全部增加 `userId` 参数，并只调用用户 AI 配置服务：

```ts
legacyProfile(userId: string): AIProfile;
parseStoredProfiles(userId: string): AIProfile[];
saveAIProfiles(userId: string, profiles: AIProfile[], activeProfileId: string): void;
syncEffectiveAISettings(userId: string, profile: AIProfile): void;
ensureAIProfiles(userId: string): { profiles: AIProfile[]; activeProfileId: string };
```

每个 `/ai-profiles` handler 首先取 `X-User-Id`，缺失返回 401。掩码 key 更新继续保留原 secret，但只在同一用户内查找。

- [ ] **步骤 5：改造 reliable 开关**

`getAISettings`、`restoreActiveProfile`、`isManualAIEnabled`、`setManualAIEnabled` 全部接收 `userId`。关闭 A 时只备份和清空 A；A 切换方案不能恢复有效配置；B 的配置和开关保持不变。

- [ ] **步骤 6：运行接口测试**

```powershell
cd backend
node --import tsx --test tests/user-ai-settings-isolation.test.ts tests/user-preferences.test.ts tests/ai-config-toggle.test.ts tests/ai-connection-test.test.ts
```

预期：全部 PASS；连接测试 mock 收到当前请求用户的 Authorization 和模型。

- [ ] **步骤 7：提交接口隔离**

```powershell
git add backend/src/routes/ai.ts backend/src/routes/user-preferences-legacy.ts backend/src/routes/ai-reliable.ts backend/tests/user-preferences.test.ts backend/tests/ai-config-toggle.test.ts backend/tests/ai-connection-test.test.ts backend/tests/user-ai-settings-isolation.test.ts
git commit -m "fix(ai): isolate settings and profiles by user"
```

### 任务 4：隔离任务 AI 与 Embedding

**文件：**
- 创建：`backend/tests/embedding-user-ai-settings.test.ts`
- 创建：`backend/tests/task-ai-settings-isolation.test.ts`
- 修改：`backend/src/routes/tasks.ts`
- 修改：`backend/src/services/embedding-worker.ts`
- 修改：`backend/src/routes/ai.ts`
- 修改：`backend/src/routes/ai-reliable.ts`

- [ ] **步骤 1：编写 Embedding 双用户失败测试**

为 A、B 写入不同的 Embedding URL、Key 和模型，mock `fetch` 后分别调用：

```ts
await embedQuery("user-a", "alpha question");
await embedQuery("user-b", "beta question");

assert.deepEqual(requests, [
  { url: "https://embed-a.example/v1/embeddings", authorization: "Bearer embed-key-a", model: "embed-a" },
  { url: "https://embed-b.example/v1/embeddings", authorization: "Bearer embed-key-b", model: "embed-b" },
]);
```

任务测试分别以 A、B 请求各自任务的 `/ai-breakdown`，mock AI 响应并断言两次请求的 Authorization 与 model 分别来自 A、B。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd backend
node --import tsx --test tests/embedding-user-ai-settings.test.ts
```

预期：FAIL，`embedQuery` 尚未接收 `userId`。

- [ ] **步骤 3：改造查询与统计调用**

```ts
export async function embedQuery(userId: string, text: string): Promise<number[] | null>;
export function getEmbeddingStats(opts: { userId: string; workspaceId?: string | null }): EmbeddingStats;
```

`ai.ts` 和 `ai-reliable.ts` 的调用传入请求用户。配置缺失时只对该用户降级，不读取其他用户设置。

- [ ] **步骤 4：改造后台队列**

笔记队列按 `task.userId` 读取配置；附件队列查询同时返回 `userId` 并按任务用户读取。未配置 Embedding 的用户任务保持 pending，不借用其他用户配置；配置齐全的其他用户任务仍可被选中处理。`processOne` 和 `processAttachmentOne` 获得的 `cfg` 必须来自各自资源的 `userId`：

```ts
for (const task of tasks) {
  const cfg = readEmbeddingConfig(task.userId);
  if (!cfg) continue;
  embeddingQueueRepository.markProcessing(task.noteId);
  await processOne(db, cfg, task);
}

for (const attachmentTask of attachmentTasks) {
  const cfg = readEmbeddingConfig(attachmentTask.userId);
  if (!cfg) continue;
  markAttachmentProcessing.run(attachmentTask.attachmentId);
  await processAttachmentOne(db, cfg, attachmentTask);
}
```

队列查询必须过滤到存在非空 `ai_embedding_model` 且存在有效 URL（`ai_embedding_url` 或 `ai_api_url`）的用户，避免未配置用户的旧任务长期占满批次。

- [ ] **步骤 5：改造任务拆解**

删除 `tasks.ts` 中 `system_settings WHERE key LIKE 'ai_%'` 查询，改为：

```ts
const settings = getUserAISettings(userId);
if (!settings.ai_api_url) {
  return c.json({ error: "AI not configured", code: "AI_NOT_CONFIGURED" }, 400);
}
```

- [ ] **步骤 6：运行任务与 Embedding 测试**

```powershell
cd backend
node --import tsx --test tests/embedding-user-ai-settings.test.ts tests/task-ai-settings-isolation.test.ts tests/user-ai-settings-isolation.test.ts
```

预期：Embedding 请求按用户使用不同 URL、Key、模型；任务 AI 读取当前请求用户配置。

- [ ] **步骤 7：提交后台调用隔离**

```powershell
git add backend/src/routes/tasks.ts backend/src/services/embedding-worker.ts backend/src/routes/ai.ts backend/src/routes/ai-reliable.ts backend/tests/embedding-user-ai-settings.test.ts backend/tests/task-ai-settings-isolation.test.ts backend/tests/user-ai-settings-isolation.test.ts
git commit -m "fix(ai): isolate task and embedding configuration"
```

### 任务 5：全局审计与最终验证

**文件：**
- 检查：`backend/src/**/*.ts`
- 检查：`frontend/src/components/AISettingsPanel.tsx`
- 检查：`frontend/src/components/EmbeddingSettingsPanel.tsx`

- [ ] **步骤 1：审计旧全局读取**

```powershell
rg -n "system_settings.*ai_|ai_.*system_settings|readSystemSetting\(\"ai_|writeSetting\(\"ai_" backend/src
```

预期：业务运行时代码无全局 AI 配置读写；仅数据库迁移中允许出现旧 key 白名单。

- [ ] **步骤 2：运行后端 AI 相关测试**

```powershell
cd backend
node --import tsx --test tests/user-ai-settings-migration.test.ts tests/user-ai-settings-isolation.test.ts tests/user-preferences.test.ts tests/ai-config-toggle.test.ts tests/ai-connection-test.test.ts tests/embedding-user-ai-settings.test.ts tests/task-ai-settings-isolation.test.ts
```

预期：全部 PASS。

- [ ] **步骤 3：运行后端完整验证**

```powershell
npm --prefix backend test
npm --prefix backend run build:tsc
npm --prefix backend run build
```

预期：测试、TypeScript 和 bundle 构建通过；若存在已知基线失败，记录并确认数量没有增加。

- [ ] **步骤 4：运行前端构建**

```powershell
npm --prefix frontend run build
```

预期：现有 API 类型和设置界面构建成功，无需改变接口形状。

- [ ] **步骤 5：最终检查**

```powershell
git diff --check
git status --short
git log --oneline -8
```

预期：仅包含本计划文件和 AI 隔离相关变更；用户原有未跟踪文件保持不变。
