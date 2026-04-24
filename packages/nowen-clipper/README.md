# Nowen Note Web Clipper

一个基于 MV3 的浏览器扩展，可以把当前网页的正文、图片、链接一键剪藏到你的 **nowen-note** 实例。

## 特性

- 两种抽取模式：**正文**（Readability）与 **选区**（用户手动选中的内容）
- 图片可本地下载为 base64 与笔记一起提交，后端会自动抽到 `attachments`；也可以保留原 URL 或忽略
- 自动把 HTML 转 Markdown（默认）或保留为 HTML
- 自动按"笔记本 + 标签"归类（笔记本路径不存在会自动创建）
- 使用 **nowen-note API Token** 鉴权，非登录 JWT，不会 30 天过期
- 右键菜单 + 弹窗 + 快捷键三种入口
  - `Alt+Shift+S`：剪藏整页
  - `Alt+Shift+A`：剪藏选区

## 前置条件

你需要先在 nowen-note 里生成一个 API Token：

1. 登录网页端 → 账号设置 → **API Token** → **新建 Token**
2. 勾选需要的 scope（剪藏插件只需要 `notes:write` 或不填即全权）
3. 复制明文 token（以 `nkn_` 开头），只会显示一次

## 开发

```bash
cd packages/nowen-clipper
npm install
npm run build   # 产物位于 dist/
```

然后在 Chrome / Edge 打开 `chrome://extensions`，打开"开发者模式"，
点击"加载已解压的扩展程序"，选择 `packages/nowen-clipper/dist`。

## 首次使用

1. 装好扩展后点击工具栏上的 Nowen 图标 → 弹出"未配置"提示 → 打开设置
2. 填 **Server URL**（例：`https://note.example.com` 或 `http://localhost:3001`）
3. 填 **API Token**
4. 点"测试连接"，看到 ✅ 即可
5. 回到任意网页，打开扩展弹窗 → 选"正文" / "选区" → 剪藏

## 目录结构

```
src/
  background/   MV3 service worker：右键菜单、快捷键、剪藏流水线
  content/      content script：响应抽取请求（Readability / 选区）
  popup/        弹窗 UI
  options/      选项页
  lib/
    api.ts          与 nowen-note 后端的 HTTP 调用
    extractor.ts    抽取 article / selection 为结构化 HTML
    transform.ts    HTML ↔ Markdown + 图片下载内联
    storage.ts      chrome.storage 封装
    protocol.ts     进程间消息协议类型
```

## 打包分发

```bash
npm run pack
# 产出 releases/nowen-clipper-<version>.zip
```

直接把这个 zip 上传 Chrome Web Store / Edge Add-ons / Firefox AMO。

## 常见问题

**Q: 某些站点剪藏不了，提示"无法运行"？**
A: 浏览器禁止在 `chrome://`、`edge://`、扩展商店等特权页面运行扩展脚本，属预期行为。

**Q: 剪藏后图片显示不了？**
A: 可能是站点做了热链接保护（Referer 校验）。扩展选项里切到 "保留原始链接" 模式会保留 `<img src>`，前端打开笔记时浏览器自带的 Referer 策略有时能绕过；如果仍不行，用 "下载并内联" 模式会把图片直接保存进笔记（推荐）。

**Q: Token 失效了怎么办？**
A: 去 nowen-note 账号设置里吊销旧的、生成新的，填回扩展选项。
