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
--editor-font-family
font-family
```

不接受任意 CSS、JavaScript、远程字体、`url()`、`@import` 或网络资源。

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

项目历史上仍有部分组件直接使用 `zinc-*` Tailwind utility。`app-appearance.css` 只负责把这些旧 utility 映射回同一全局语义变量，不保存任何风格颜色，因此不会形成第二套 palette。

长期应继续把旧组件迁移到 `bg-app-* / text-tx-* / border-app-* / accent-*`，逐步缩小该兼容层。

## Note Theme Compatibility

旧版本曾提供“默认笔记主题 / 单篇笔记主题”。产品方向已调整为全平台外观风格：

- 设置页不再展示笔记主题入口；
- 单篇笔记不再展示外观覆盖入口；
- 旧 metadata/API 暂时保留用于数据库兼容，不作为新功能继续扩展；
- compatibility neutralizer 防止旧缓存的 noteTheme token 覆盖当前 App Appearance。

## Product Asset

```text
App Appearance Style Registry
+ Global Token Contract
+ Runtime Projector
+ Light/Dark Resolver
+ Visual Preview Cards
+ Legacy Utility Bridge
+ Persistence
+ Regression Tests
```
