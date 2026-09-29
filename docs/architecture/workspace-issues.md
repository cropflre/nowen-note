# 工作区议题 V1（#756）

## 数据与生命周期

SQLite v114 新建 `workspace_issues`、`workspace_issue_comments`、`workspace_issue_events`、`notifications`。PostgreSQL 的幂等建表脚本位于 `backend/src/db/postgres/migrations/0114-workspace-issues.sql`，由 `schema.sql` 重放入口加载。项目当前默认运行时仍为 SQLite；该变更没有切换现有数据库适配器。

议题编号在工作区内唯一；SQLite 使用立即事务完成编号分配、议题写入和通知写入。评论和状态改变同样与通知一起提交，通知写入失败会回滚业务操作。重复关闭或重开不会重复产生事件或通知。

关闭仅改变状态，不删除讨论。关闭时间、操作者保存在议题行，历次关闭和重开保存在事件表。评论预留 `parentId` 并校验同一议题，V1 以平铺时间线呈现。删除自己的评论会把子回复的 `parentId` 置空，保留子回复。

工作区物理删除级联清理议题、评论、事件和通知；用户删除保留其他成员的讨论并将作者置空；关联笔记删除把关联置空。整库备份使用项目既有的全表枚举与整库恢复机制，自动包含新表。

## 内部接口

所有端点在主服务的 JWT 鉴权之后挂载。V1 未定义公共 API Token scope，API Token 请求明确拒绝，不开放 SDK。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/workspace-issues?workspaceId=…&status=all/open/closed` | 工作区列表、总数、当前创建权限 |
| `POST /api/workspace-issues` | 创建，正文含 `workspaceId/title/content/relatedNoteId` |
| `GET /api/workspace-issues/:id` | 详情、关联笔记及当前操作权限 |
| `PATCH /api/workspace-issues/:id` | 修改正文、关联或 `status=open/closed` |
| `GET /api/workspace-issues/:id/activity` | 评论与状态事件时间线 |
| `POST /api/workspace-issues/:id/comments` | 回复，可含同议题 `parentId` |
| `PATCH/DELETE /api/workspace-issues/:id/comments/:commentId` | 编辑或删除自己的回复 |
| `GET /api/notifications?unread=true/false` | 本人通知、总数、未读数 |
| `POST /api/notifications/:id/read` | 本人单条通知已读，幂等 |
| `POST /api/notifications/read-all` | 本人当前可见通知全部已读 |

列表、时间线、通知支持 `limit`（默认 30，上限 100）和非负 `offset`。标题最多 200 字符，正文 100000 字符，回复 20000 字符。前端 Markdown 不启用原始 HTML。

权限以现有 workspace role 为准；每次通知读取和标记已读都重新检查收件人成员身份与资源存在性。笔记关联要求同工作区、未在回收站且可读，详情按读者的笔记 ACL 再次脱敏。

## 前端

`/issues` 和 `/issues/:id` 复用 `appPathNavigation`，支持 Web、Electron file 路径和 Capacitor 路径；议题导航及服务器地址推断保留反向代理部署前缀。议题详情可通过资源 ID 解析工作区；通知导航先切换工作区再打开资源。手动切换工作区清理草稿并返回议题列表，过期响应不会覆盖新工作区状态。

通知中心在 AppLayout 中挂载一次，快捷栏和侧栏只负责打开它，避免移动抽屉与桌面快捷栏重复轮询。它使用现有 `useVisibleViewport` 避让键盘；议题编辑区域也按实际可见底边限制高度。议题写操作复用现有 HTTP 鉴权、超时和原生 HTTP 机制，但明确跳过离线写队列。

回归覆盖：角色与工作区隔离、创建/回复通知排除自身、关闭重开历史、评论所有权、已读隔离、移除成员、分页、并发编号、关联笔记、通知失败回滚、删除清理、过期请求、输入保留与键盘高度。
