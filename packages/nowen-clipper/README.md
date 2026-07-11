# Nowen Note Web Clipper

Nowen Note 的 MV3 浏览器扩展，把 **速记、网页正文、当前选区、截图和完整页面** 保存到自己的 Nowen Note 实例。

## 主要能力

- **速记**：直接输入标题与 Markdown 正文，不需要先打开 Nowen 页面。
- **真实目标选择**：可选择个人空间、工作区和具体笔记本；只读工作区会在保存前提示。
- **按账号记住选择**：模式、空间、笔记本、图片策略、内容格式和置顶状态按“服务器 + 用户”隔离保存。
- **懒加载图片抓取**：识别 `src`、`srcset`、`data-src`、`data-original`、`data-lazy-src`、`<picture>/<source>`，并可在限定时间内逐段滚动触发视口外图片。
- **CSS 背景图兜底**：在限定数量和尺寸范围内，把正文区域的背景图临时转换为可剪藏图片，抽取后立即清理页面临时节点。
- **图片本地化**：远程图片下载为内联数据，后端自动转存到 Nowen 附件存储，正文不再依赖原网站。
- **失败不中断**：单张图片失败不会丢掉整篇笔记，结果页会列出失败资源与原因。
- **资源安全限制**：图片数量、单张大小、总大小、并发和超时均有硬限制；拒绝非 HTTP/HTTPS、localhost、私网 IP、常见内网域名和重定向请求。
- **标签与置顶**：保存后写入真实 Nowen 标签关系，并可自动置顶，而不是只把标签文本附在正文末尾。
- **AI 优化**：可选摘要、大纲、自动标签、标题优化、重点提取和翻译，复用主站 AI 配置。

## 快捷入口

- 点击扩展图标：打开统一采集面板。
- `Alt+Shift+S`：剪藏当前页面正文。
- `Alt+Shift+A`：剪藏当前选区。
- 页面右键菜单：正文、选区、完全克隆、截图等旧入口继续保留。

## 首次使用

1. 安装扩展后打开设置。
2. 填写 Nowen Note Server URL，例如 `https://note.example.com` 或 `http://localhost:3001`。
3. 使用 Nowen Note 用户名和密码登录；开启 2FA 的账号会进入验证码步骤。
4. 回到任意网页，点击扩展图标。
5. 选择采集模式、空间和笔记本后保存。

扩展不会保存主站 AI Provider 的 API Key。登录 Token 和基础配置使用扩展存储；最近目标位置使用本地存储，并按账号隔离。

## 图片抓取边界

设置页可调整：

- 是否主动滚动触发懒加载；
- 单次最多处理图片数量；
- 单张图片大小上限；
- 全部图片总量上限；
- 单张图片下载超时。

浏览器扩展无法像服务器 DNS 解析器一样完全确认域名最终解析地址，因此安全策略采用保守组合：拦截显式内网地址和常见内网域名，并禁止自动跟随重定向。生产环境仍建议使用受控代理或后端抓取服务进一步实施 DNS 解析后的 SSRF 校验。

## 开发

```bash
cd packages/nowen-clipper
npm install
npm run lint
npm run build
```

构建产物位于 `dist/`。在 Chrome / Edge 的扩展管理页开启开发者模式后，选择“加载已解压的扩展程序”。

## 目录结构

```text
src/
  background/
    index.ts         旧右键、快捷键、截图与兼容流水线
    enhanced.ts      统一速记/正文/选区流水线
  content/           Readability、选区和完整页面抽取
  popup/             统一采集面板
  options/           登录、默认行为和资源安全限制
  lib/
    api.ts            Nowen API 调用
    extractor.ts      页面抽取与懒加载 URL 归一化
    image-localizer.ts 图片下载、去重、预算和 SSRF 防护
    protocol.ts       扩展消息协议
    storage.ts        全局配置与账号级最近选择
    transform.ts      HTML / Markdown 转换
```

## 打包

```bash
npm run pack:chrome
npm run pack:edge
npm run pack:firefox
# 或
npm run pack:all
```

发布压缩包位于 `releases/`。
