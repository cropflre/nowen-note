# 剪藏精读

在富文本或 Markdown 笔记里选中一段资料，打开选区工具栏中的扩展动作菜单，点击「生成摘录卡」。预览后点击「插入到正文」，卡片会插在选区所在段落之后，原文保留。也可以从预览复制，或取消后继续编辑。

卡片保留选区里的 Markdown 链接。需要自动填出处时，请将剪藏的「📎 来源：…」或类似的来源行一起选中，放在选区末尾。没有选中来源行时，卡片显示「出处：待补充」。插入后可以补写出处和「我的理解」。

插件仅处理宿主传入的选区文本，权限清单为空，无外部网络请求。

## 安装试用

在 Nowen Note 1.6.0 测试环境中，为宿主后端设置 `NOWEN_EDITOR_ACTIONS=1` 并重启。由管理员在「应用 → 我的插件」上传 `.nowen-plugin` 并启用。请用 Web 或桌面完整版打开普通可编辑笔记。在 Markdown 笔记中，请选中正文段落进行试用。

## 打包

从仓库根目录运行以下命令。

```sh
npm ci --prefix packages/nowen-plugin-cli
cd examples/plugins/clipper-deep-reading
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs doctor
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
```

生成的插件包位于当前目录下的 `dist/`。
