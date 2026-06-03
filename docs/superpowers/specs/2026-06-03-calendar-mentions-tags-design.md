# 说说日历视图 + 内联创建标签 + @用户通知系统

## 概述

三个独立特性，按复杂度递增排列。各自后端 API 独立、前端组件独立，但 `@用户通知` 需要与 `说说`/`笔记`/`待办` 模块做编辑器和路由集成。

---

## Feature 1: 说说日历视图

### 后端变更

**新增端点**: `GET /api/diary/calendar?year=2026&month=6`

```typescript
// diary.ts — 新增路由
diary.get("/calendar", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const year = parseInt(c.req.query("year") || "");
  const month = parseInt(c.req.query("month") || "");
  
  // 校验参数
  // 查询该用户可见的说说（自己的 + 同工作区的 + PUBLIC）
  // 返回 { dates: string[] }
});
```

- 轻量查询，仅返回有说说的日期字符串数组 `["2026-06-01", "2026-06-03"]`
- 可见性规则与 timeline 一致（同工作区成员可见、PUBLIC 全局可见）
- 不翻页、不返回内容，前端仅需要「哪天有说说」这个信息

### 前端变更

**新增组件**: `DiaryCalendar.tsx`

| 区域 | 实现 |
|------|------|
| 布局 | 7 列网格（日～六），每格显示日期数字 |
| 月导航 | 左上角「← 2026年6月 →」，点击切换月份 |
| 标记 | 有说说的日期底部显示蓝色小圆点 |
| 交互 | 点击日期 → 通知父组件 `onDateSelect(dateStr)` |
| 加载态 | 骨架屏（灰色占位网格） |
| 空态 | 当月没有说说 → 显示「这个月还没有记录」 |
| 边界 | 跨年支持，不允许选未来月份 |

**DiaryCenter 变更**:

- FilterBar 旁新增「列表/日历」视图切换按钮（`CalendarDays` / `List` 图标）
- 日历模式下隐藏原来的 timeline，渲染 `DiaryCalendar`
- 点击日历日期 → 自动切回列表视图 + 调用 `loadTimeline({ from: date, to: date })`
- 「Today」快捷按钮在日历模式下也生效（定位到今天）

### 数据流

```
用户切换日历视图 → DiaryCenter state: view = "calendar"
  → fetch(`/api/diary/calendar?year=2026&month=6`)
  → 渲染 DirayCalendar
  → 点击某天 → setView("list") + setFilter({ date: "2026-06-03" }) + refreshTimeline()
```

---

## Feature 2: 编辑说说时支持添加新标签

### 后端变更

无。`POST /api/tags` 已存在，可直接调用。

### 前端变更

**GenericTagInput 增强**：

- 标签搜索无结果时，在下拉底部显示 `+ 创建「xxx」`
- 点击后调用 `POST /api/tags`（自动使用当前工作区、当前用户） → 成功后选中新标签
- 若创建失败（如重名）显示 toast 错误

现有 `createTag` 已在 API 层导出（`api.ts` 中 `createTag()`），直接集成到 `GenericTagInput` 组件内即可。

### 影响范围

- `GenericTagInput.tsx` — 新增「创建标签」选项
- 其他使用 `GenericTagInput` 的地方（DiaryCenter 说说编辑、TaskCenter 任务编辑）自动受益

---

## Feature 3: @用户通知系统

最复杂的功能，拆为 5 个子模块：数据库 → 后端 API → @解析集成 → 前端 @选择器 → 消息中心。

### 3a. 数据库

**新建 `mentions` 表**（schema.ts + migrations.ts）：

```sql
CREATE TABLE IF NOT EXISTS mentions (
  id TEXT PRIMARY KEY,
  sourceType TEXT NOT NULL,        -- "note" | "diary" | "task"
  sourceId TEXT NOT NULL,
  sourceTitle TEXT,                -- 用于消息列表显示预览
  mentionedUserId TEXT NOT NULL,   -- 被 @ 的用户
  mentionedByUserId TEXT NOT NULL, -- 谁 @ 的
  isPermissionVerified INTEGER DEFAULT 0,  -- 是否已验证被@用户有权限
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  readAt TEXT,                     -- NULL = 未读
  FOREIGN KEY (mentionedUserId) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (mentionedByUserId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_mentions_user ON mentions(mentionedUserId, readAt);
CREATE INDEX idx_mentions_source ON mentions(sourceType, sourceId);
```

### 3b. 后端 API

**新建文件**: `routes/mentions.ts`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/mentions` | 当前用户消息列表，分页，按 createdAt DESC |
| `GET` | `/api/mentions/unread-count` | `{ count: number }` |
| `PUT` | `/api/mentions/:id/read` | 标记单条已读（设 `readAt = now()`） |
| `PUT` | `/api/mentions/read-all` | 全部已读 |

**认证**: 所有端点需 JWT，从 `X-User-Id` + `user.id` 中间件获取当前用户。

**列出消息返回格式**：

```typescript
interface MentionItem {
  id: string;
  sourceType: "note" | "diary" | "task";
  sourceId: string;
  sourceTitle: string | null;
  mentionedBy: { id: string; username: string; displayName: string | null; avatarUrl: string | null };
  createdAt: string;
  readAt: string | null;
}
```

### 3c. @解析集成

在 `diary.ts`、`notes.ts`、`tasks.ts` 的 **create / update** 操作中加入 @mentions 解析。

**解析逻辑**（提取为共享函数 `parseMentions(contentText: string): string[]`）：

```typescript
function parseMentions(text: string): string[] {
  const matches = text.match(/@(\w+)/g) || [];
  return [...new Set(matches.map(m => m.slice(1)))];
}
```

**在 create/update 路由中的处理**：

```
1. 执行原有创建/更新逻辑（拿到 sourceId、sourceTitle）
2. 从 contentText 中提取 @用户名列表
3. 查询 users 表匹配 username → 得到 userId 列表
4. 过滤：排除自己 @自己、排除已在同 source 中已有的 mention
5. INSERT mentions 记录
6. 后续用户查看时做权限校验
```

**权限校验**：查看消息时校验被 @用户是否有权访问源内容

| 类型 | 校验方式 |
|------|---------|
| note | `resolveNotePermission(noteId, mentionedUserId)` — 检查 note_acl + workspace role |
| diary | 检查 visibility !== "PRIVATE" OR 同 workspace 成员 OR 创建者本人 |
| task | 检查 task 所属 workspace 的成员权限 |

校验不通过 → 前端点击时显示「暂无权限查看该内容」toast，不跳转。

### 3d. 前端 @选择器

**新建组件**: `MentionPicker.tsx`

- 在 `TiptapEditor`（笔记）/ `DiaryEditor`（说说）/ `TaskCenter`（任务）中集成
- 检测 `@` 字符输入 → 弹出浮层
- 浮层内容：调用 `GET /api/users/search?q=xxx` 搜索用户名/显示名
- 键盘导航（↑↓ 选择、Enter 确认、Esc 关闭）
- 选中后插入 `@username` + 空格
- 超过 6 个结果显示滚动

**集成方式**：

- 日记编辑器（ComposeBox/DiaryEditor）：`textarea` 的 `onInput` 中检测 `@` 后渲染 `MentionPicker`
- 笔记编辑器（TiptapEditor）：Tiptap 的 `@` 扩展或 `onUpdate` 事件挂钩
- 任务编辑器：任务标题/备注同理

### 3e. 前端消息中心

**Sidebar 变更**：

- 新增「消息盒子」按钮（`Bell` 图标），位于设置齿轮上方
- 显示未读数量小红点（从 AppContext 读取 `unreadMentionCount`）
- 点击 → 设置 `viewMode = "mentions"`

**MentionList 组件**：

- 左侧面板位置（替代笔记本树的面板，类似标签列表样式）
- 标题：「消息盒子」
- 顶部：「全部已读」按钮
- 列表：每条显示：
  - 谁（头像 + 显示名）在什么里面 @了你
  - 来源类型图标（文件/日历/复选框）
  - 来源标题（截断）
  - 时间（相对时间：「3分钟前」）
  - 未读蓝色左边框 / 已读无边框
- 点击：
  1. 调 `PUT /api/mentions/:id/read` 标记已读
  2. 校验权限
  3. 有权限 → 跳转到对应模块并定位到该条目
  4. 无权限 → toast「暂无权限查看」
  5. 成功读后 unreadCount−1

**跨模块跳转逻辑**：

| sourceType | 跳转操作 |
|-----------|---------|
| note | `viewMode = "all"` + `openNote(id)` |
| diary | `viewMode = "diary"` + 加载 timeline 并锚定到该条（使用 `?highlight=id`） |
| task | `viewMode = "tasks"` + 展开/高亮该任务 |

**AppContext 变更**：

```typescript
// 新增 state
unreadMentionCount: number;

// 新增 actions
setUnreadMentionCount(n: number);
refreshMentionCount();  // 调 GET /api/mentions/unread-count
```

- 应用启动时加载一次
- 每 60s 轮询刷新 unread count
- 标记已读后即时减少（乐观更新）

**NavRail 变更**（可选）：

- 如果 NavRail 有空间，在底部按钮区添加消息图标 + 小红点
- 否则只在 Sidebar 中显示

### 影响范围总表

| 文件 | 变更类型 |
|------|---------|
| `backend/src/db/schema.ts` | 新增 `mentions` 表 |
| `backend/src/db/migrations.ts` | 新增迁移函数 |
| `backend/src/routes/mentions.ts` | **新建** — 消息 API |
| `backend/src/routes/diary.ts` | +calendar 端点, +@解析(create/update) |
| `backend/src/routes/notes.ts` | +@解析(create/update) |
| `backend/src/routes/tasks.ts` | +@解析(create/update) |
| `backend/src/index.ts` | 注册 mentions 路由 |
| `frontend/src/types/index.ts` | +Mention 接口, +"mentions" ViewMode |
| `frontend/src/lib/api.ts` | +mentions API 方法 |
| `frontend/src/store/AppContext.tsx` | +unreadMentionCount state+action |
| `frontend/src/components/DiaryCalendar.tsx` | **新建** |
| `frontend/src/components/DiaryCenter.tsx` | +日历视图切换, +@选择器集成 |
| `frontend/src/components/MentionPicker.tsx` | **新建** |
| `frontend/src/components/MentionList.tsx` | **新建** |
| `frontend/src/components/GenericTagInput.tsx` | +创建标签选项 |
| `frontend/src/components/Sidebar.tsx` | +消息盒子按钮+小红点 |
| `frontend/src/components/NavRail.tsx` | +消息按钮+小红点(可选) |
| `frontend/src/components/TiptapEditor.tsx` | +@选择器集成 |
| `frontend/src/components/TaskCenter.tsx` | +@选择器集成(任务编辑) |

---

## 实现优先级

1. Feature 1（日历视图）— 独立、改动最小
2. Feature 2（创建标签）— 单文件改动
3. Feature 3（@用户通知）— 分子步骤：3a 数据库 → 3b 后端 API → 3c @解析集成 → 3d 前端选择器 → 3e 消息中心

按此顺序递进实现，每个子步骤可独立测试。
