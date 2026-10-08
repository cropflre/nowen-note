# HTML 代码块运行预览（#749 第 10 项）

Markdown 和富文本的 HTML 代码块工具栏提供 **运行 HTML** 按钮。Markdown 使用 `html` / `htm` 围栏，富文本将代码块语言选择为 HTML。点击按钮后打开隔离预览，支持 HTML 片段、完整 HTML 页面、内联 CSS、`<script>` 和 `onclick` 等交互。

````markdown
```html
<style>button { padding: 12px; color: royalblue; }</style>
<button onclick="this.textContent = '运行成功'">点击测试</button>
<script>document.body.style.background = '#f0f4ff';</script>
```
````

预览只在主动点击后运行，阅读笔记不会自动执行代码。**重新运行** 使用当前代码块源码并创建新的 iframe，重置页面状态。**关闭预览** 或 Esc 关闭弹窗并销毁 iframe；预览不修改笔记内容，已能查看正文的只读笔记也可运行。

## 隔离边界与限制

- 使用 `iframe srcdoc`，只设置 `sandbox="allow-scripts"`，不开放同源、弹窗、下载、表单提交或顶层导航权限。代码不能访问父页面 DOM、应用存储或 Electron API。
- 在用户源码之前注入 CSP：允许内联脚本和样式，允许 data/blob 图片及 data 字体；禁止 fetch/WebSocket、外部脚本/样式、嵌套 iframe、插件、base URL 和表单提交。CDN 库、远程图片和附件 URL 不会加载，请使用内联资源。
- CSP 限制资源加载，并不保证阻止 iframe 自身的所有导航。请只运行信任的代码；无限循环仍可能占用浏览器资源，关闭预览也不是 CPU/内存配额机制。
- 此功能独立于 HTML 笔记的 `HtmlPreviewPane`，后者继续清理脚本并提供只读预览。

## 实现与回归

两个编辑器共用 `HtmlCodeBlockRunButton`，通过 `htmlPlayground.ts` 生成文档。源码按运行次数快照保存，编辑代码不会自动执行；运行状态不持久化、不参与同步。原生 dialog 提供模态焦点管理，预览适配移动端视口。

专项测试覆盖语言别名、显式启动、脚本保留、隔离属性、重新运行最新源码、关闭销毁、语言切换和只读富文本。测试纳入 `Issue 749 Editor UX CI`；实际脚本执行和浏览器隔离另用 Chromium 验证。
