# Tiptap 3 免费开源 Pro 拓展 · 接入待办（TODO）

> 背景：Tiptap 于 2025-06 将约 10 个原 Pro 拓展以 MIT 协议免费开源。
> 本项目已基于 Tiptap v3（@tiptap/core 锁定 3.22.3）完成评估。
> 本文件记录**未直接接入**、需后续决策/排期的拓展，以及它们与现有自研实现的重叠与风险。
>
> 版本约束（重要）：所有 `@tiptap/*` 必须锁到与 `@tiptap/core` 一致的 **3.22.3**，
> 否则会装出第二份 `@tiptap/core`，引发 schema / extension "name" 冲突导致整页崩坏。

## 已直接接入（本次变更，见 frontend/package.json + TiptapEditor.tsx）
- `@tiptap/extension-drag-handle`（块拖拽重排手柄）
- `@tiptap/extension-details`（可折叠块 Details / DetailsContent / DetailsSummary）
- `@tiptap/extension-emoji`（:emoji: 候选插入，自带轻量浮层，无 tippy 依赖）

---

## 待办清单

### 1. TableOfContents（`@tiptap/extension-table-of-contents`）
- 能力：根据 heading 自动生成文档大纲/目录。
- 现状重叠：**项目已有大纲功能**（见 `EditorOutlineEntry` 相关测试与大纲面板）。
- 建议：先确认现有大纲实现是否已满足需求；若需要"文档内嵌 TOC 节点"才引入。
- 风险：低（独立节点，不污染现有 schema）；主要是功能重复，先做重叠评估再决定。

### 2. FileHandler（`@tiptap/extension-file-handler`）
- 能力：拖拽/粘贴文件时自动插入（图片走 Image、其他走链接或上传）。
- 现状重叠：项目已有图片上传链路（`rtfImageUploader`、附件库），但仅覆盖图片。
- 建议：可作为"通用文件拖入"能力的增强；需要挂接现有的附件存储后端。
- 风险：中。需配置 `onDrop` / `onPaste` 回调对接后端上传，否则只是空壳；接入前需确认存储接口。

### 3. InvisibleCharacters（`@tiptap/extension-invisible-characters`）
- 能力：可视化空格、换行、制表符等不可见字符。
- 现状重叠：无。
- 建议：纯编辑辅助，按需开启（建议做成可切换的编辑偏好）。
- 风险：低。注意仅在编辑态展示，导出/分享页需关闭，避免把占位符带出去。

### 4. Mathematics（`@tiptap/extension-mathematics`）
- 能力：KaTeX 数学公式（行内 `$...$` / 块级 `$$...$$`）。
- 现状重叠：**项目已有自研 `MathExtensions`（KaTeX）**，且已深度接入：
  - `contentFormat.ts` 的 Turndown 规则（序列化回 `$...$` / `$$...$$`）
  - lezer 预处理把 markdown 公式转回节点
  - 分享页 / SSR 的 `renderNode` 识别
- 建议：**不建议用官方版替换自研版**。官方版用的是 `data-type="math"`，与项目 `data-math-inline` / `data-math-block` 命名不同，替换会牵连上述全链路。
- 风险：高。除非专门做一次"收敛自研实现"的重构，否则不要动。

### 5. UniqueID（`@tiptap/extension-unique-id`）
- 能力：为节点自动分配稳定唯一 ID。
- 现状重叠：**项目已有自研 `BlockIdExtension`**，给块加 `data-block-id`，且被
  `NoteLinkExtension`（跨笔记块链接）、`BlockEmbedExtension`（块嵌入）全链路依赖。
- 建议：**不建议用官方版替换自研版**。官方版默认写入 `data-id`（不是 `data-block-id`），
  且节点类型集合可能不同；替换需同步改 NoteLink / BlockEmbed / 序列化 / 分享页读取逻辑。
- 风险：高。仅在"统一块 ID 方案"专项重构时考虑。

---

## 决策原则
1. **直接接入**：项目无等价实现、且不污染 schema 的（DragHandle / Emoji / Details 已做；TableOfContents / FileHandler / InvisibleCharacters 可按需追加）。
2. **谨慎替换**：与现有自研实现重叠、且命名/序列化深度耦合的（Mathematics / UniqueID），除非重构否则不动。
3. **版本纪律**：任何新增 `@tiptap/*` 一律锁 `3.22.3`，并确认 `npm install` 后 `node_modules/@tiptap/core` 仅一份。
