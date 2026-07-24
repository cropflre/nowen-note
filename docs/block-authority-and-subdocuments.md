# Block 权威存储、性能签收与 Subdocument

## Block 权威存储

SQLite schema v55 新增 `note_block_documents`、`note_block_records`、`note_block_operations` 和 `note_block_attachment_refs`；PostgreSQL 基线包含对等结构。整篇保存、Block Patch、旧 Block 写接口和版本恢复会同步重建记录。导入或老版本直写造成 shadow 缺失时允许 read-repair；检测到 `mismatch` 时保留现场并回退 `notes.content`，不会静默覆盖。

服务端默认使用兼容快照；只有显式设置以下开关才启用健康 Block 主读：

```text
NOWEN_BLOCK_AUTHORITY_MODE=primary
```

未知值按 `shadow` 处理。恢复和往返导入会逐笔记同步 Block 状态，单笔失败只产生警告并保留原正文。

灰度读只有在以下三个 SHA-256 同时一致时才使用 Block 快照：`notes.content`、`snapshotContent`、`snapshotHash/materializedHash`。任一不一致都会标记 `mismatch` 并回退兼容快照。`backfillBlockAuthorityStore` 支持 `limit + afterId` 的有界回填。

内容更新可校验单 Block `version`；创建、删除、移动和 Lift 可校验 `structureVersion`。操作载荷、笔记版本、Block 版本和结构版本写入独立历史表。附件引用从每个 Block payload 派生。

## 性能签收

`editorPerformanceProtocol.ts` 定义 Web、Electron、Android 共用的 3×9 场景矩阵，缺少任一报告即失败。统一记录输入延迟、Long Task、首次可交互、20 次切换、四阶段堆内存、关闭后的 Worker/媒体请求，以及 `editorMode`、`sectionCount`、`peakMountedSections` 窗口化 A/B 标签。Markdown 场景还要求分段前后渲染一致。

堆增长预算是 `max(64 MiB, baseline × 20%)`，即至少允许 64 MiB；不是在 64 MiB 和 20% 中取更严格者。固定样本命令：

```bash
npm run perf:editor-fixtures
```

样本包含 2.4 MB Markdown、500/20,000/50,000 Block 富文本、100/500 重节点和 100/500 代码块。

## Y.js Subdocument 与窗口化

SQLite schema v56 新增 Subdocument manifest、章节快照和离线 update 日志，v58 增加 `generation` 与 `structureVersion`；PostgreSQL 基线包含对等结构。章节优先按 H1/H2 切分，无标题长文每 250 个顶层 Block 切分。章节 GUID 由笔记 ID 与首个稳定 Block ID 派生，普通文本编辑不会改变 GUID 或 generation；新增、删除顶层 Block 或改变章节边界时会原子重分段并推进代际。

服务端实验开关：

```text
NOWEN_YJS_SUBDOCUMENTS=1
```

前端实验开关：

```js
localStorage.setItem("nowen:tiptap-subdocuments", "1")
```

前端仅在运行策略进入优化模式后启用章节窗口。首章常驻以保留统一编辑器 chrome，其余章节在视口前后 1200 px 内挂载，离开后保存快照和实测高度再卸载。IME composition 期间禁止卸载；搜索使用当前编辑值定位并先挂载目标章节。离线 pending 与 generation 绑定，旧代际 update 不会发送或删除。跨章节选择、拖拽、代际冲突、服务端重分段、模型或物化校验失败时，携带当前最新快照立即回退单体编辑器。
