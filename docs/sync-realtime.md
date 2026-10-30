# 实时同步机制

本文档描述 Nowen Note 的 WebSocket 实时同步架构，涵盖连接管理、事件分发、删除/回收站同步流程、前端行为以及离线兜底策略。

### Sync V2 / Android Native（release/v1.5.2 开发中）

Android 登录态复用现有 `/ws`：`sync.changed`、连接恢复和前台恢复唤醒同一个 `MobileSyncEngine`，30 秒前台补偿 Pull 处理丢失通知。通知不携带正文，也不替代 Change Feed；Native SQLite Apply 提交后才广播 `nowen:mobile-sync-applied`，刷新列表、知识树和打开正文。Android 不再由 `OfflineSyncRuntime` 启动另一套 Web 离线队列。系统冻结/强杀时不承诺持续后台实时同步。

Desktop uses the embedded backend Sync V2 engine; Android uses its native SQLite engine. Web/mobile browsers still use REST plus IndexedDB/offline queue and are not a unified transactional Local-first implementation. iOS/HarmonyOS equivalence has not been accepted. A note ACK confirms the server revision, not receipt by every device or completion of every attachment transfer.

平台与实体矩阵、根因和执行证据见 [审计](sync-v2-reliability-audit.md) 与 [验收记录](sync-v2-reliability-validation.md)。当前改动仍需通过剩余验收，不能据此宣称生产治理完成。

---

## 1. WebSocket 连接模型

客户端与服务端通过单一 WebSocket 长连接进行双向通信，挂载路径为 `/ws`。

### 1.1 连接建立

- 客户端在 URL 中携带 JWT token：`/ws?token=<JWT>`
- 服务端校验 token 有效性、用户是否存在、是否被禁用、tokenVersion 是否匹配
- 校验通过后，服务端分配一个全局唯一的 `connectionId`，并在首帧 `connected` 消息中返回给客户端
- 同一用户在多个标签页/设备上会持有不同的 `connectionId`

### 1.2 心跳与超时

- 客户端每 25 秒发送一次 `ping` 消息
- 服务端每 30 秒巡检一次，若某连接 60 秒未收到心跳则判定为断线，主动清理其房间订阅和 Presence 状态
- 心跳采用应用层 JSON 消息，不依赖 WebSocket 协议层的 ping/pong 帧

### 1.3 自动重连

- 连接断开后，客户端以指数退避策略自动重连（1 秒起步，最大 30 秒）
- 重连成功后自动恢复所有房间订阅，并重放最近一次 Presence 状态
- 用户主动调用 `disconnect()` 时不触发重连

---

## 2. 房间订阅机制

服务端维护一个内存态的房间模型，每个房间对应一个 `Set<connectionId>`。

### 2.1 note:{noteId} 房间

- 当用户打开某篇笔记时，客户端发送 `subscribe` 消息加入 `note:<noteId>` 房间
- 服务端校验用户对该笔记至少具有 read 权限，通过后将其加入房间
- 加入房间后，服务端立即向房间内所有成员广播 Presence 快照
- 离开笔记时发送 `unsubscribe`，服务端将其移除并重新广播 Presence

### 2.2 workspace:{workspaceId} 房间

- 工作区级事件（成员变动、笔记增删）通过 `workspace:<id>` 房间广播
- 用户必须是该工作区的成员才能订阅

### 2.3 权限校验

- `note:` 房间：基于笔记级 ACL，read 及以上权限可加入
- `workspace:` 房间：基于工作区成员关系校验

---

## 3. 用户级广播 broadcastToUser

`broadcastToUser` 是一种不依赖房间订阅的广播机制，向指定用户的所有 WebSocket 连接推送消息。

**应用场景：**

- 笔记保存后，向发起用户的所有连接广播 `note:list-updated`，使停留在列表页或其它笔记的标签页也能实时刷新列表项
- 导入笔记完成后通知前端刷新
- 删除/回收站操作后，确保用户在任何页面都能收到 `note:deleted` 事件

**工作原理：**

服务端遍历全局 `clients` Map，筛选 `userId` 匹配的所有连接并逐一发送。与房间广播互补——房间广播覆盖"正在打开该笔记"的客户端，`broadcastToUser` 覆盖"用户在其它页面"的客户端。

---

## 4. note:deleted 事件处理

当笔记被移入回收站或永久删除时，服务端通过以下两条路径广播 `note:deleted` 事件：

1. **房间广播**：向 `note:<noteId>` 房间内所有订阅者广播（排除触发者自身的连接）
2. **用户广播**：通过 `broadcastToUser` 向触发用户的所有连接广播

### 4.1 事件载荷

```json
{
  "type": "note:deleted",
  "noteId": "笔记ID",
  "actorUserId": "触发者用户ID",
  "actorConnectionId": "触发者连接ID",
  "trashed": true
}
```

- `trashed: true` 表示移入回收站（可恢复）
- `trashed: false` 表示永久删除（不可恢复）

---

## 5. 删除与回收站同步流程

### 5.1 移入回收站

**后端流程：**

1. 前端发送 `PUT /api/notes/:id`，请求体中 `isTrashed: 1`
2. 后端更新笔记的 `isTrashed` 和 `trashedAt` 字段
3. 后端调用 `broadcastNoteDeleted(noteId, { trashed: true }, actorConnectionId)` 广播事件
4. 同时通过 `broadcastToUser` 向用户所有连接广播，确保列表页也能收到

**前端响应：**

1. NoteList 监听全局 `note:deleted` 事件
2. 收到事件后立即调用 `removeNoteFromList(noteId)` 从列表移除
3. 同步更新 IndexedDB 中该笔记的 `isTrashed` 字段，防止重启后旧缓存将笔记"复活"
4. 异步触发 `syncNow()` 兜底，确保本地状态与服务端一致

### 5.2 永久删除

**后端流程：**

1. 前端发送 `DELETE /api/notes/:id`
2. 后端校验用户对该笔记具有 manage 权限（editor 只能放入回收站，不能永久删除）
3. 校验笔记未被锁定
4. 清理磁盘附件物理文件
5. 执行 `DELETE FROM notes`，SQLite CASCADE 自动清理关联的 attachments、tag_note、yupdates、ysnapshots 记录
6. 释放内存中的 Y.Doc
7. 执行 WAL checkpoint + incremental vacuum 回收磁盘空间
8. 调用 `broadcastNoteDeleted(noteId, { trashed: false })` 广播永久删除事件

**前端响应：**

1. NoteList 收到 `note:deleted` 事件后从列表移除
2. 直接从 IndexedDB 中删除该笔记的本地缓存
3. 异步触发 `syncNow()` 兜底

### 5.3 清空回收站

**后端流程：**

1. 前端发送 `DELETE /api/notes/trash/empty`
2. 后端查询当前用户个人空间中所有未锁定的已回收笔记
3. 批量清理磁盘附件文件
4. 在事务中批量删除笔记记录
5. 逐条释放内存 Y.Doc
6. 执行 WAL checkpoint + incremental vacuum（释放量超过 50MB 时触发全量 VACUUM）
7. 对每条被删除的笔记调用 `broadcastNoteDeleted(noteId, { trashed: false })`

**前端响应：**

与单条永久删除相同——逐条从列表移除、清理 IndexedDB、触发 `syncNow()` 兜底。

---

## 6. 前端行为

### 6.1 NoteList removeNoteFromList

`removeNoteFromList` 是 AppContext 中的 action，负责从内存中的笔记列表数组移除指定 ID 的笔记。

**调用时机：**

- 收到 `note:deleted` WebSocket 事件时
- 用户手动执行删除/移入回收站操作后
- 批量移动到其它笔记本后（如果当前筛选不再包含该笔记）

**关联操作：**

- 如果被删除的笔记是当前打开的 `activeNote`，同时调用 `setActiveNote(null)` 清空编辑区
- 在回收站视图下，如果当前打开的笔记被恢复（`isTrashed` 变为 0），也会清空 `activeNote`

### 6.2 syncNow 兜底同步

`syncNow` 是 syncEngine 提供的手动同步函数，在以下场景中作为兜底机制被调用：

- 收到 `note:deleted` 事件后的异步调用，确保 IndexedDB 与服务端最终一致
- 网络恢复（从离线变为在线）时由 `useNetworkStatus` 自动触发
- 页面从后台切回前台（`visibilitychange`）时触发
- 每 30 秒定期探活成功且离线队列有待同步项时触发

**执行流程：**

1. 若离线队列中有待同步操作，先执行 `flushQueue` 将本地积攒的写操作回放到服务端
2. 执行 `pullServerSnapshot`，从服务端拉取最新的笔记本列表、笔记列表、标签列表
3. 与 IndexedDB 做 diff：本地存在但服务端不存在的笔记，若不在离线队列中则从本地删除
4. 更新 `lastSyncAt` 时间戳

### 6.3 当前打开笔记被删除后清空 activeNote

当用户正在编辑某篇笔记，而该笔记在另一个设备/标签页被删除时：

1. `note:deleted` 事件通过 WebSocket 到达
2. NoteList 的事件监听器调用 `removeNoteFromList(noteId)`
3. 判断 `state.activeNote?.id === noteId`，若匹配则调用 `setActiveNote(null)`
4. 编辑区清空，用户回到空白状态
5. 若笔记是被移入回收站（`trashed: true`），IndexedDB 中的缓存会更新 `isTrashed` 标记而非删除，以便用户在回收站中仍可查看

---

## 7. actorConnectionId 排除自己回声

### 7.1 问题背景

同一用户可能在多个标签页/设备上同时使用。当用户在标签页 A 保存笔记时，服务端会广播 `note:updated` 或 `note:deleted`。如果不做排除，标签页 A 会收到自己触发的事件，导致编辑器内容被覆盖、列表闪烁等问题。

### 7.2 解决方案

**双层排除机制：**

1. **服务端排除**：前端在所有 REST 请求中通过 `X-Connection-Id` 请求头携带当前 WebSocket `connectionId`。后端在广播时传入 `actorConnectionId`，`broadcastRoom` 函数会跳过该连接
2. **客户端兜底**：前端在处理 `note:updated`、`note:deleted` 等事件时，比较消息中的 `actorConnectionId` 与本地 `realtime.getConnectionId()`，相同则忽略

**为何不按 userId 过滤：**

同一用户在手机和 PC 上应该互相看到更新。如果按 `userId` 过滤，手机编辑后 PC 就收不到通知。因此排除粒度精确到连接级别（`connectionId`），而非用户级别。

---

## 8. 离线后上线的同步兜底

### 8.1 离线检测

`useNetworkStatus` Hook 提供三层离线检测：

1. `navigator.onLine` + `online`/`offline` 事件（即时感知）
2. 每 30 秒对后端 `/health` 端点发 HEAD 请求探活（防止 Wi-Fi 连接但网关不通的误报）
3. 页面从后台切回前台时立即探活一次

### 8.2 离线期间的写操作

离线时前端发起的 POST/PUT/DELETE 请求会进入 `offlineQueue`（离线队列），每个操作记录目标笔记 ID 和请求详情，持久化到 IndexedDB 中。

### 8.3 上线恢复流程

1. `useNetworkStatus` 检测到网络恢复，触发 `doFlush`
2. `doFlush` 调用 `syncNow()`
3. `syncNow` 先执行 `flushQueue`，将离线队列中的操作按序回放到服务端
4. 回放完成后执行 `pullServerSnapshot`，拉取服务端最新状态
5. 与 IndexedDB 做 diff，删除本地已不存在于服务端且不在离线队列中的笔记
6. UI 显示"已恢复连接"提示（持续 5 秒后自动消失）

### 8.4 WebSocket 重连

网络恢复后，WebSocket 客户端自动重连：

1. 指数退避重连（1s → 2s → 4s → ... → 30s 上限）
2. 连接成功后自动恢复所有房间订阅
3. 重放最近一次 Presence 状态（当前查看的笔记 + 编辑态）

---

## 9. IndexedDB 本地缓存

### 9.1 存储结构

本地缓存基于 IndexedDB，使用 `idb` 库封装，数据库名称包含用户 ID 以实现多账号隔离。核心存储对象：

| Object Store | 说明 |
|---|---|
| `notes` | 笔记完整内容（含正文、标题、标签、回收站状态等） |
| `notebooks` | 笔记本树结构 |
| `tags` | 标签列表 |
| `meta` | 同步元数据（如 `lastSyncAt` 时间戳） |

### 9.2 缓存策略

- **登录后 bootstrap**：拉取服务端全量笔记本、笔记列表、标签写入 IndexedDB
- **打开笔记时**：通过 `cacheNoteContent` 将完整笔记正文写入本地，供离线访问
- **列表拉取时**：`putNoteListItems` 写入列表项，正文字段用空串占位，节省存储空间
- **登出时**：不删除本地缓存，仅解绑当前用户。下次重登可秒开

### 9.3 数据一致性保障

- `syncNow` 的 `pullServerSnapshot` 会与本地做 diff，删除服务端已不存在的笔记（但跳过离线队列中涉及的笔记，避免误删待同步的新建笔记）
- 收到 `note:deleted` 事件时同步更新 IndexedDB 中的 `isTrashed` 标记或直接删除记录
- 收到 `note:updated` 事件时更新 IndexedDB 中对应笔记的 `title`、`contentText`、`updatedAt`、`version` 字段
