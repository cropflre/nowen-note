# 编辑器大纲生成与跳转修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 恢复富文本和 Markdown 的完整大纲，并让大纲点击定位到当前可见编辑器中的正确标题。

**架构：** 保留现有 Worker 分析器和统一 `NoteEditorHeading` 契约。富文本窗口层聚合章节标题并独占跨章节导航；Markdown 大文档根据当前视图选择 CodeMirror 或预览 DOM 的定位器。

**技术栈：** React、TypeScript、Tiptap/ProseMirror、CodeMirror 6、Vitest。

---

### 任务 1：恢复优化模式大纲发布

**文件：**
- 修改：`frontend/src/lib/tiptapDerivedRuntime.ts`
- 测试：`frontend/src/lib/__tests__/tiptapDerivedRuntime.test.ts`

- [ ] 编写失败测试，要求所有可打开的优化模式继续发布 Worker 大纲。
- [ ] 运行定向测试，确认因当前返回 `wholeDocumentAnalysis` 而失败。
- [ ] 最小修改大纲发布判定。
- [ ] 运行定向测试确认通过。

### 任务 2：统一窗口化富文本大纲和跨章节导航

**文件：**
- 修改：`frontend/src/components/WindowedTiptapEditor.tsx`
- 测试：`frontend/src/components/__tests__/WindowedTiptapEditor.test.tsx`

- [ ] 编写失败测试，验证大纲覆盖所有章节且父级只注册一个跳转函数。
- [ ] 运行测试确认失败原因是仅首章发布标题、子章节覆盖回调。
- [ ] 聚合章节标题，记录导航令牌到章节内位置的映射，并在点击时挂载目标章节后定位。
- [ ] 运行窗口化编辑器测试确认通过。

### 任务 3：修正大 Markdown 预览大纲跳转

**文件：**
- 修改：`frontend/src/components/LargeMarkdownSafeEditor.tsx`
- 测试：`frontend/src/components/__tests__/LargeMarkdownSafeEditor.preview.test.tsx`

- [ ] 编写失败测试，验证预览模式调用 Markdown 预览定位而不是隐藏的 CodeMirror。
- [ ] 运行测试确认失败。
- [ ] 保存预览根引用，并按当前视图分流大纲跳转。
- [ ] 运行测试确认通过。

### 任务 4：完整验证

**文件：**
- 验证：上述所有生产文件和测试文件。

- [ ] 运行大纲、分析 Worker、Markdown 预览和窗口化编辑器定向测试。
- [ ] 运行前端 TypeScript 检查。
- [ ] 运行前端生产构建。
- [ ] 检查 `git diff`，确认没有包含 `.superpowers/` 或无关文件。
