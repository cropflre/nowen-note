# Text Tools 文本工具箱

第三方风格的编辑器动作示例（Contribution 合同 v5）。插件不申请任何权限，也不联网；所有动作都是纯函数，只处理宿主传入的选中文字，并返回 Markdown 文本。

| 动作 | 位置 | 行为 |
| --- | --- | --- |
| 用引号包围 | 选区、工具栏 | 直接替换选区 |
| 转为大写 | 选区 | 直接替换，链接地址和行内代码保持不变 |
| 行转列表 | 选区、工具栏 | 先预览，确认后替换 |
| 统计字数 | 选区 | 只显示提示，不修改正文 |
| 会议纪要模板 | 斜杠菜单（输入 `/meeting` 或 `/会议`）、工具栏 | 在光标处插入 |

同一个插件包可以在富文本和 Markdown 两种编辑器中使用，宿主代码中没有针对它的特殊分支。

```sh
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
```

服务器需要设置 `NOWEN_EDITOR_ACTIONS=1`。管理员在「我的插件」上传生成的 `.nowen-plugin`，然后启用。说明见 [编辑器扩展动作](../../../docs/plugin-platform/editor-actions.md)。
