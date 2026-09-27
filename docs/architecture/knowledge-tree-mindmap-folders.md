# 脑图旧目录与统一知识树

Issue #776 的 Phase 1 保留 `mindmaps` 和 `mindmap_folders` 作为旧客户端的数据来源；统一树不复制脑图正文。

- v104 为每张脑图建立 `mindmap:<id>` 节点。
- v105 将旧脑图目录映射为普通 notebook 节点，物理 ID 为 `__nowen_mindmap_folder__:<旧目录 id>`。旧目录行不删除，旧客户端仍可读取。
- 迁移先建立目录，再恢复同一空间内的父子关系，最后将尚未在统一树中移动过的脑图挂回原目录。缺失父目录、跨空间引用或历史循环保留为根级节点，不丢弃原始行。
- 旧脑图目录接口仍保留兼容；旧客户端对目录的创建、改名、移动，以及脑图的目录移动，会同步到统一树。从统一树移动脑图时，若目标不是旧脑图目录，旧 `folderId` 置空，旧客户端显示在“未分类”。
- 删除旧目录时，仅在映射 notebook 没有任何树子节点、物理笔记或子目录时移除映射；否则保留目录，避免 SQLite 的 notebook 外键级联误删笔记。

迁移与兼容测试见 `backend/tests/knowledge-tree-mindmap-folders.test.ts`。

## 打开方式

- 从桌面或移动知识树点选脑图，会打开 `/mindmaps/:id`，主内容区直接显示该脑图画布，不再附带脑图中心的第二份列表。
- 桌面树和移动快捷树根据当前脑图路由高亮对应节点；浏览器前进/后退也会更新高亮，避免仍高亮之前打开的笔记。
- 左侧模块入口 `/mindmaps` 是“全部脑图”聚合视图：搜索标题或目录路径，按最近使用或收藏筛选，显示每张脑图在统一知识树中的位置。这里不再展示或创建脑图专属文件夹，也不展示第二列“未分类”列表。新建脑图时选择统一知识树中的目录位置；单篇链接仍可刷新、复制和通过浏览器历史返回。
- 两种入口复用同一个脑图编辑器及原有保存链路；目前笔记标签页仍只管理笔记，不把脑图伪装成笔记标签页。

主画布与聚合视图的路由回归见 `frontend/src/components/__tests__/MindMapEditor.documentMode.test.tsx`、`frontend/src/components/__tests__/LazyMindMapEditorRuntime.test.tsx` 和 `frontend/src/lib/__tests__/mindMapDeepLink.test.ts`；聚合投影见 `frontend/src/lib/__tests__/mindMapOverview.test.ts`。懒加载包装层必须透传路由参数，否则实际 Web 运行时会丢失当前导图选择。

脑图结构化编辑沿用现有画布和大纲：选中节点后 Tab 新建子节点、Enter 新建同级、Shift+Tab 将节点提升为其父节点的同级，方向键按可见树顺序选择节点；根节点和根的直接子节点不能继续提升。提升操作保留子树，并进入原有保存及撤销/重做历史。纯树变换回归见 `frontend/src/components/__tests__/MindMapOutlineKeyboard.test.ts`。

## 脑图回收站生命周期

- 知识树节点的 `isDeleted` 是脑图的回收站状态；不新增第二套 `mindmaps.isDeleted`。从知识树或聚合视图删除都会软删除树节点，脑图正文保留。
- 旧脑图列表、单项读取和写入会隐藏已删除脑图；旧目录行及兼容接口继续保留，但新版聚合视图不展示旧目录。回收站列出当前空间的脑图墓碑，支持恢复或单项永久删除。
- 恢复文件夹时只恢复该次删除记录中的子节点；在删除文件夹前已经单独进回收站的内容保持已删除。若从回收站单独恢复这类脑图，先恢复其已删除的上级目录，再恢复脑图本身。
- 永久删除仅允许已在回收站的脑图，物理删除 `mindmaps` 行后由既有触发器清除树节点。

生命周期回归见 `backend/tests/knowledge-tree-mindmap-lifecycle.test.ts` 和 `frontend/src/components/__tests__/MindmapTrashSection.test.tsx`。统一树节点的跨设备同步、旧目录被删除后仍含其他文档时的最终清理策略，以及移动端实机验收，仍是 #776 后续验收项。

## Android 设备本地模式

- 本地脑图正文仍在原生 `mindmaps` 表；统一树的目录位置、排序和回收站状态写入设备本地 `mobile_local_mindmap_tree`，不把 notebook ID 冒充旧 `mindmap_folders` ID。
- 设备本地树可列出脑图，在文件夹或根目录创建脑图，并可移动、排序、重命名、移入回收站、恢复及永久删除。`getMindMaps` 和 `getMindMap` 不返回已在回收站的脑图，永久删除仅允许已删除脑图。
- 这个本地增量表目前不是 Sync V2 实体；以上验证不等同于跨设备目录位置同步，也不等同于 iOS 实机验收。已登录 Android 的服务器树结构仍需单独验收。
- 已登录 Android 在线时从服务端统一树读取目录结构及共享节点，并在账号独立的原生数据库中按空间缓存最后一次成功的树列表。断网时优先读取该快照，保留上次读取到的脑图跨类型父子关系；无快照时才回退本机笔记/文件夹投影。401/403 不回退；工作区离线读取还要求本地访问状态为 active，服务端返回 403 后冻结该工作区离线入口。快照只提供上次在线时的只读结构，不同步离线树变更，也不能代替 Sync V2 的跨设备结构同步。

## Sync V2 结构同步门禁

当前 Sync V2 同步 notebook、note、mindmap 的业务内容，却不传 `knowledge_tree_nodes` 的跨类型 `parentId`、`sortOrder` 和回收站状态。因此“导图正文已同步”不能作为 #776 的跨设备目录验收证据。仅给 mindmap 载荷加 `parentId` 也无法正确表达挂在笔记或其他文档下的节点。

接入统一树结构前，必须同时满足：

1. 本地树变更与 Outbox 原子入队，服务端 Change Feed、Snapshot、Push、客户端 Pull/Apply 与 Bootstrap 全部覆盖同一结构契约；实体创建顺序允许跨类型父节点，并保留未解决的并发移动冲突。
2. 旧客户端不能接收不认识的树实体后仍推进游标或 ACK，也不能在降级后误推本地不认识的实体；服务端开放新实体前还需完成协议能力协商，避免旧客户端反复停在未知实体上。桌面端的未知实体 fail-closed 回归见 `backend/tests/sync-v2-unknown-entity.test.ts`、`backend/tests/sync-v2-engine.test.ts`；移动端见 `frontend/src/lib/__tests__/mobileSyncUnknownEntity.test.ts`。这只是客户端防护，不代表服务端已开放树实体。
   当前服务端未协商的 V2 请求固定只读取原有 10 类实体，Change Feed 跳过未来实体但仍推进旧客户端游标，Snapshot 也保持旧实体顺序；回归见 `backend/tests/sync-v2-protocol.test.ts`。后续新客户端若要订阅树实体，必须显式协商能力并执行全量 Snapshot，不能沿用已跳过树变更的旧游标。
   `/plan` 返回当前 10 类 `entityTypes`；`/plan`、`/changes`、`/snapshot`、`/push`、`/ack` 的可选 `entityTypes` 查询参数只接受这 10 类的完整集合（逗号分隔，顺序不限）。未知、缺失部分或重复实体均拒绝，不能静默推进游标或 ACK。
   显式订阅的 `/plan`、`/changes`、`/snapshot` 还须传 `deviceId`。服务端按设备、用户和 Scope 保存订阅集合；初次声明或旧客户端 ACK 降级后，`/plan` 与 `/changes` 返回 `resetRequired`，不能沿用旧游标。客户端逐页读取完整 Snapshot 后，以相同 `entityTypes` 和 Snapshot 序号 ACK，才恢复增量读取；跳页、提前 ACK 或使用其他序号均被拒绝。旧客户端不传 `entityTypes` 时保持原协议。此握手只对当前 10 类开放，知识树实体仍未就绪。
3. 以两台独立数据库验证：脑图挂在笔记下、跨类型拖动及重排、删除/恢复、断网补传、并发移动、旧版本升级与工作区权限；若任一场景缺失，不把目录同步标记为可发布。

在上述完整链路落地前，#776 的跨设备结构同步仍未完成；已有协议握手与服务端结构变更捕获，但未开放新实体订阅。
`backend/tests/sync-v2-entity-readiness.test.ts` 校验当前 10 类协议实体与能力注册表一致，并要求 `knowledge_tree_node` 在七段链路补齐前保持未就绪。

v107 已将知识树结构插入、移动、排序、软删除/恢复和物理删除写入服务端 `sync_changes_v2`；内容变化仅更新 `updatedAt` 或展开状态变化不产生结构事件。迁移保留已有 sequence 与 AUTOINCREMENT 高水位，旧客户端的 feed 查询继续过滤树实体。回归见 `backend/tests/sync-v2-knowledge-tree-feed.test.ts`。这只完成 Change Feed 一段；Outbox、Push、Snapshot、Pull/Apply 和冲突策略未就绪时，树实体仍不进入 `SYNC_ENTITY_TYPES` 或显式订阅集合。
