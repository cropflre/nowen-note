# Note Appearance Engine

> 目标：让“主题属于笔记”，而不是把笔记主题做成一个孤立的全局换肤设置。

## Requirement

用户选择主题时，表达的是“这篇笔记应该长什么样”。因此产品模型是：

```text
Note
  └── appearance
       └── themeId
              ↓
        Theme Registry
              ↓
        Theme Renderer
```

App Skin / Light-Dark Mode 与 Note Theme 是两个不同层级：

```text
App Skin   -> Sidebar / Settings / Dialog / Navigation
Note Theme -> Editor / Preview / document typography / reading surface
```

一个深色 Nowen 界面可以打开纸张阅读主题；一个浅色 Nowen 界面也可以打开夜间技术主题。

## Current Architecture Impact

本能力横跨：

- Storage：笔记主题必须是独立元数据，不能写进正文；
- Editor：Tiptap 与 Markdown 必须共享同一主题解析器；
- Rendering：主题只能影响文档视觉语义，不能修改 App chrome；
- Security：未来主题插件不能获得任意 CSS/JS 注入能力；
- Sync：外观元数据需要独立于正文版本语义同步；
- Share / Export：后续必须复用同一 Theme Definition，避免本机、分享、导出三套样式。

## Product Decision

### 1. Internal Capability first

当前保持 Internal API：

```text
Note Appearance Metadata
Theme Registry
Theme Resolver
Theme Token Projector
Tiptap / Markdown Renderer Adapter
```

暂不冻结 `contributes.themes` Public Manifest。

原因：主题字段、继承规则、跨端同步和导出语义仍需要真实内置主题验证。先用 4 个内置主题跑稳契约，再开放给插件生态。

### 2. Metadata, not content

SQLite / PostgreSQL 的 Note 记录增加可空 `themeId`。

```text
NULL          -> 继承 Nowen 默认
nowen.paper   -> 纸张阅读
nowen.minimal -> 极简写作
nowen.night   -> 夜间护眼
```

恢复默认写回 `NULL`，而不是把默认值复制到每篇笔记。

切换主题：

- 更新 `updatedAt`；
- 不改正文；
- 不增加内容版本 `version`；
- 不创建正文历史版本。

这保证视觉变化不会伪装成内容修改。

## Backend Contract

P0 提供独立元数据 capability：

```text
GET /api/note-appearance/:noteId
PUT /api/note-appearance/:noteId
```

GET 需要当前用户拥有 note read capability。
PUT 需要 write capability。

PUT 示例：

```json
{
  "themeId": "nowen.paper"
}
```

返回：

```json
{
  "noteId": "...",
  "themeId": "nowen.paper",
  "updated": true
}
```

主题标识只允许：

```text
[a-z0-9][a-z0-9._-]{0,95}
```

因此 URL、CSS、`@import`、空格选择器等不能伪装成 themeId。

## Theme Registry

前端唯一内置事实来源：

```text
frontend/src/lib/noteAppearance.ts
```

当前主题：

1. `nowen.default` — Nowen 默认；
2. `nowen.paper` — 纸张阅读；
3. `nowen.minimal` — 极简写作；
4. `nowen.night` — 夜间护眼。

同一 Theme Definition 同时驱动：

- 主题选择 UI；
- 主题预览卡片；
- Renderer CSS variables；
- 未来 Share / Export Adapter；
- 未来零运行时 Theme Plugin。

禁止 UI 名称、Renderer token、插件定义各维护一份主题名单。

## Security Boundary

Theme Definition 只映射到白名单 Design Tokens：

```text
canvas
surface
text
muted
accent
border
quoteBackground
codeBackground
inlineCodeBackground
maxWidth
fontFamily
fontSize
lineHeight
```

Renderer 最终只写 `--note-theme-*` CSS Variables。

当前能力不接受：

- 任意 CSS selector；
- `<style>` / DOM 注入；
- JavaScript；
- `url()`；
- `@import`；
- 远程字体；
- `position: fixed`；
- 自定义网络资源。

未来 Theme Plugin 必须继续维持“零运行时声明式资源包”模型。

## Editor Integration

`NoteAppearanceBridge` 是 Tiptap 和 Markdown 的共享 Renderer Adapter。

```text
activeNote.id
   ↓
GET appearance metadata
   ↓
resolveNoteTheme(themeId)
   ↓
noteThemeCssVariables()
   ↓
current editor content surface
```

它不会把 themeId 塞进 editor document，也不会通过 stale `activeNote` snapshot 回写正文状态。

主题 UI 是“这篇笔记的外观”，而不是 Settings 中的全局皮肤入口。

## Local-first Sync Gate

### 为什么没有直接把 themeId 塞进现有 Note Sync payload

当前 Sync V2 把 `note` 当成带 `baseVersion` 的版本化正文实体：

```text
note mutation
  -> compare baseVersion
  -> apply full note payload
  -> server increments note.version
```

如果仅为了换主题，把 `themeId` 塞进这条 payload：

```text
change theme
  -> note mutation
  -> remote note.version + 1
```

这会破坏 Note Appearance 的核心不变量：

> 外观变化不是正文版本变化。

因此 P0 **不把 themeId 硬塞进现有版本化 Note mutation**。

### 正确后续方向

Local-first 多设备主题同步必须作为独立 metadata capability 接入完整同步七环：

```text
Local CRUD
→ Outbox
→ Push
→ Change Feed
→ Pull
→ Apply
→ Conflict Strategy
```

推荐实体语义：

```text
entityType: note_appearance
entityId: noteId
payload: { themeId, updatedAt }
```

它依附 Note 存在，但不推进正文 `version`。

在这条完整链路落地并通过回归前，不得把“本机主题可保存”描述成“Local-first 多设备主题同步已完成”。

## PostgreSQL

主 PostgreSQL schema replay 已补：

```sql
ALTER TABLE notes ADD COLUMN IF NOT EXISTS "themeId" TEXT;
CREATE INDEX IF NOT EXISTS idx_notes_theme_id ON notes("themeId");
```

SQLite v1.5.0 runtime capability 使用幂等 schema guard；数据库恢复/重新打开后会重新确认该列存在。

正式统一 migration ledger 后，应把这项 DDL 纳入下一条 canonical migration，并保留 runtime guard 作为旧构建/恢复兼容层。

## Share / Export Gate

当前 P0 聚焦“当前笔记编辑/阅读主题”。

在对外宣称“主题完整发布”之前，还需要让：

```text
Single Share
Notebook Publication
PDF Export
Image Export
HTML Export
```

消费相同 Theme Definition。

不能在各导出器里复制硬编码颜色。

## Missing Theme Fallback

未来插件主题可能在另一台设备未安装。

Note 只保存稳定 ID：

```text
publisher.paper-pro
```

Theme Registry 找不到时必须：

```text
resolve unknown theme
→ nowen.default
```

后续 UI 可提示：

```text
当前笔记使用的主题尚未安装
[安装主题] [使用默认主题]
```

正文永远不能因为主题包缺失而不可读。

## Future Extension

### P1 — Inheritance

解析顺序：

```text
note.themeId
  ?? notebook.defaultThemeId
  ?? user.defaultNoteThemeId
  ?? nowen.default
```

Notebook / User 只提供默认值；Note 明确选择始终优先。

### P1 — Share / Export

让分享、PDF、图片和 HTML 复用 `NoteThemeDefinition` / server-side equivalent。

### P1 — Local-first Metadata Sync

增加 `note_appearance` 同步实体，不污染正文 version。

### P2 — Theme Plugin

稳定后再考虑：

```text
contributes.themes
```

主题包：

- 不需要 `main`；
- 不需要 Action；
- 不申请 note read 权限；
- 不启动 QuickJS / Worker；
- 只包含签名后的声明式 token、预览资源和允许的本地字体资产。

### P2 — Preset

最终可组合：

```text
Document Type + Template + Theme
```

形成 Note Experience Preset，例如“开发文档 / 周报 / 日记 / 会议记录”。

## Product Asset

本阶段沉淀：

```text
Note Appearance Metadata Capability
+ Built-in Theme Registry
+ Theme Resolver
+ White-listed Design Token Contract
+ RichText/Markdown Shared Renderer Adapter
+ Per-note Theme UX
+ PostgreSQL Compatibility
+ Regression Tests
+ Local-first Sync Release Gate
```

它的价值不是“多了几个颜色”，而是为笔记建立可扩展、可安全分发的视觉身份模型。
