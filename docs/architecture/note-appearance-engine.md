# Note Appearance Style Capability

> 目标：把“笔记长什么样”沉淀成 Note Appearance Style 能力，而不是再增加一套孤立的“默认笔记主题”。

## Requirement

产品上有三个明确不同的层次：

```text
App 外观风格  -> Sidebar / Settings / Dialog / Navigation
主题模式      -> Light / Dark / Follow system
笔记外观风格  -> RichText / Markdown / Preview / 阅读排版
```

设置页中的“笔记外观风格”决定未单独设置笔记的继承值；单篇笔记仍可独立覆盖。

```text
Note explicit style
      ??
Account note appearance style
      ??
Nowen Default
```

UI 不再向用户暴露“默认笔记主题”这一独立概念。

## Product Decision

能力等级：**Internal Platform Capability**。

当前先稳定内部契约，不冻结 `contributes.themes` Public Manifest。主题插件属于未来扩展，不是本阶段发布面。

核心资产：

```text
Appearance Style Registry
→ Style Resolver
→ White-listed Token Contract
→ Shared Preview Card
→ RichText / Markdown Renderer Adapter
→ Per-note Override
→ Regression Tests
```

## Single Registry

唯一内置事实来源：

```text
frontend/src/lib/noteTheme.ts
```

禁止再维护第二份 Theme / Appearance Style 名单。

首批六种内置风格：

1. `default` — Nowen 默认；
2. `paper` — 纸张阅读；
3. `minimal` — 极简写作；
4. `eye-care` — 夜间护眼；
5. `developer` — 开发文档；
6. `magazine` — 杂志排版。

`NOTE_THEMES` 同时驱动：

- 设置页“笔记外观风格”；
- 单篇“当前笔记外观”；
- Shared Preview Card；
- Light / Dark token；
- Renderer；
- 后续 Share / Export Adapter；
- 未来声明式 Style Pack。

## Token Contract

外观风格只能提供白名单 Design Tokens：

```text
surface
text
heading
muted
border
accent
accentHover
inlineCodeBackground
inlineCodeText
preBackground
preText
quoteBorder
quoteText
softBackground
tableStripe
markBackground
selection
contentMaxWidth
lineHeight
fontFamily
fontSize
```

这些 token 被投影为受控 CSS variables。当前不接受：

- 任意 CSS selector；
- `<style>` / DOM 注入；
- JavaScript；
- `url()`；
- `@import`；
- 远程字体；
- 网络资源；
- 主题脚本。

内置字体栈只引用系统字体，不下载字体文件。

## Renderer Contract

统一渲染适配器：

```text
frontend/src/note-appearance.css
```

同一 token contract 同时覆盖：

```text
RichText       -> .ProseMirror
Markdown Source -> .nowen-md-editor .cm-content
Markdown Live   -> CodeMirror + Markdown preview blocks
Markdown Preview -> .nowen-md-preview
```

Renderer 禁止出现 `paper` / `developer` / `magazine` 等风格 ID 特判；新增风格只应修改 Registry。

## Account Style vs Per-note Override

账号级设置仍使用现有 `UserPreferences.noteTheme` 存储字段，以避免为了产品术语变化做无价值数据迁移；UI 统一称为“笔记外观风格”。

单篇笔记使用独立 appearance metadata。

```text
notes.themeId = NULL
→ 跟随“笔记外观风格”设置

notes.themeId = "default"
→ 显式使用 Nowen 默认，即使账号风格是 Paper

notes.themeId = "developer"
→ 当前笔记明确使用开发文档风格
```

因此 **NULL 与 `default` 必须保持不同语义**。

## Backend Contract

独立元数据 capability：

```text
GET /api/note-appearance/:noteId
PUT /api/note-appearance/:noteId
```

GET 需要 read permission，PUT 需要 write permission。

跟随账号设置：

```json
{ "themeId": null }
```

显式覆盖：

```json
{ "themeId": "developer" }
```

Appearance mutation：

- 可以更新 `updatedAt`；
- 不修改 note content；
- 不增加正文 `version`；
- 不创建正文历史版本。

这条不变量由 backend regression test 锁定。

## Storage

SQLite / PostgreSQL Note 记录使用可空 `themeId`。

当前 runtime schema guard 保证旧数据库恢复/打开时能补齐列和索引。正式 migration ledger 后仍应将 DDL 纳入 canonical migration。

## UX Contract

设置页：

```text
外观与主题
├── 外观风格
├── 主题模式
└── 笔记外观风格
```

“笔记外观风格”使用共享视觉预览卡，Desktop 2–3 列、Mobile 单列/自适应。

单篇笔记入口：

```text
当前笔记外观
├── 跟随笔记外观设置
├── Nowen 默认
├── 纸张阅读
├── 极简写作
├── 夜间护眼
├── 开发文档
└── 杂志排版
```

用户不需要理解 Registry、Theme ID 或 metadata。

## Local-first Sync Gate

当前正文 `note` sync entity 带 `baseVersion`，因此不能把 appearance 粗暴塞进正文 mutation：

```text
change appearance
→ note mutation
→ note.version + 1   // 错误语义
```

正确方向仍然是独立 metadata entity：

```text
entityType: note_appearance
entityId: noteId
payload: { themeId, updatedAt }
```

并完整接入：

```text
Local CRUD
→ Outbox
→ Push
→ Change Feed
→ Pull
→ Apply
→ Conflict Strategy
```

在这条链路完成前，不宣称 Local-first 多设备外观同步已完成。

## Share / Export Gate

正式发布完整外观风格能力前，以下 renderer 还需要消费同一 Registry / server equivalent：

```text
Single Share
Notebook Publication
PDF Export
Image Export
HTML Export
```

禁止各导出器复制独立配色。

## Missing Style Fallback

未来 Style Pack 可能在另一台设备未安装。Note 只保存稳定 ID，例如：

```text
publisher.paper-pro
```

Registry 找不到时正文必须安全回退到 Nowen Default，并允许 UI 提示安装或恢复继承。主题缺失永远不能导致正文不可读。

## Future Extension

### P1 — Notebook inheritance

自然扩展为：

```text
note.themeId
?? notebook.defaultAppearanceStyleId
?? user.noteTheme
?? default
```

### P1 — Share / Export

让分享、PDF、图片、HTML 复用同一 Theme Definition。

### P1 — Local-first metadata sync

增加 `note_appearance` 同步实体，不污染正文 version。

### P2 — Declarative Style Pack

内部契约稳定后再考虑：

```text
contributes.themes / appearanceStyles
```

仍坚持零运行时：无 Action、无 QuickJS、无任意 CSS、无脚本、无远程资源。

### P2 — Note Experience Preset

最终可以组合：

```text
Document Type + Template + Appearance Style
```

形成开发文档、周报、日记、会议记录等 Note Experience Preset。

## Regression Assets

当前回归重点：

- 六种内置风格唯一 Registry；
- Light / Dark token；
- token 禁止 `url()` / `@import` / `javascript:`；
- 账号外观风格缓存持久化；
- 单篇 explicit override；
- explicit `default` 与 inherit 区分；
- 恢复继承时只清除 local tokens；
- RichText / Markdown Source / Live / Preview 共享 renderer contract；
- appearance mutation 不修改正文和正文 version；
- Provider boundary 不允许 Bridge 挂在 `AppProvider` 外。

## Product Asset

本阶段沉淀：

```text
Note Appearance Style Capability
+ Single Appearance Style Registry
+ Style Resolver
+ White-listed Design Token Contract
+ Shared Appearance Preview Card
+ RichText/Markdown Shared Renderer
+ Per-note Override
+ Persistence Contract
+ Regression Suite
+ Local-first / Share / Export Release Gates
```

价值不在于“多了几个主题”，而在于 Nowen Note 已经具备可持续扩展的笔记视觉身份能力。
