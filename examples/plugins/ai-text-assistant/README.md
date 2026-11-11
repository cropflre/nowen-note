# AI 文本助手

官方编辑器动作示例（Contribution 合同 v5）。三个 AI 动作都是 Prompt Pack：
- 宿主用当前用户在 Nowen 中配置的 AI 模型执行，与写作助手相同。
- 插件代码拿不到选中的文字，也不需要任何 AI 或网络权限。

为了不打开 V2.1 声明式开关，这个包是一个可执行插件，带有一个本地动作「整理空白」。

| 动作 | 行为 |
| --- | --- |
| AI 润色 | 预览后替换（也可插入或复制） |
| AI 翻译为英文 | 预览后替换（也可插入或复制） |
| AI 总结要点 | 确认后在选区后插入要点列表 |
| 整理空白 | 本地合并多余的空格和空行，直接替换 |

未开启或未配置 AI 时，AI 动作会提示先去设置中配置，不会改动正文。

```sh
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
```

服务器需要设置 `NOWEN_EDITOR_ACTIONS=1`。说明见 [编辑器扩展动作](../../../docs/plugin-platform/editor-actions.md)。
