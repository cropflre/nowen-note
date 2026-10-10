# Workspace Local-first 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Sync V2 按 `personal` 与 `workspace:<id>` 独立同步，并在服务端重新校验 ACL、在客户端安全处理权限变化和离线撤权。

**架构：** 新增统一 Scope 解析器和 v91 本地状态迁移；服务端所有协议端点按 Scope 过滤并返回权限指纹；Desktop Sync Engine 先刷新 Scope 清单，再逐 Scope 执行 Push/Pull/ACK。权限撤销只冻结对应 Scope，不删除本地数据。

**技术栈：** TypeScript、Hono、better-sqlite3、SQLite migration/trigger、React。

---

## 文件结构

- 创建 `backend/src/sync/scope.ts`：Scope key、Workspace 成员校验、能力与 access fingerprint。
- 创建 `backend/src/db/syncWorkspaceScopeMigration.ts`：v91 表结构、索引、Scope-aware Change Feed/Outbox trigger。
- 修改 `backend/src/db/migrations.ts`：注册 v91。
- 修改 `backend/src/sync/types.ts`、`constants.ts`、`errors.ts`：协议 Scope 契约与稳定错误码。
- 修改 `backend/src/sync/outbox.ts`、`profile.ts`、`conflict.ts`：按 Scope 读写状态。
- 修改 `backend/src/sync/apply.ts`：服务端按 Scope 与有效权限应用 mutation。
- 修改 `backend/src/routes/sync-v2.ts`：`/scopes` 与所有端点 Scope 化。
- 修改 `backend/src/sync/remote.ts`、`engine.ts`：远端客户端和 Desktop 引擎逐 Scope 同步。
- 修改 `backend/src/routes/sync-local.ts`：暴露 Scope 状态、撤权恢复与复制到 Personal。
- 修改 `frontend/src/lib/syncLocalApi.ts`、`frontend/src/components/settings/SyncSettingsTab.tsx`：展示 Scope/撤权状态和恢复操作。

### 任务 1：定义统一 Scope 契约

- [ ] **步骤 1：创建 Scope 类型与 key 解析**

在 `backend/src/sync/scope.ts` 导出：

```ts
export type SyncScopeAccessStatus = "active" | "replan_required" | "access_revoked";

export interface SyncScopeDescriptor {
  scopeKey: string;
  workspaceId: string | null;
  workspaceName: string | null;
  role: string | null;
  canWrite: boolean;
  accessFingerprint: string;
}

export function workspaceScopeKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}
```

`resolveAuthorizedScope(db, userId, scopeKey, { write })` 对 Personal 校验用户身份，对 Workspace 读取 `workspace_members` 和现有 ACL；无成员返回 `ACCESS_REVOKED`，Viewer 写入返回 `SCOPE_FORBIDDEN`。

- [ ] **步骤 2：扩展共享协议类型**

在 `backend/src/sync/types.ts` 给 plan/changes/snapshot/push/ack 响应增加：

```ts
scopeKey: string;
accessFingerprint: string;
```

给 Outbox 与 Conflict 行类型增加必填 `scopeKey`。

- [ ] **步骤 3：Commit**

```powershell
git add backend/src/sync/scope.ts backend/src/sync/types.ts backend/src/sync/constants.ts backend/src/sync/errors.ts
git commit -m "feat(sync): 定义工作区同步作用域与权限契约"
```

### 任务 2：迁移本地 Scope 状态与触发器

- [ ] **步骤 1：实现 migration v91**

重建 `sync_outbox` 与 `sync_conflicts` 时先卸载所有相关 trigger，复制旧数据时写入 `scopeKey='personal'`，再创建：

```sql
CREATE TABLE sync_workspace_scopes (
  profileId TEXT NOT NULL,
  scopeKey TEXT NOT NULL,
  workspaceId TEXT,
  workspaceName TEXT,
  role TEXT,
  canWrite INTEGER NOT NULL DEFAULT 0,
  accessFingerprint TEXT NOT NULL,
  accessStatus TEXT NOT NULL DEFAULT 'active'
    CHECK (accessStatus IN ('active','replan_required','access_revoked')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (profileId, scopeKey)
);
```

同时给 `sync_state` 添加 `accessFingerprint`、`accessStatus`、`accessChangedAt`。

- [ ] **步骤 2：重装 Scope-aware trigger**

所有业务表 trigger 使用：

```sql
CASE WHEN NEW.workspaceId IS NULL
  THEN 'personal'
  ELSE 'workspace:' || NEW.workspaceId
END
```

写入 Change Feed 时保留真实 `workspaceId`；写入 Outbox 时同时写 `scopeKey`。`note_tags` 和附件从所属 note 推导 Scope。WorkspaceId 改变时记录旧 Scope delete 与新 Scope upsert。

- [ ] **步骤 3：注册 v91 并运行只读版本检查**

不执行迁移测试；只读检查 `MIGRATIONS` 中最高版本和重复版本，预期最高 `91`、无重复。

- [ ] **步骤 4：Commit**

```powershell
git add backend/src/db/syncWorkspaceScopeMigration.ts backend/src/db/migrations.ts backend/src/db/syncOutboxCaptureMigration.ts backend/src/db/syncPersonalEntitiesMigration.ts
git commit -m "feat(sync): 持久化工作区作用域与权限状态（migration v91）"
```

### 任务 3：服务端协议按 Scope 授权

- [ ] **步骤 1：新增 `/scopes`**

`GET /api/sync/v2/scopes` 返回 Personal 和当前成员可访问的 Workspace descriptor。指纹使用 SHA-256，对 Workspace id、成员 role/status/updatedAt、Workspace updatedAt、ACL/知识树权限版本排序后计算。

- [ ] **步骤 2：Scope 化 plan/changes/snapshot**

每个请求解析 `scopeKey`；查询条件严格映射为：

```sql
workspaceId IS NULL
```

或：

```sql
workspaceId = ?
```

Snapshot 必须覆盖 `notebook/tag/note/note_tag/favorite/attachment/task/task_reminder/diary/mindmap`，每个 payload 包含真实 `workspaceId`。

- [ ] **步骤 3：Scope 化 push/ack**

`applyMutation` 接收 `scopeKey`、`workspaceId`、`canWrite`。payload Scope 不一致直接 `SCOPE_FORBIDDEN`；每类实体复用现有权限函数或资源创建者/admin-owner规则。ACK 的键保持 `(deviceId,userId,scopeKey)`。

- [ ] **步骤 4：Realtime 通知携带 Scope**

只发送 `scopeKey`、sequence、access fingerprint 变化提示，不发送业务正文。

- [ ] **步骤 5：Commit**

```powershell
git add backend/src/routes/sync-v2.ts backend/src/sync/apply.ts backend/src/sync/notify.ts backend/src/sync/entities.ts
git commit -m "feat(sync): 接通服务端工作区同步与逐请求授权"
```

### 任务 4：Desktop 引擎逐 Scope 同步

- [ ] **步骤 1：扩展 Remote Client**

所有方法显式接收 `scopeKey`：

```ts
listScopes(): Promise<SyncScopeDescriptor[]>;
plan(scopeKey: string, after: number): Promise<SyncPlanResponse>;
push(scopeKey: string, deviceId: string, mutations: SyncMutation[]): Promise<SyncPushResponse>;
changes(scopeKey: string, after: number): Promise<SyncChangesResponse>;
snapshot(scopeKey: string, cursor: string | null, sequence: number): Promise<SyncSnapshotResponse>;
ack(scopeKey: string, deviceId: string, sequence: number): Promise<SyncAckResponse>;
```

- [ ] **步骤 2：刷新本地 Scope 清单**

每轮开始 upsert 远端 descriptor。指纹改变置 `replan_required` 并复位该 Scope 游标；本地已有但远端清单缺失的 Workspace 置 `access_revoked`，保留业务数据与 Outbox。

- [ ] **步骤 3：逐 Scope 执行 Push/Pull**

Personal 始终执行；Workspace 只执行 `active/replan_required`。`listPendingMutations` 按 `(profileId,scopeKey)` 过滤。`ACCESS_REVOKED/SCOPE_FORBIDDEN` 只冻结对应 Scope，不让其他 Scope 停止同步。

- [ ] **步骤 4：冲突与附件带 Scope**

Conflict 写入 scopeKey；附件二进制请求携带 Scope，服务端再次校验附件所属 note 的权限。

- [ ] **步骤 5：Commit**

```powershell
git add backend/src/sync/remote.ts backend/src/sync/engine.ts backend/src/sync/outbox.ts backend/src/sync/profile.ts backend/src/sync/conflict.ts backend/src/sync/blob.ts backend/src/routes/sync-v2-blob.ts
git commit -m "feat(sync): 让桌面同步引擎按作用域独立对账"
```

### 任务 5：撤权恢复与诊断 UI

- [ ] **步骤 1：本地 API 暴露 Scope 状态**

诊断响应增加 Scope 列表、pending/conflict 数、access status。新增将撤权 Workspace 数据复制到 Personal 的事务入口：为 Notebook/Note/Tag/Attachment 分配新稳定 ID，重写引用，生成 Personal Outbox；原 Workspace 数据不删除。

- [ ] **步骤 2：设置页显示状态**

`SyncSettingsTab` 对 `access_revoked` 显示“权限已撤销，本地副本仍保留”，提供导出和复制到个人空间入口；不显示自动清理按钮。

- [ ] **步骤 3：人工测试交接**

不运行自动化或 UI 测试。向用户列出 Owner/Admin/Editor/Viewer、离线撤权、Workspace→Personal copy、附件 ACL、多设备收敛的手工验证入口。

- [ ] **步骤 4：Commit**

```powershell
git add backend/src/routes/sync-local.ts frontend/src/lib/syncLocalApi.ts frontend/src/components/settings/SyncSettingsTab.tsx
git commit -m "feat(sync): 提供工作区撤权恢复与作用域诊断"
```
