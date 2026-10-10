# Note Template Contribution

V2.1 的 `contributes.noteTemplates` 是零代码静态资源。Host 校验模板大小、变量 Schema、文档类型和危险内容；插件本身不获得 `notes:write`。只有用户明确选择模板时，Host 才创建笔记。

运行时 ID 使用 `<pluginId>/<templateId>`。单插件最多 100 个模板，body 最大 256KiB。插件禁用/卸载后入口消失，但已经由用户创建的笔记保持普通 Nowen 笔记，不依赖插件继续存在。
