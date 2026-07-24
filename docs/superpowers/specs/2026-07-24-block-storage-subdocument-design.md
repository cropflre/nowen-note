# M5～M7 Block 存储与 Subdocument 设计

## 目标

在保留现有客户端、备份、导入导出和整篇保存兼容性的前提下，完成复杂富文本节点与 Markdown 的 Block Patch，将 Block 作为可校验、可恢复、可追踪历史的权威存储，并为超大富文本引入按章节加载的 Y.js Subdocument 与编辑器窗口化。

## M5：复杂节点与 Markdown Patch

复杂富文本节点沿用现有 `replace` 操作，只允许替换一个相同类型、相同 `blockId` 的已有原子节点。图片、视频、Block Embed、Math Block 和 Mermaid 分别使用独立属性白名单、URL/内容长度限制与附件 ID 校验；未知字段、类型转换、嵌套位置变化或文档回放不一致时回退整篇保存。图片仍是行内节点，因此它的属性变化归属于拥有 `blockId` 的父段落，不单独获得 Block 身份。

Markdown 使用独立协议。服务端解析稳定 `^blk_*` 标记得到块范围和内容 hash，支持 replace、insert、delete、move；请求同时携带笔记版本与目标 hash。代码围栏、表格、列表、引用、HTML 块和链接定义被视为不可从中间切开的安全边界。没有稳定 ID、ID 重复、范围歧义或 hash 不一致时拒绝 Patch，客户端回退整篇保存。

## M6：Block 权威存储与历史

新增 `note_block_documents`、`note_block_records`、`note_block_operations` 和 `note_block_attachment_refs`。文档表保存格式、Block 版本、结构版本、快照 hash、兼容快照状态；记录表按 Block 保存顺序、父级、类型、JSON/Markdown 原文、文本与 hash；操作表保存 Patch 前后版本和操作载荷；附件引用表从每个 Block 的内容派生。

写入流程在单个数据库事务内完成：解析兼容快照、写 Block 记录、重建序列化内容并比较 hash、更新 `notes.content`。任何解析或 hash 不一致都标记 shadow 状态并继续以 `notes.content` 为读源。灰度读仅在 shadow 状态健康且物化内容 hash 与兼容快照一致时返回 Block 存储；否则自动回退。完整快照仍保留给老客户端、备份、恢复、导入导出和版本恢复。

Block 内容冲突使用单 Block version；创建、删除、移动使用独立 structure version。完整保存会重建 shadow；Patch 只更新受影响 Block，并按需物化兼容快照。

## M7：Y.js Subdocument 与窗口化

富文本 Y.Doc 使用一个顶层 `Y.Map` 保存文档元数据和章节顺序，每个章节是独立 Subdocument。章节边界优先使用一级/二级标题，超大无标题内容按顶层 Block 数量切分。服务端复用现有 Y.js 更新与快照机制，持久化主文档及 Subdocument GUID；未启用实验开关时继续使用现有单体编辑器。

前端窗口化控制器只保留视口前后缓冲章节的编辑器实例，卸载章节保存估算高度、选区书签和 Subdocument 状态。跨章节复制、搜索和跳转通过顶层索引完成；跨章节拖拽、连续选区和 Undo 无法安全映射时临时挂载相邻章节或回退单体编辑器。IME composition 期间禁止卸载当前章节。

## 性能与回退

性能报告统一输出首次可输入、输入 p50/p95、最长 Long Task、DOM 数、NodeView mount、Worker/媒体请求和内存。Web 自动采集；Electron 和 Android 复用相同协议。连续切换和关闭后资源计数必须回到基线。Markdown 预览与富文本章节都使用高度占位并允许远离视口后卸载。

任何 Block shadow、Subdocument 或窗口化校验失败都不得静默修复：记录原因并回退 `notes.content` 与单体编辑器。现有格式和客户端始终保持可读写。
