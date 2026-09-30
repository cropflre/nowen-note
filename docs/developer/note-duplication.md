# 笔记副本的目标目录

知识树 `...` / 右键菜单的「创建副本」创建同级副本；文档右侧 `+` 菜单的「创建副本」创建到当前文档下。支持富文本和 Markdown。成功后，`+` 入口刷新目录、展开或进入源文档的子内容，并选中、滚动定位新副本。

## 内部 API

`POST /api/notes/:id/duplicate`

```json
{ "placement": "child" }
```

- 不传请求体或不传 `placement`：默认 `sibling`，沿用源父目录。
- `sibling`：源文档的父节点。
- `child`：源文档对应的知识树节点。
- 其他 `placement` 返回 400。API 不接受任意目标目录或空间作为复制落点；目标由服务端从源节点推导。

源文档必须可读、未锁定、未进入回收站。目标节点必须允许 `canCreate`；子目录复制不要求 `canMove` 或 `canDelete`。个人共享树保留原树 Owner，workspace 副本留在原 workspace，权限通过现有知识树 ACL 继承。

标题编号在实际目标目录、相同 scope 下计算。创建 Note、附件元数据、标签、Blocks、Links、References、block authority、启用的 Yjs subdocuments 与树节点使用现有数据库事务。附件对象先独立复制，引用改写为新附件 ID；事务失败时清理已复制对象。文件/对象存储不属于 SQLite 事务，此处沿用失败补偿机制，不提供进程崩溃时的跨存储事务保证。

## 回归覆盖

- `backend/tests/note-duplicates.test.ts`：API 兼容、目标目录编号、ACL、workspace、权限撤销、源节点移动、两种格式与附件/索引完整性、事务失败清理。
- 前端 `knowledgeTreeDuplicateAsChild.test.ts`、`KnowledgeTreeChildDuplicateMenu.test.tsx`、`KnowledgeTreeCreatedSelection.test.tsx`：权限门槛、单次复制请求、菜单成功/失败交互及刷新后跨界面定位。
