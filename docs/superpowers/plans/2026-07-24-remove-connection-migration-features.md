# 移除连接与迁移功能实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完整移除“连接与账号”和“一次性数据迁移”，保留普通登录、当前服务器地址、备份导入导出及数据库升级能力。

**架构：** 前端删除连接中心及其 profile/迁移依赖，账号弹层退回为当前服务器信息与普通账号操作。Electron 保留单账号登录凭据并在读取旧文件时清除 profiles，Android 用一个窄兼容清理器删除旧 profile 安全存储。后端取消一次性迁移路由注册并删除独占实现。

**技术栈：** React、TypeScript、Vitest、Electron IPC、Capacitor SecureStorage、Hono、Node test runner

---

## 文件结构

- 创建 `frontend/src/lib/removedServerProfileCleanup.ts`：仅负责清理遗留多服务器本地键和 Android 安全存储项。
- 创建 `frontend/src/lib/__tests__/removedServerProfileCleanup.test.ts`：验证专用键清理且普通登录键不受影响。
- 创建 `frontend/src/components/__tests__/removedConnectionFeatures.test.ts`：防止被删除入口、全局挂载和登录 profile 依赖回归。
- 修改 `frontend/src/components/NavRail.tsx`、`frontend/src/components/LoginPage.tsx`、`frontend/src/main.tsx`：解除功能入口和运行时依赖。
- 删除连接中心、多服务器资料、专用凭据、迁移客户端及其专用测试文件。
- 修改 `electron/credentials.js`、`electron/preload.js`：删除 profile API 并清理旧凭据文件中的 profiles。
- 创建 `electron/__tests__/credentialsProfileRemoval.test.js`：覆盖普通 remember 凭据保留和 profile API 消失。
- 修改 `backend/src/index.ts`、`backend/src/lib/cors-policy.ts`：取消迁移路由注册。
- 删除 `backend/src/routes/user-migration*.ts` 与 `backend/tests/user-migration-v2.test.ts`。
- 创建 `backend/tests/user-migration-removed.test.ts`：验证一次性迁移路径返回 404。

### 任务 1：锁定前端删除行为

**文件：**
- 创建：`frontend/src/components/__tests__/removedConnectionFeatures.test.ts`
- 修改：`frontend/src/components/NavRail.tsx`
- 修改：`frontend/src/components/LoginPage.tsx`
- 修改：`frontend/src/main.tsx`
- 删除：`frontend/src/components/ServerConnectionCenter.tsx`
- 删除：`frontend/src/lib/serverProfiles.ts`
- 删除：`frontend/src/lib/profileCredentialVault.ts`
- 删除：`frontend/src/lib/serverMigrationV2.ts`
- 删除：上述模块的四个专用测试文件

- [ ] **步骤 1：编写失败的源码边界测试**

```ts
it("不再暴露连接与迁移入口或全局连接中心", () => {
  expect(navRailSource).not.toContain("连接与账号");
  expect(navRailSource).not.toContain("迁移数据");
  expect(navRailSource).not.toContain("连接 NAS / 云端");
  expect(mainSource).not.toContain("ServerConnectionCenter");
  expect(loginSource).not.toContain("PendingProfileReauthentication");
});
```

- [ ] **步骤 2：运行测试并确认因旧入口仍存在而失败**

运行：`npm run test:run -- src/components/__tests__/removedConnectionFeatures.test.ts`

预期：FAIL，断言命中旧入口或旧依赖。

- [ ] **步骤 3：删除 UI、挂载和 profile 依赖**

保留 `getServerUrl()` 驱动的当前服务器展示和远程模式下的“切回本地离线模式”；删除所有打开连接中心的事件分发和无用 import/state/effect。

- [ ] **步骤 4：运行前端边界测试**

运行：`npm run test:run -- src/components/__tests__/removedConnectionFeatures.test.ts src/components/__tests__/LoginPageIcp.test.tsx src/components/__tests__/LoginPageSiteSettingsProviderIcp.test.tsx`

预期：全部 PASS。

- [ ] **步骤 5：提交前端删除变更**

```powershell
git add -- frontend/src
git commit -m "feat: 移除连接与迁移前端功能"
```

### 任务 2：清理遗留客户端 profile 数据

**文件：**
- 创建：`frontend/src/lib/removedServerProfileCleanup.ts`
- 创建：`frontend/src/lib/__tests__/removedServerProfileCleanup.test.ts`
- 修改：`frontend/src/main.tsx`

- [ ] **步骤 1：先写专用键清理测试**

```ts
it("只删除多服务器专用键", async () => {
  localStorage.setItem("nowen-server-profiles-v2", "[]");
  localStorage.setItem("nowen-server-url", "http://127.0.0.1:3001");
  await cleanupRemovedServerProfiles();
  expect(localStorage.getItem("nowen-server-profiles-v2")).toBeNull();
  expect(localStorage.getItem("nowen-server-url")).toBe("http://127.0.0.1:3001");
});
```

- [ ] **步骤 2：运行测试并确认模块缺失失败**

运行：`npm run test:run -- src/lib/__tests__/removedServerProfileCleanup.test.ts`

预期：FAIL，无法导入 `cleanupRemovedServerProfiles`。

- [ ] **步骤 3：实现最小清理器并在启动时调用**

清理已知 local/session storage 键；仅在 Capacitor 原生环境加载 SecureStorage，逐个删除索引中的 `serverAccount.<id>.v1`，全部成功后删除索引，失败时保留索引供下次启动重试。

- [ ] **步骤 4：运行清理测试**

运行：`npm run test:run -- src/lib/__tests__/removedServerProfileCleanup.test.ts`

预期：全部 PASS。

- [ ] **步骤 5：提交清理器**

```powershell
git add -- frontend/src/lib/removedServerProfileCleanup.ts frontend/src/lib/__tests__/removedServerProfileCleanup.test.ts frontend/src/main.tsx
git commit -m "fix: 清理遗留服务器资料数据"
```

### 任务 3：收口 Electron profile 凭据接口

**文件：**
- 修改：`electron/credentials.js`
- 修改：`electron/preload.js`
- 创建：`electron/__tests__/credentialsProfileRemoval.test.js`

- [ ] **步骤 1：编写旧文件升级测试和接口删除测试**

```js
test("读取旧凭据时删除 profiles 并保留普通登录记录", () => {
  const upgraded = credentials.__test.normalizeStore({ version: 2, remember: { username: "alice" }, profiles: { old: {} } });
  assert.deepEqual(upgraded.remember, { username: "alice" });
  assert.equal(Object.hasOwn(upgraded, "profiles"), false);
});
```

同时读取 preload 源码并断言不再包含 `credentials:profile-load`、`credentials:profile-save`、`credentials:profile-remove`、`credentials:profile-list`。

- [ ] **步骤 2：运行测试并确认旧 profiles/API 导致失败**

运行：`node --test electron/__tests__/credentialsProfileRemoval.test.js`

预期：FAIL，旧存储仍包含 profiles 或 preload 仍暴露 profile IPC。

- [ ] **步骤 3：删除 profile 方法和 IPC，收窄凭据文件结构**

保留 `load/save/clear/is-encryption-available`；读到旧 profiles 时写回不含 profiles 的结构，普通 `remember` 数据保持原样。

- [ ] **步骤 4：运行 Electron 凭据测试**

运行：`node --test electron/__tests__/credentialsProfileRemoval.test.js electron/__tests__/security.test.js`

预期：全部 PASS。

- [ ] **步骤 5：提交 Electron 变更**

```powershell
git add -- electron/credentials.js electron/preload.js electron/__tests__/credentialsProfileRemoval.test.js
git commit -m "feat: 移除桌面端服务器资料凭据"
```

### 任务 4：移除后端一次性迁移 API

**文件：**
- 创建：`backend/tests/user-migration-removed.test.ts`
- 修改：`backend/src/index.ts`
- 修改：`backend/src/lib/cors-policy.ts`
- 删除：`backend/src/routes/user-migration.ts`
- 删除：`backend/src/routes/user-migration-v2.ts`
- 删除：`backend/src/routes/user-migration-v2-register.ts`
- 删除：`backend/tests/user-migration-v2.test.ts`

- [ ] **步骤 1：编写路由未注册测试**

```ts
test("一次性数据迁移 API 已移除", async () => {
  const response = await app.request("/api/user-migration/v2/preflight");
  assert.equal(response.status, 404);
});
```

- [ ] **步骤 2：运行测试并确认旧路由返回非 404**

运行：`node --import tsx --import ./tests/setup-db-isolation.ts --test tests/user-migration-removed.test.ts`

预期：FAIL，旧迁移路由仍被注册。

- [ ] **步骤 3：取消注册并删除独占实现**

从标准入口和 CORS 副作用注册中移除迁移模块，删除 V1/V2 路由及旧测试，不改通用仓储层。

- [ ] **步骤 4：运行后端定向测试**

运行：`node --import tsx --import ./tests/setup-db-isolation.ts --test tests/user-migration-removed.test.ts tests/cors-policy.test.ts`

预期：全部 PASS。

- [ ] **步骤 5：提交后端变更**

```powershell
git add -- backend/src/index.ts backend/src/lib/cors-policy.ts backend/src/routes backend/tests
git commit -m "feat: 移除一次性数据迁移接口"
```

### 任务 5：全链路验证

**文件：**
- 检查：所有本次修改文件

- [ ] **步骤 1：运行静态残留扫描**

运行：`rg -n "ServerConnectionCenter|serverProfiles|profileCredentialVault|serverMigrationV2|user-migration|连接与账号|迁移数据|连接 NAS / 云端" frontend/src electron backend/src backend/tests`

预期：无业务残留；若兼容清理测试包含历史键名，只允许出现在清理器及其测试中。

- [ ] **步骤 2：运行前端定向测试与生产构建**

运行：`npm run test:run -- src/components/__tests__/removedConnectionFeatures.test.ts src/lib/__tests__/removedServerProfileCleanup.test.ts src/components/__tests__/LoginPageIcp.test.tsx src/components/__tests__/LoginPageSiteSettingsProviderIcp.test.tsx`

运行：`npm run build`

预期：测试和构建退出码均为 0。

- [ ] **步骤 3：运行 Electron 和后端定向测试**

运行：`node --test electron/__tests__/credentialsProfileRemoval.test.js electron/__tests__/security.test.js`

运行：`node --import tsx --import ./tests/setup-db-isolation.ts --test tests/user-migration-removed.test.ts tests/cors-policy.test.ts`

预期：全部退出码为 0。

- [ ] **步骤 4：检查差异和工作区边界**

运行：`git diff --check`、`git status --short`、`git diff --stat HEAD~4`

预期：无空白错误；`.superpowers/` 保持未跟踪且不进入提交。
