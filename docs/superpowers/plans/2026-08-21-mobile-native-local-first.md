# Mobile Native Local-first 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Android/iOS 的核心 Note、Notebook、Tag、Attachment 读写以 Native SQLite/Filesystem 为权威，并通过 Sync V2 在前台、网络恢复和手动刷新时与 Server 收敛。

**架构：** Native 平台启动时初始化本地数据库和 Repository，再安装核心 API fetch bridge；业务事务与 Mobile Outbox 同时提交。独立 Mobile Sync Engine 复用阶段 K 的多 Scope 协议，附件走二进制通道。

**技术栈：** React、TypeScript、Capacitor 8、`@capacitor-community/sqlite`、Capacitor Filesystem/Network/App、Secure Storage。

---

## 文件结构

- 修改 `frontend/package.json`、`frontend/package-lock.json`、Android/iOS Capacitor 工程：原生依赖。
- 创建 `frontend/src/lib/nativeDatabase.ts`：连接、schema migration、事务与查询适配。
- 创建 `frontend/src/lib/nativeAttachmentStore.ts`：私有目录文件、hash、稳定 URL。
- 创建 `frontend/src/lib/nativeLocalRepository.ts`：LocalRepository 的 Native 实现。
- 创建 `frontend/src/lib/mobileLocalFirstBridge.ts`：核心 API 到 Repository 的 Native 路由。
- 创建 `frontend/src/lib/mobileSyncEngine.ts`：多 Scope Mobile Sync Engine。
- 创建 `frontend/src/lib/mobileLocalFirstRuntime.ts`：账户绑定、Cache 导入、生命周期触发。
- 修改 `frontend/src/main.tsx`：React 挂载前完成 Native Runtime 初始化。

### 任务 1：安装 Capacitor 8 原生依赖

- [ ] **步骤 1：锁定兼容版本**

安装与 Capacitor 8 匹配的 SQLite、Filesystem、Network：

```powershell
cd frontend
npm install @capacitor-community/sqlite@8.1.1 @capacitor/filesystem@^8 @capacitor/network@^8
```

- [ ] **步骤 2：同步 Android/iOS 工程**

```powershell
npx cap sync android
npx cap sync ios
```

该步骤只更新原生工程和锁文件，不构建、不运行测试。

- [ ] **步骤 3：Commit**

```powershell
git add frontend/package.json frontend/package-lock.json frontend/android frontend/ios
git commit -m "build(mobile): 接入 Capacitor 8 原生 SQLite 与文件系统"
```

### 任务 2：Native Database 与迁移

- [ ] **步骤 1：创建连接适配器**

`nativeDatabase.ts` 导出：

```ts
export interface NativeDatabase {
  run(sql: string, values?: unknown[]): Promise<{ changes: number; lastId?: number }>;
  query<T>(sql: string, values?: unknown[]): Promise<T[]>;
  transaction<T>(work: (tx: NativeDatabase) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openNativeDatabase(accountId: string): Promise<NativeDatabase>;
```

数据库名由 accountId 的 SHA-256 短 hash 构成，避免多账号串库。

- [ ] **步骤 2：创建首版 schema**

使用 `PRAGMA user_version=1` 建核心业务表、附件表、Profile/Device/State/Outbox/Conflict/Workspace Scope 表和必要索引。外键开启；Outbox 的 `scopeKey/profileId/deviceId` 必填。

- [ ] **步骤 3：保证事务语义**

`transaction()` 使用 `BEGIN IMMEDIATE/COMMIT/ROLLBACK` 串行执行，异常时回滚；禁止 Repository 在事务中开启第二连接。

- [ ] **步骤 4：Commit**

```powershell
git add frontend/src/lib/nativeDatabase.ts
git commit -m "feat(mobile): 建立原生本地数据库与迁移框架"
```

### 任务 3：Native Repository 与附件

- [ ] **步骤 1：实现附件私有存储**

附件路径固定为 `attachments/<accountHash>/<attachmentId>`。写入临时文件后校验 SHA-256 与 size，再 rename；`resolveUrl()` 使用 `Capacitor.convertFileSrc()`；删除只在元数据已标记删除且无待同步 mutation 时执行。

- [ ] **步骤 2：实现核心 Repository**

`nativeLocalRepository.ts` 完整实现 `LocalRepository`。每个 create/update/delete 在同一事务中更新业务表和 Outbox；Pull apply 通过 suppression 标志禁止回环。

- [ ] **步骤 3：实现查询过滤**

Note list 支持 notebook/tag/keyword/trash/archive/limit/offset；所有查询带当前 `scopeKey`，Workspace 数据与 Personal 不混合。

- [ ] **步骤 4：Commit**

```powershell
git add frontend/src/lib/nativeAttachmentStore.ts frontend/src/lib/nativeLocalRepository.ts frontend/src/lib/localRepository.ts
git commit -m "feat(mobile): 实现原生笔记仓储与附件持久化"
```

### 任务 4：核心 UI API 接入 Native Repository

- [ ] **步骤 1：安装 Native fetch bridge**

仅在 `Capacitor.isNativePlatform()` 时拦截 `/notes`、`/notebooks`、`/tags`、`/attachments` 的核心 CRUD。非核心路由和 Web/Desktop 原样传给既有 fetch。

- [ ] **步骤 2：保持响应契约**

创建与更新返回完整实体；删除返回 `{ success: true }`；列表返回数组；附件下载返回带正确 MIME 的 Response。未初始化、账户未绑定或迁移失败时显式退回既有远端路径并记录诊断状态。

- [ ] **步骤 3：React 挂载前初始化**

`main.tsx` 调用：

```ts
await initializeMobileLocalFirstRuntime();
renderApplication();
```

初始化异常不得白屏；保留旧路径并继续挂载。

- [ ] **步骤 4：Commit**

```powershell
git add frontend/src/lib/mobileLocalFirstBridge.ts frontend/src/lib/mobileLocalFirstRuntime.ts frontend/src/main.tsx
git commit -m "feat(mobile): 将核心 UI 读写切换到原生仓储"
```

### 任务 5：Mobile Sync Engine

- [ ] **步骤 1：实现 Scope 与凭据**

从当前服务器地址、登录账号和 Secure Storage 生成/复用 Profile；安装级 deviceId 永久保存。调用 `/api/sync/v2/scopes` 并按 fingerprint 更新本地 Scope 状态。

- [ ] **步骤 2：实现 Push/Pull/Apply/ACK**

每个 active Scope 串行执行，Push 只取同 Scope Outbox；Pull 先读 Change Feed，再从 Snapshot 获取 upsert payload；Apply 事务抑制 Outbox；成功后单调推进游标并 ACK。

- [ ] **步骤 3：实现 Bootstrap 与权限终态**

游标为 0 或 resetRequired 时分页 Snapshot；本地已有同 ID 异内容则写 Conflict。`ACCESS_REVOKED/SCOPE_FORBIDDEN` 将 Scope 置 `access_revoked`，不删除本地数据、不重试。

- [ ] **步骤 4：实现附件二进制**

pending_upload 先 HEAD 再 PUT；pending_download GET 后校验 size/hash再置 available。单个附件失败只记录状态，不让正文同步整轮失败。

- [ ] **步骤 5：Commit**

```powershell
git add frontend/src/lib/mobileSyncEngine.ts frontend/src/lib/nativeLocalRepository.ts frontend/src/lib/nativeAttachmentStore.ts
git commit -m "feat(mobile): 接通多作用域移动同步引擎"
```

### 任务 6：生命周期、Cache 升级与手工验收交接

- [ ] **步骤 1：幂等导入旧 Cache**

按稳定 ID 分批读取 `localStore` 中 Notebook/Note/Tag/Attachment metadata，upsert Native DB 并落导入游标；完成 count/ID 校验后才设置 `nativeRuntimeReady=1`。不删除 IndexedDB。

- [ ] **步骤 2：注册同步触发器**

使用 `@capacitor/app` 的 `appStateChange`、`@capacitor/network` 的 `networkStatusChange`、本地 mutation 800ms debounce 和手动刷新事件触发 `requestSync()`；确保监听器只注册一次并可释放。

- [ ] **步骤 3：人工测试交接**

不运行自动化、Android/iOS 构建或模拟器测试。向用户列出飞行模式 CRUD、杀进程重开、网络恢复双向同步、附件离线显示、token 失效、Workspace 撤权的手工测试步骤。

- [ ] **步骤 4：Commit**

```powershell
git add frontend/src/lib/mobileLocalFirstRuntime.ts frontend/src/lib/mobileSyncEngine.ts frontend/src/main.tsx
git commit -m "feat(mobile): 完成原生迁移与前台同步生命周期"
```
