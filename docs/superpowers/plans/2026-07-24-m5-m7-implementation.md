# M5～M7 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框跟踪进度。

**目标：** 完成复杂节点与 Markdown Block Patch、Block 权威存储和历史、Y.js Subdocument 与真正窗口化，并补齐性能签收协议。

**架构：** 先扩展现有 fail-closed Patch 协议，再建立可由兼容快照重建的 Block shadow 并灰度切读，最后在兼容层后启用 Subdocument 和窗口化。所有阶段均保留 `notes.content` 与单体编辑器回退。

**技术栈：** TypeScript、Hono、better-sqlite3/PostgreSQL、React、Tiptap/ProseMirror、CodeMirror 6、Y.js、Vitest、Node Test Runner。

---

### 任务 1：复杂富文本节点 Patch

**文件：**
- 修改：`frontend/src/lib/tiptapBlockPatchNode.ts`
- 修改：`frontend/src/lib/tiptapBlockPatchPlanner.ts`
- 修改：`backend/src/lib/tiptapBlockPatchNode.ts`
- 修改：`backend/src/lib/tiptapBlockPatch.ts`
- 测试：`frontend/src/lib/__tests__/tiptapBlockPatchPlannerV2.test.ts`
- 测试：`backend/tests/tiptap-block-patch-v2.test.ts`

- [ ] 先为 `video`、`blockEmbed`、`mathBlock`、Mermaid 代码块和含图片段落编写拒绝/接受测试并确认失败。
- [ ] 实现前后端对称的节点白名单、大小限制、安全 URL、附件 ID 和 Block ID 校验。
- [ ] 扩展规划器，只生成同 ID、同位置的原子替换并执行完整 JSON 回放。
- [ ] 运行前后端 Block Patch 定向测试并确认全部通过。

### 任务 2：Markdown Block Patch

**文件：**
- 创建：`backend/src/lib/markdownBlockPatch.ts`
- 创建：`frontend/src/lib/markdownBlockPatchPlanner.ts`
- 修改：`backend/src/runtime/block-patch.ts`
- 修改：`frontend/src/lib/blockPatchApi.ts`
- 测试：`backend/tests/markdown-block-patch.test.ts`
- 测试：`backend/tests/markdown-block-patch-route.test.ts`
- 测试：`frontend/src/lib/__tests__/markdownBlockPatchPlanner.test.ts`

- [ ] 编写稳定 ID、hash 冲突、代码围栏、表格、嵌套列表、引用、HTML 和链接定义边界测试并确认失败。
- [ ] 实现 Markdown 安全块解析、replace/insert/delete/move 和完整回放校验。
- [ ] 将路由按 `contentFormat` 分发到 Tiptap 或 Markdown Patch，并保持版本、历史、索引和幂等事务。
- [ ] 实现前端确定性规划器；不安全或歧义输入返回 `null`。
- [ ] 运行 Markdown 与现有 Block Patch 回归测试。

### 任务 3：Block shadow 存储与版本历史

**文件：**
- 创建：`backend/src/lib/blockAuthorityStore.ts`
- 创建：`backend/src/repositories/blockAuthorityRepository.ts`
- 修改：`backend/src/db/schema.ts`
- 修改：`backend/src/db/migrations.impl.ts`
- 修改：`backend/src/db/postgres/schema.base.sql`
- 修改：`backend/src/runtime/block-patch.ts`
- 修改：`backend/src/routes/notes.ts`
- 测试：`backend/tests/block-authority-store.test.ts`
- 测试：`backend/tests/block-authority-route.test.ts`

- [ ] 编写回填、双写、hash 不一致回退、Block/结构冲突、操作日志和附件引用测试并确认失败。
- [ ] 建立 SQLite/PostgreSQL 对称表结构和 repository 接口。
- [ ] 实现从快照重建、物化快照、健康校验、按 Block/结构版本写入和操作历史。
- [ ] 接入完整保存与 Patch 事务；读取仅在健康且 hash 一致时切到 Block 存储。
- [ ] 覆盖备份恢复、导入导出、版本恢复和老客户端整篇写入后的 shadow 重建。

### 任务 4：性能门禁与真正 Markdown 窗口化

**文件：**
- 修改：`scripts/generate-editor-performance-fixtures.mjs`
- 修改：`frontend/src/lib/editorPerformanceBudget.ts`
- 修改：`frontend/src/components/MarkdownPreview.tsx`
- 创建：`frontend/src/lib/editorPerformanceProtocol.ts`
- 测试：`frontend/src/lib/__tests__/editorPerformanceBudget.test.ts`
- 测试：`frontend/src/components/__tests__/MarkdownPreview.test.tsx`

- [ ] 补 500 媒体、500 代码块和 5 万 Tiptap 节点样本及统一 JSON 指标测试。
- [ ] 为 Markdown 远离视口卸载、高度占位和复杂语义连续性编写测试并确认失败。
- [ ] 实现卸载/恢复、全局任务索引、大纲和内部链接定位。
- [ ] 提供 Web 自动采集入口以及 Electron/Android 同协议适配器。

### 任务 5：Y.js Subdocument 与富文本窗口化

**文件：**
- 创建：`backend/src/services/yjs-subdocuments.ts`
- 创建：`frontend/src/lib/yjsSubdocumentModel.ts`
- 创建：`frontend/src/components/WindowedTiptapEditor.tsx`
- 修改：`backend/src/services/yjs.ts`
- 修改：`frontend/src/components/TiptapEditorRuntime.tsx`
- 测试：`backend/tests/yjs-subdocuments.test.ts`
- 测试：`frontend/src/lib/__tests__/yjsSubdocumentModel.test.ts`
- 测试：`frontend/src/components/__tests__/WindowedTiptapEditor.test.tsx`

- [ ] 编写章节切分、Subdocument 生命周期、离线更新、服务端恢复和 GUID 稳定性测试并确认失败。
- [ ] 实现顶层 map、章节 Subdocument 编解码和现有 Y.js 持久化兼容。
- [ ] 编写窗口挂载、估算高度、IME 锁定、搜索跳转、跨章复制/Undo 回退测试并确认失败。
- [ ] 实现实验开关后的多编辑器窗口化；校验失败时回退单体编辑器。

### 任务 6：最终验证

- [ ] 运行后端 Block Patch、Markdown Patch、Block authority 和 Y.js 定向测试。
- [ ] 运行前端 Patch、性能、Markdown 预览和窗口化定向测试。
- [ ] 运行前后端 TypeScript 检查、前端生产构建和 `git diff --check`。
- [ ] 记录无法在当前环境完成的真实 Electron/Android 设备数据，不将缺少的设备签收写成已完成。

本计划直接在当前工作区执行，不创建 PR、不提交、不推送，并保留现有未提交改动。
