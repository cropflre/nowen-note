# 脑图旧目录与统一知识树

Issue #776 的 Phase 1 保留 `mindmaps` 和 `mindmap_folders` 作为旧客户端的数据来源；统一树不复制脑图正文。

- v104 为每张脑图建立 `mindmap:<id>` 节点。
- v105 将旧脑图目录映射为普通 notebook 节点，物理 ID 为 `__nowen_mindmap_folder__:<旧目录 id>`。旧目录行不删除，旧客户端仍可读取。
- 迁移先建立目录，再恢复同一空间内的父子关系，最后将尚未在统一树中移动过的脑图挂回原目录。缺失父目录、跨空间引用或历史循环保留为根级节点，不丢弃原始行。
- 旧脑图中心对目录的创建、改名、移动，以及脑图的目录移动，会同步到统一树；从统一树移动脑图时，若目标不是旧脑图目录，旧 `folderId` 置空，旧客户端显示在“未分类”。
- 删除旧目录时，仅在映射 notebook 没有任何树子节点、物理笔记或子目录时移除映射；否则保留目录，避免 SQLite 的 notebook 外键级联误删笔记。

迁移与兼容测试见 `backend/tests/knowledge-tree-mindmap-folders.test.ts`。

## 打开方式

- 从桌面或移动知识树点选脑图，会打开 `/mindmaps/:id`，主内容区直接显示该脑图画布，不再附带脑图中心的第二份列表。
- 左侧模块入口 `/mindmaps` 仍保留原脑图中心，用于集中浏览和管理。单篇链接仍可刷新、复制和通过浏览器历史返回；切换到笔记时回到笔记工作区。
- 两种入口复用同一个脑图编辑器及原有保存链路；目前笔记标签页仍只管理笔记，不把脑图伪装成笔记标签页。

主画布与中心列表的路由回归见 `frontend/src/components/__tests__/MindMapEditor.documentMode.test.tsx`、`frontend/src/components/__tests__/LazyMindMapEditorRuntime.test.tsx` 和 `frontend/src/lib/__tests__/mindMapDeepLink.test.ts`。懒加载包装层必须透传路由参数，否则实际 Web 运行时会退回旧脑图中心并丢失当前导图选择。

## 脑图回收站生命周期

- 知识树节点的 `isDeleted` 是脑图的回收站状态；不新增第二套 `mindmaps.isDeleted`。从知识树或旧脑图中心删除都会软删除树节点，脑图正文保留。
- 旧脑图列表、单项读取和写入会隐藏已删除脑图；被删除的旧目录也不再出现在脑图中心。回收站列出当前空间的脑图墓碑，支持恢复或单项永久删除。
- 恢复文件夹时只恢复该次删除记录中的子节点；在删除文件夹前已经单独进回收站的内容保持已删除。若从回收站单独恢复这类脑图，先恢复其已删除的上级目录，再恢复脑图本身。
- 永久删除仅允许已在回收站的脑图，物理删除 `mindmaps` 行后由既有触发器清除树节点。

生命周期回归见 `backend/tests/knowledge-tree-mindmap-lifecycle.test.ts` 和 `frontend/src/components/__tests__/MindmapTrashSection.test.tsx`。统一树节点的跨设备同步、旧目录被删除后仍含其他文档时的最终清理策略，以及移动端本地模式的等价回收站实现，仍是 #776 后续验收项。
