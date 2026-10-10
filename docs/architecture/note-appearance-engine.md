# Note Appearance Contribution

Note Appearance 是“单篇笔记内容的阅读与写作样式”，与 App Appearance Style（整个平台外观）正交。
插件只能贡献前者，不能修改侧栏、设置、弹窗或其他 App Chrome。

## 产品语义

- 用户从当前笔记的“更多 → 笔记主题”选择内置主题或插件主题。
- `null` 表示跟随默认；`default` 表示显式使用 Nowen 默认笔记主题。
- 插件主题运行时 ID 固定为 `<pluginId>/<themeId>`，例如 `nowenlab.theme-pack/sepia`。
- 主题 ID 属于笔记元数据，会随数据库备份和 Sync V2 的 note 实体保存。
- 插件禁用、卸载或暂时缺失时，只做视觉 fallback，不改写已保存的主题 ID；同 ID 插件恢复后自动重新生效。

## 架构

```text
contributes.noteThemes
→ Manifest schema 与安装安全校验
→ enabled plugin contributions API
→ Plugin Note Theme Registry
→ Note Appearance Resolver
→ .note-theme-surface semantic tokens
→ RichText / Markdown Source / Markdown Preview
```

内置主题的唯一实现仍是 `frontend/src/lib/noteTheme.ts`。插件 Registry 只把声明式的局部 token
覆盖合并到 `nowen.default`，不创建第二套渲染引擎。

## 安全边界

- Note Theme Contribution 可使用 `declarative` runtime，且必须零数据权限。
- Manifest 只接受宿主 `NoteThemeTokens` 的字段；未知字段直接拒绝。
- 颜色只接受 `#RRGGBB` / `#RRGGBBAA`，宽度和行高有固定范围。
- Host 前端在注册时再次过滤，拒绝 URL、CSS 表达式和未知 token。
- 插件不能注入 CSS、HTML、React、DOM 操作、字体文件或可执行代码。

## 插件开发与打包

官方示例位于 `examples/plugins/theme-pack`。这类插件只需要编写 `manifest.json`，AI 或人工开发者
都可以使用同一套 CLI 完成验证和打包：

```bash
npx nowen-plugin validate
npx nowen-plugin doctor
npx nowen-plugin pack
```

CLI 对声明式插件跳过代码构建，不要求 `main` 或 `actions`；产物仍是标准 `.nowen-plugin`，继续走
现有签名、Registry、安装、启停、更新和卸载生命周期。

## Dark Mode fallback

插件可以省略 `dark`。省略时 Dark Mode 使用 `nowen.default` 的完整暗色 token，不复用亮色覆盖，
避免亮色背景在暗色系统模式下造成眩光。声明了 `dark` 时仅覆盖提供的字段。

## 生命周期与持久化

`NoteAppearanceBridge` 读取当前笔记的持久化 ID，并监听插件贡献和 Light/Dark 变化重新解析。
Registry 中找不到主题时，DOM 标记 `data-note-theme-fallback`，使用默认 token，同时通过
`data-note-theme-requested` 保留运行时可观测性；数据库中的原值不变。

全量备份复制 SQLite 数据库，因此 `notes.themeId` 天然进入备份与恢复。Sync V2 的 Bootstrap、
Snapshot、Outbox、服务端 Apply 与本地 Apply 都必须显式携带该字段；旧客户端 payload 未提供
`themeId` 时保留现值，避免降级客户端清空新元数据。
