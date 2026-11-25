# 傻瓜式 AI 开发 Nowen Note 插件指南

不会写代码，或者不想啃完整规范？你只需要**复制一份提示词给任意 AI**（DeepSeek、ChatGPT、Claude、豆包、Cursor 等），把最底部的「我的插件需求」改成你想做的功能，AI 就会直接帮你生成全部文件与一键打包命令，**5 分钟做出属于自己的 `.nowen-plugin` 插件**。

> 提示：你也可以直接在 Nowen Note 的 **「扩展中心 → 开发指南」** 中输入需求，点击 **「一键复制 AI 开发提示词」**。

---

## 一、三步傻瓜式流程

1. **复制提示词给 AI**：复制下方「万能 AI 提示词模板」，把最底部的【需求占位符】替换成你自己的想法，发给任意大模型。
2. **保存文件并一键打包**：按 AI 输出把文件（如 `manifest.json`、`index.js` 或 `ui/`）保存到同一个文件夹，运行 AI 给的一键打包命令，得到 `xxx.nowen-plugin` 文件。
3. **拖进扩展中心安装**：打开 Nowen Note → **「应用 / 扩展中心」** → 直接把 `.nowen-plugin` 拖入页面（或点击顶部「上传插件包」）→ 管理员确认权限并启用即可。

---

## 二、常见需求怎么写（直接抄作业）

把下面任意一句填进提示词最底部，都能直接生成可用插件：

- **编辑器文字工具**：「选中几行文字后，一键转换成 Markdown 待办清单（`- [ ]`），并去掉每行多余空格」
- **AI 写作助手（免代码）**：「做一个 AI 润色和翻译插件：选中文字可一键“改成周报语气”或“翻译成地道英文”，预览后再替换」
- **阅读主题包（免代码）**：「做一个护眼墨绿纸张阅读主题，浅色和深色模式都要舒服不刺眼」
- **工作台小应用（V3）**：「在扩展中心和工作台做一个极简番茄钟，支持 25 分钟倒计时和本地保存今日完成次数」
- **快捷模板插入**：「在编辑器输入 `/` 或点工具栏，一键插入我的“每周复盘模板”（本周成果、问题、下周计划）」

---

## 三、万能 AI 插件开发提示词模板（整段复制）

````markdown
# Nowen Note 插件傻瓜式开发提示词

你是一名精通 Nowen Note 插件平台的资深工程师。请严格按照下方官方规范，为我生成一套**零额外依赖、可直接打包上传**的 `.nowen-plugin` 插件完整文件与一键打包命令。

## 一、请根据我的需求自动选择最简单、权限最小的插件类型

1. **编辑器文字处理 / 模板插入（推荐优先，最稳）**
   - `apiVersion: 2`，`runtime: "sandbox-js"`，`main: "index.js"`，`permissions: []`
   - 运行在 QuickJS 沙箱：**没有** Node / DOM / `window` / `fetch`。
   - `index.js` 必须使用纯 JS 并挂载到 `globalThis.__nowenPluginModule`：
     ```js
     globalThis.__nowenPluginModule = {
       actions: {
         "my-action": ({ input }) => ({ text: "处理后的 Markdown 文本" }), // 或 { message: "仅提示不改正文" }
       },
     };
     ```
   - `manifest.json` 中同时声明 `actions`、`contributes.commands` 与 `contributes.editorActions`：
     - `placements` 可选：`["editor.selection", "editor.toolbar.actions", "editor.slash"]`
     - `appliesTo`：`["tiptap", "markdown"]`
     - `selectionMode`：`"text"`（必须选中文本）| `"optional-text"` | `"none"`（光标处插入）
     - `resultMode`：`"replace-selection"` | `"insert"` | `"open-preview"` | `"none"`
2. **AI 快捷提示词工具（免代码，直接调用用户已配置的 AI）**
   - `apiVersion: 2`，`runtime: "declarative"`，`permissions: []`
   - 在 `contributes.promptPacks` 声明提示词，在 `contributes.editorActions` 用 `"prompt": "<promptId>"` 关联，无需写 `index.js`。
3. **阅读主题 / 笔记模板包（纯声明式免代码）**
   - `apiVersion: 2`，`runtime: "declarative"`，`permissions: []`
   - 使用 `contributes.noteThemes`（含 `modes.light` / `modes.dark`）即可，无需写代码。
4. **独立页面小应用 / 工作台卡片（V3 应用）**
   - `apiVersion: 3`，`runtime: "declarative"`，常用权限 `["plugin-storage:read", "plugin-storage:write"]`
   - 静态资源放在 `ui/`（如 `ui/index.html`、`ui/app.js`、`ui/style.css`），并在 `contributes.uiAssets` 填写每个文件的 `"sha256:<64位小写hex>"`。
   - 界面在隔离 iframe 中通过 `window.NowenApp` 与宿主通信：
     - `await window.NowenApp.ready`
     - `await window.NowenApp.call("storage.get", { key })` / `call("storage.set", { key, value })`
     - `await window.NowenApp.call("context.get")` / `window.NowenApp.on("theme.changed", fn)`

## 二、Manifest 硬性规范（务必遵守，否则导入校验会报错）
- 包根目录必须直接包含 `manifest.json`（不要多套一层外层文件夹！）。
- 必填字段：`id`（如 `myname.my-plugin`，仅小写字母/数字/点/短横线）、`name`、`description`、`version`（如 `1.0.0`）、`apiVersion`（`2` 或 `3`）、`publisher`、`engines: { "nowen": ">=1.6.0 <2.0.0" }`、`runtime`、`permissions`。
- 仅允许使用以下权限名（遵循最小权限原则，不需要就填 `[]`）：
  `notes:read`, `notes:write`, `notebooks:read`, `notebooks:write`, `tags:read`, `tags:write`, `tasks:read`, `tasks:write`, `attachments:read`, `attachments:write`, `diary:read`, `diary:write`, `mindmaps:read`, `mindmaps:write`, `plugin-storage:read`, `plugin-storage:write`, `external:fetch`, `secrets:use`。
- **不要**要求在插件目录执行 `npm install` 或引入第三方 npm 依赖，请直接输出自包含的纯 JS / HTML / CSS 文件。

## 三、请你输出的内容
1. **每个文件的完整代码**（可直接复制保存，不要省略或用 `...` 代替）。
2. **一键打包成 `.nowen-plugin` 的命令**（同时给出 macOS/Linux 终端命令和 Windows PowerShell 命令；若为 V3 应用请附带自动计算 `uiAssets` SHA-256 并打包的 Node.js 脚本，确保直接跑通）。
3. **简要使用步骤**：把生成的 `.nowen-plugin` 文件拖进 Nowen Note 扩展中心页面 → 确认权限并启用 → 在哪里触发使用。

---
## 我的插件需求（请根据下面描述开发）
【在这里写下你想做的插件功能】
````

---

## 四、手动打包 `.nowen-plugin` 速查（无需安装任何工具）

`.nowen-plugin` 本质上是一个 **根目录直接包含 `manifest.json` 的 ZIP 压缩包**：

### macOS / Linux
进入你的插件文件夹（确认 `ls` 能直接看到 `manifest.json`），执行：
```bash
zip -r my-plugin-1.0.0.nowen-plugin manifest.json index.js
# 若包含 ui/ 目录（V3 应用）：
zip -r my-plugin-1.0.0.nowen-plugin manifest.json ui/
```

### Windows（PowerShell）
进入插件文件夹，执行：
```powershell
Compress-Archive -Path manifest.json, index.js -DestinationPath my-plugin-1.0.0.zip -Force
Rename-Item my-plugin-1.0.0.zip my-plugin-1.0.0.nowen-plugin
```

### 使用官方 CLI（适合需要 TypeScript 构建与本地沙箱测试的开发者）
```bash
npm create nowen-plugin
cd my-plugin && npm install
npx nowen-plugin validate && npx nowen-plugin build && npx nowen-plugin pack
```

---

## 五、常见报错排查

| 提示 / 现象 | 原因与解决方法 |
| --- | --- |
| 上传提示找不到 `manifest.json` | 压缩时多套了一层外层文件夹。请**进入文件夹内部**全选 `manifest.json` 等文件再压缩，不要右键压缩整个外层文件夹。 |
| 编辑器里看不到新增的选区动作 | 需确认：① 插件已在扩展中心「启用」；② 服务器环境变量已开启 `NOWEN_EDITOR_ACTIONS=1`。 |
| V3 应用提示 `uiAssets` 校验失败 | 修改 `ui/` 下的 HTML/JS/CSS 后需要重新计算对应文件的 SHA-256 并更新 `manifest.json` 的 `contributes.uiAssets`。 |
| 沙箱代码报错 `fetch is not defined` | QuickJS 沙箱禁用浏览器 `fetch`。如需请求外部接口，请声明 `external:fetch` 与 `permissionConfig.externalFetchHosts`，改用宿主提供的 `external.fetch`。 |

更多深度架构与 API 细节，请查阅 [插件作者指南（v1.6）](./plugin-author-guide-v16.md) 与 [官网使用教程](https://nowen.cn/#/note/tutorials)。
