# Prompt Pack Contribution

V2.1 的 `contributes.promptPacks` 只描述 Prompt、输入字段、最小上下文声明、输出模式和 UI 平台。Contribution 永远拿不到 AI Provider Secret，也不能主动读取笔记。Host 只在用户触发时按声明提供 title/note/selection/tags 等最小上下文。

单插件最多 100 个 Prompt，每个 Prompt 最大 64KiB。运行时 ID 使用 `<pluginId>/<promptId>`。
