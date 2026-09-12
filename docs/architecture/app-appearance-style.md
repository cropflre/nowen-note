# App Appearance Style Capability

## Requirement

“外观风格”描述的是整个 Nowen Note 应用，而不是单篇笔记正文。

```text
App Appearance Style
→ NavRail / Sidebar / Knowledge Tree / Note List
→ Tabs / Toolbar / Editor / Preview
→ Dialog / Popover / Settings / Task / File / AI surfaces
```

Light / Dark / System 仍是独立维度：

```text
Appearance Style × Theme Mode
```

例如 `paper + dark` 与 `paper + light` 使用同一个风格 ID、两套受控 token。

## Single Registry

唯一内置事实来源：

```text
frontend/src/lib/appAppearance.ts
```

首批风格：

- Nowen 默认
- macOS
- 纸张阅读
- 极简写作
- 夜间护眼
- 开发文档
- 杂志排版

`SkinSwitcher` 不维护第二份列表，只消费 Registry。

## Token Contract

风格只能修改白名单的全局语义 token：

```text
--color-bg / surface / sidebar / elevated
--color-border / hover / active
--color-text-*
--color-accent-*
--pm-*
--radius-*
font-family
```

Registry 中可以包含一个编辑器字体建议值用于冷启动投影，但独立的“编辑器字体”设置拥有更高优先级；一旦 `SiteSettings` 提供明确字体，`editorFontAppearanceGuard` 会在外观切换、Light/Dark 切换后恢复它。

不接受任意 CSS、JavaScript、远程字体、`url()`、`@import` 或网络资源。

## Startup Contract

App Appearance 属于运行时基础设施，不能依赖用户打开“设置”或加载 `SkinSwitcher` 后才生效。

```text
main.tsx first import
→ runtimeCompatibility
→ import app-appearance.css
→ bootstrapAppAppearanceRuntime()
→ install legacy note-theme neutralizer
→ install editor-font priority guard
→ React render
```

因此冷启动、公共页面以及懒加载设置页之前都能恢复持久化外观，避免默认主题闪烁。

## Runtime

```text
localStorage(nowen-note-skin)
→ normalize AppAppearanceId
→ <html data-app-appearance data-skin>
→ apply white-listed CSS variables
→ semantic Tailwind tokens
→ whole application
```

主题模式变化时 MutationObserver 重新投影当前风格的 light/dark tokens；storage event 用于多标签页同步。

## Legacy UI Bridge

项目历史上仍有部分组件直接使用 `zinc-* / indigo-*` Tailwind utility。`app-appearance.css` 只负责把这些旧 utility 映射回同一全局语义变量，不保存任何风格颜色，因此不会形成第二套 palette。

当前兼容范围包括：

- neutral surface / text / border / divider；
- dark opacity variants；
- hover / focus / placeholder；
- legacy indigo primary/selected states；
- card/button radius geometry。

状态色保持独立：`red / amber / emerald / purple` 等语义颜色不会被统一映射成主题 accent。

长期应继续把旧组件迁移到 `bg-app-* / text-tx-* / border-app-* / accent-*`，逐步缩小该兼容层。

## Note Theme Compatibility

旧版本曾提供“默认笔记主题 / 单篇笔记主题”。产品方向已调整为全平台外观风格：

- 设置页不再展示笔记主题入口；
- 单篇笔记不再展示外观覆盖入口；
- 旧 metadata/API 暂时保留用于数据库兼容，不作为新功能继续扩展；
- compatibility neutralizer 防止旧缓存的 noteTheme token 覆盖当前 App Appearance。

## Release Gate

正式发布前至少检查以下矩阵：

```text
Surfaces
- App shell / NavRail / Sidebar
- Knowledge Tree / Note List
- Tabs / Toolbar / Editor / Markdown Preview
- Settings / Dialog / Popover / Context Menu
- Task / File / AI / Import & Export panels
- Login / Public share where applicable

Modes
- Light
- Dark
- Follow System (system change while app is open)

Styles
- default / macos / paper / minimal / eye-care / developer / magazine
```

重点验收：

1. 不出现默认灰白/固定紫色“孤岛”；
2. hover / focus / selected 状态仍有清晰层级；
3. status colors 语义不被主题色吞掉；
4. 切换风格、切换 Light/Dark 后编辑器字体设置不被覆盖；
5. 刷新、多标签页、Electron/Web/移动端恢复同一外观；
6. macOS vibrancy 不影响 Portal/Modal 定位；
7. 大列表、大文档切换风格无明显卡顿。

## Product Asset

```text
App Appearance Style Registry
+ Global Token Contract
+ Startup Runtime Projector
+ Light/Dark Resolver
+ Visual Preview Cards
+ Legacy Utility Bridge
+ Editor Font Priority Guard
+ Persistence
+ Regression Tests
+ Release Gate
```
