# 阶段 K / I：Workspace 与 Mobile Native Local-first 设计

## 1. 背景与边界

本设计延续 `release/v1.5.0` 已落地的 Desktop Local-first、Sync V2、附件二进制、个人模块、Realtime、Conflict、Backup 与凭据隔离。当前只完成两个明确缺口：

- 阶段 K：Workspace / Team Local-first；
- 阶段 I：Android / iOS Native Local-first。

既有 Legacy 兼容路径继续保留；不删除旧 Offline Sync、IndexedDB Cache 或远端 API。前端 Lite 迁移向导和三方合并编辑器不在本次范围内。人工测试由用户执行，本次实现不代跑测试或构建。

## 2. 方案选择

### 2.1 Workspace

采用“单个 Sync Profile、多个独立 Scope”的方案：

- 个人空间：`personal`；
- 工作区：`workspace:<workspaceId>`。

没有为每个工作区创建独立 Profile，因为服务器地址、远端账号和设备身份相同；也不把所有工作区塞进一个共享游标，因为权限撤销、增量序列和重置必须互相隔离。

Server 永远是 Workspace Permission Authority。客户端提交的 `workspaceId` 只用于定位目标，服务端在 `plan`、`snapshot`、`changes`、`push`、`ack` 每个入口重新解析成员关系和有效权限，不能信任客户端缓存。

### 2.2 Mobile

采用 Capacitor 原生存储方案：

- `@capacitor-community/sqlite` 保存业务表和 `sync_*` 状态；
- Capacitor Filesystem 保存附件二进制；
- 现有 Secure Storage 保存移动端同步凭据；
- TypeScript Mobile Sync Engine 复用 Sync V2 HTTP 协议，不在移动端嵌入 Node Backend。

不继续把 `NowenCacheSchema` IndexedDB 当权威库。IndexedDB 只作为升级迁移来源和兼容回退，迁移成功后所有核心 Note / Notebook / Tag / Attachment CRUD 走 Native Repository。

## 3. Workspace Scope 数据模型

### 3.1 本地状态

新增迁移 v91：

- `sync_outbox.scopeKey TEXT NOT NULL DEFAULT 'personal'`；
- `sync_conflicts.scopeKey TEXT NOT NULL DEFAULT 'personal'`；
- `sync_state` 增加 `accessFingerprint`、`accessStatus`、`accessChangedAt`；
- 新增 `sync_workspace_scopes`，保存 Workspace 元数据、当前角色、能力摘要和最近一次权限指纹。

`accessStatus` 只允许 `active`、`replan_required`、`access_revoked`。权限撤销不删除业务数据、Outbox、Conflict 或附件，只停止该 Scope 的 Push/Pull，并暴露只读查看、导出和复制到 Personal 的恢复入口。

### 3.2 服务端 Scope 清单

新增 `GET /api/sync/v2/scopes`，返回当前用户可访问的 `personal` 与 Workspace Scope：

- `scopeKey`；
- `workspaceId`；
- Workspace 名称；
- 当前角色；
- `accessFingerprint`；
- 可执行能力摘要。

指纹由 Workspace 身份、成员角色、Workspace 版本、有效 ACL/知识树权限版本共同确定。成员、角色或 ACL 改变时指纹必变。客户端发现指纹变化后将该 Scope 标记 `replan_required`，重新执行 plan/snapshot/reconcile；Scope 从清单消失时标记 `access_revoked`。

### 3.3 协议

所有 Sync V2 端点接受 `scopeKey`，并返回同一 `scopeKey` 与当前 `accessFingerprint`。服务端按 Scope 过滤：

- `personal`：`workspaceId IS NULL` 且资源属于当前用户；
- `workspace:<id>`：`workspaceId = <id>` 且当前用户仍有访问权。

服务端拒绝：

- Scope 与 payload 中 `workspaceId` 不一致；
- 非成员访问；
- Viewer 写入；
- 已撤销成员的离线 Push；
- 无权修改的 Notebook、Note、Attachment 或个人模块实体。

拒绝权限使用稳定错误码 `ACCESS_REVOKED` 或 `SCOPE_FORBIDDEN`。客户端不得无限重试这些错误。

### 3.4 Outbox 与实体移动

每条 mutation 在创建时固定 `scopeKey`，Push 只能发送当前 Scope 的条目。业务触发器根据行的 `workspaceId` 写入 Scope。

实体从 Personal 移入 Workspace 或在不同 Scope 间移动时，更新触发器产生两条 mutation：旧 Scope `delete`，新 Scope `upsert`。两条都保留独立幂等 ID；若新 Scope 无权限，旧 Scope 数据不得先被静默丢弃，服务端按批次结果逐条确认。

### 3.5 Workspace 权限变化

Realtime 只通知“某 Scope 的 sequence 或 access fingerprint 变化”。HTTP Change Feed 仍是事实来源。权限撤销后：

- Server 拒绝未授权 Push；
- Client 将 Scope 置为 `access_revoked` 并停止重试；
- 本地内容继续只读可见；
- 用户可导出或复制到 Personal；
- 不自动 purge，直到产品另有明确策略。

## 4. Mobile Native 数据层

### 4.1 数据库与迁移

移动数据库名固定为 `nowen_local`，使用 `PRAGMA user_version` 管理迁移。首版 Native Schema 包含：

- `notebooks`、`notes`、`tags`、`note_tags`、`favorites`；
- `attachments` 与本地附件状态；
- `sync_profiles`、安装级设备身份、`sync_state`、`sync_outbox`、`sync_conflicts`、`sync_workspace_scopes`；
- 必要索引、外键和事务边界。

Repository 的业务写入与 Outbox 写入在同一 SQLite 事务内完成。仅此设备模式不写 Outbox；首次开启同步由 Bootstrap 按最终状态建立基线。

### 4.2 Repository 与 UI 接线

新增 Native `LocalRepository` 实现并在 Capacitor 启动阶段注册。核心 API 门面在 Native 平台改为 Repository 优先：

- Notebook：列表、详情、创建、更新、删除；
- Note：列表、详情、创建、更新、回收站删除；
- Tag：列表、创建、更新、删除、绑定、解绑；
- Attachment：保存、列出、解析本地 URL、删除。

调用方继续使用稳定 UUID；本地事务返回即表示“已保存”，不等待网络 ACK。Web 与 Desktop 的现有路径不变。

### 4.3 附件

附件元数据在 SQLite，二进制保存在 App 私有目录。写入顺序固定为：

1. 先写临时文件；
2. 校验大小与 hash；
3. 原子移动到稳定 attachmentId 路径；
4. 同一事务写元数据与 Outbox。

远端附件先落 metadata，再按需或后台下载 binary；下载完成且校验通过后才置 `available=true`。同步失败不能删除本地附件。

### 4.4 Mobile Sync Engine

Mobile Sync Engine 保持单实例，按 Scope 执行：

`刷新 Scope 清单 → Bootstrap/Reconcile → Push → Pull → Apply → ACK → 附件上传/下载`

触发来源：

- App 首次进入前台；
- 本地 mutation debounce；
- 网络恢复；
- App resume；
- 用户手动刷新。

不依赖无限后台运行保证一致性。平台允许时可继续利用系统后台任务，但正确性只依赖下次前台、网络恢复或手动同步。

### 4.5 升级迁移

首次 Native 启动执行可恢复、幂等的 Cache → SQLite 导入：

- 按稳定 ID upsert；
- 每批持久化进度；
- 只在完整性校验通过后切换 Native Runtime；
- 失败继续使用旧路径；
- 不清空 IndexedDB，保留回退能力。

## 5. 错误处理与安全

- Token 失效只暂停同步并进入 `auth_required`，本地 CRUD 不受影响；
- `ACCESS_REVOKED` 为 Scope 终止状态，不进入通用网络重试；
- 网络错误保持 Outbox，按退避策略重试；
- mutationId 保证重复 Push 幂等；
- Pull apply 使用 suppression 防止回写 Outbox；
- 任何 Conflict 都保留 Local / Base / Remote 三方内容；
- Workspace 数据的服务端绝对路径、管理员 JWT、Desktop 本地凭据不得进入移动数据库或协议响应。

## 6. 完成标准

阶段 K 完成时：Desktop 能按 Personal 与多个 Workspace Scope 独立同步；服务端每个端点重新校验权限；权限变化触发 re-plan；离线撤权不会丢本地修改；个人与工作区移动不会串 Scope。

阶段 I 完成时：Android/iOS 核心 Note / Notebook / Tag / Attachment 在飞行模式下可创建、编辑、关联、删除，杀进程重开仍存在；恢复网络后通过 Sync V2 与 Desktop 双向收敛；附件离线重启可显示；所有核心读写不再以远端成功为前提。

## 7. 已批准说明

本规格是用户在 WorkBuddy 页面中已明确批准并要求“阶段 I 和 K 完全完成”的方案落盘版本；当前“继续执行未完成的任务”表示继续该既定设计，不重新扩大范围。
