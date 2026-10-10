# Nowen Theme Pack

这是 Note Theme Contribution 的官方零代码示例。插件只在 `manifest.json` 中声明主题，
不包含 JavaScript、Node、WASM、CSS 或数据权限。

主题运行时 ID 由 Host 生成：`nowenlab.theme-pack/sepia` 与
`nowenlab.theme-pack/midnight`。用户选择会保存到笔记元数据；插件被禁用或卸载时 Host
回退到 Nowen 默认主题，但保留原 ID，重新启用同 ID 插件后自动恢复。
